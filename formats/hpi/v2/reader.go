// Package v2 reads TA: Kingdoms HPI archives (version 0x00020000). Unlike the
// Total Annihilation v1 format, the directory and name blocks live at arbitrary
// offsets near the tail of the file, each optionally wrapped in a single SQSH
// chunk, and file payloads are stored without the v1 XOR cipher.
package v2

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/coreprime/kbot/formats/hpi/common"
)

// v2-specific structure sizes (each field is a 32-bit little-endian int).
const (
	headerV2Size = 24 // DirectoryBlock, DirectorySize, NameBlock, NameSize, Data, Last78
	dirV2Size    = 20 // NamePtr, FirstSubDirectory, SubCount, FirstFile, FileCount
	entryV2Size  = 24 // NamePtr, Start, DecompressedSize, CompressedSize, Date, Checksum
)

// headerV2 mirrors the supplemental v2 header that follows the 8-byte
// marker+version prologue. All fields are 32-bit little-endian.
type headerV2 struct {
	DirectoryBlock int32
	DirectorySize  int32
	NameBlock      int32
	NameSize       int32
	Data           int32
	Last78         int32
}

// Reader reads a TA: Kingdoms (v2) HPI archive.
//
// A Reader is not safe for concurrent use: every read seeks the shared file
// handle, so callers serving an archive to multiple goroutines must serialize
// access.
type Reader struct {
	file     *os.File
	header   *common.Header
	root     *common.Entry
	fileSize int64
}

// Open opens a v2 HPI archive for reading.
func Open(path string) (*Reader, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	r := &Reader{file: file}
	if err := r.readHeader(); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err := r.readDirectory(); err != nil {
		_ = file.Close()
		return nil, err
	}
	return r, nil
}

// Version reports the on-disk HPI version (always VersionV2).
func (r *Reader) Version() uint32 { return common.VersionV2 }

// Close closes the underlying file.
func (r *Reader) Close() error {
	if r.file != nil {
		return r.file.Close()
	}
	return nil
}

// Header returns the archive header. Only Marker and Version are populated for
// v2 archives; the v1-style directory fields are zero.
func (r *Reader) Header() *common.Header { return r.header }

// Root returns the root directory entry.
func (r *Reader) Root() *common.Entry { return r.root }

// List returns the full paths of every file in the archive.
func (r *Reader) List() []string {
	var files []string
	if r.root != nil {
		_ = r.root.Walk(func(e *common.Entry) error {
			if !e.IsDir {
				files = append(files, e.FullPath())
			}
			return nil
		})
	}
	return files
}

// Walk traverses every entry in the archive.
func (r *Reader) Walk(fn func(*common.Entry) error) error {
	if r.root == nil {
		return nil
	}
	return r.root.Walk(fn)
}

// Find locates an entry by path.
func (r *Reader) Find(path string) *common.Entry {
	if r.root == nil {
		return nil
	}
	return r.root.Find(path)
}

// Open opens a file from the archive by path.
func (r *Reader) Open(path string) (io.ReadCloser, error) {
	entry := r.Find(path)
	if entry == nil {
		return nil, fmt.Errorf("file not found: %s", path)
	}
	return r.OpenEntry(entry)
}

// OpenEntry opens a file entry for reading.
func (r *Reader) OpenEntry(entry *common.Entry) (io.ReadCloser, error) {
	if entry.IsDir {
		return nil, errors.New("cannot open directory")
	}
	data, err := r.extractFile(entry)
	if err != nil {
		return nil, err
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (r *Reader) readHeader() error {
	info, err := r.file.Stat()
	if err != nil {
		return err
	}
	r.fileSize = info.Size()

	if _, err := r.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	var marker, version uint32
	if err := binary.Read(r.file, binary.LittleEndian, &marker); err != nil {
		return err
	}
	if err := binary.Read(r.file, binary.LittleEndian, &version); err != nil {
		return err
	}
	if marker != common.HeaderMarker {
		return fmt.Errorf("invalid HPI marker: 0x%X", marker)
	}
	if version != common.VersionV2 {
		return fmt.Errorf("not a v2 HPI archive: version 0x%X", version)
	}
	r.header = &common.Header{Marker: marker, Version: version}
	return nil
}

// readDirectory reads the TA: Kingdoms style directory tree.
func (r *Reader) readDirectory() error {
	if _, err := r.file.Seek(8, io.SeekStart); err != nil {
		return err
	}
	var h headerV2
	if err := binary.Read(r.file, binary.LittleEndian, &h); err != nil {
		return fmt.Errorf("read v2 header: %w", err)
	}

	dirBuf, err := r.readMaybeCompressedBlock(int64(h.DirectoryBlock), int(h.DirectorySize))
	if err != nil {
		return fmt.Errorf("read directory block: %w", err)
	}
	nameBuf, err := r.readMaybeCompressedBlock(int64(h.NameBlock), int(h.NameSize))
	if err != nil {
		return fmt.Errorf("read name block: %w", err)
	}

	children, err := parseDirChildren(dirBuf, nameBuf, 0)
	if err != nil {
		return err
	}
	r.root = &common.Entry{IsDir: true, Children: children}
	for _, c := range children {
		c.Parent = r.root
	}
	return nil
}

// parseDirChildren parses a directory record at dirOffset and returns its
// subdirectory and file children.
func parseDirChildren(dir, names []byte, dirOffset int) ([]*common.Entry, error) {
	if dirOffset < 0 || dirOffset+dirV2Size > len(dir) {
		return nil, fmt.Errorf("v2 directory offset %d out of range (len=%d)", dirOffset, len(dir))
	}
	firstSubDir := int32(binary.LittleEndian.Uint32(dir[dirOffset+4:]))
	subCount := int32(binary.LittleEndian.Uint32(dir[dirOffset+8:]))
	firstFile := int32(binary.LittleEndian.Uint32(dir[dirOffset+12:]))
	fileCount := int32(binary.LittleEndian.Uint32(dir[dirOffset+16:]))

	var children []*common.Entry
	for i := int32(0); i < subCount; i++ {
		off := int(firstSubDir) + int(i)*dirV2Size
		entry, err := parseDir(dir, names, off)
		if err != nil {
			return nil, err
		}
		children = append(children, entry)
	}
	for i := int32(0); i < fileCount; i++ {
		off := int(firstFile) + int(i)*entryV2Size
		entry, err := parseFile(dir, names, off)
		if err != nil {
			return nil, err
		}
		children = append(children, entry)
	}
	return children, nil
}

func parseDir(dir, names []byte, off int) (*common.Entry, error) {
	if off < 0 || off+dirV2Size > len(dir) {
		return nil, fmt.Errorf("v2 subdir offset %d out of range (len=%d)", off, len(dir))
	}
	namePtr := int32(binary.LittleEndian.Uint32(dir[off:]))
	name, err := readName(names, int(namePtr))
	if err != nil {
		return nil, fmt.Errorf("read subdir name: %w", err)
	}
	entry := &common.Entry{Name: name, IsDir: true}
	kids, err := parseDirChildren(dir, names, off)
	if err != nil {
		return nil, err
	}
	entry.Children = kids
	for _, c := range kids {
		c.Parent = entry
	}
	return entry, nil
}

func parseFile(dir, names []byte, off int) (*common.Entry, error) {
	if off < 0 || off+entryV2Size > len(dir) {
		return nil, fmt.Errorf("v2 file offset %d out of range (len=%d)", off, len(dir))
	}
	namePtr := int32(binary.LittleEndian.Uint32(dir[off:]))
	start := int32(binary.LittleEndian.Uint32(dir[off+4:]))
	decompressed := int32(binary.LittleEndian.Uint32(dir[off+8:]))
	compressed := int32(binary.LittleEndian.Uint32(dir[off+12:]))
	// Bytes 16-23 are Date and Checksum; not needed for read-only access.

	name, err := readName(names, int(namePtr))
	if err != nil {
		return nil, fmt.Errorf("read file name: %w", err)
	}
	if start < 0 || decompressed < 0 || compressed < 0 {
		return nil, fmt.Errorf("v2 file %q has negative size/offset (start=%d, decomp=%d, comp=%d)", name, start, decompressed, compressed)
	}
	return &common.Entry{
		Name:           name,
		IsDir:          false,
		Offset:         uint32(start),
		Size:           uint32(decompressed),
		CompressedSize: uint32(compressed),
	}, nil
}

func readName(names []byte, offset int) (string, error) {
	if offset < 0 || offset >= len(names) {
		return "", fmt.Errorf("name offset %d out of range (len=%d)", offset, len(names))
	}
	end := bytes.IndexByte(names[offset:], 0)
	if end < 0 {
		return "", errors.New("name missing null terminator")
	}
	return string(names[offset : offset+end]), nil
}

// readMaybeCompressedBlock reads size bytes at offset. If the buffer starts with
// the SQSH chunk marker, it is decompressed in-line and the decompressed bytes
// are returned instead.
func (r *Reader) readMaybeCompressedBlock(offset int64, size int) ([]byte, error) {
	if size < 0 {
		return nil, fmt.Errorf("negative block size %d", size)
	}
	if int64(size) > r.fileSize {
		return nil, fmt.Errorf("block size %d exceeds file size %d", size, r.fileSize)
	}
	if _, err := r.file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r.file, buf); err != nil {
		return nil, err
	}
	if size >= 4 && binary.LittleEndian.Uint32(buf[:4]) == common.ChunkMarker {
		return common.DecodeChunk(buf)
	}
	return buf, nil
}

// extractFile returns the (possibly decompressed) bytes of a v2 file entry.
func (r *Reader) extractFile(entry *common.Entry) ([]byte, error) {
	if _, err := r.file.Seek(int64(entry.Offset), io.SeekStart); err != nil {
		return nil, err
	}
	if entry.CompressedSize == 0 {
		// Uncompressed payload read straight from disk; its length cannot exceed
		// the file itself.
		if int64(entry.Size) > r.fileSize {
			return nil, fmt.Errorf("file size %d exceeds archive size %d", entry.Size, r.fileSize)
		}
		buf := make([]byte, entry.Size)
		if _, err := io.ReadFull(r.file, buf); err != nil {
			return nil, err
		}
		return buf, nil
	}
	if int64(entry.CompressedSize) > r.fileSize {
		return nil, fmt.Errorf("compressed size %d exceeds archive size %d", entry.CompressedSize, r.fileSize)
	}
	chunk := make([]byte, entry.CompressedSize)
	if _, err := io.ReadFull(r.file, chunk); err != nil {
		return nil, err
	}
	return common.DecodeChunk(chunk)
}
