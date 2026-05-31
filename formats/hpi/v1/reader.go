// Package v1 reads and writes Total Annihilation HPI archives (version
// 0x00010000). The directory tree and every file payload are scrambled with
// HPI's position-dependent XOR cipher and stored as multi-chunk SQSH streams.
package v1

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/coreprime/kbot/formats/hpi/common"
)

// Reader reads a Total Annihilation (v1) HPI archive.
//
// A Reader is not safe for concurrent use: every read seeks the shared file
// handle, so callers serving an archive to multiple goroutines must serialize
// access.
type Reader struct {
	file       *os.File
	header     *common.Header
	root       *common.Entry
	decryptKey uint8
	fileSize   int64
}

// Open opens a v1 HPI archive for reading.
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

// Version reports the on-disk HPI version (always VersionV1).
func (r *Reader) Version() uint32 { return common.VersionV1 }

// Close closes the underlying file.
func (r *Reader) Close() error {
	if r.file != nil {
		return r.file.Close()
	}
	return nil
}

// Header returns the archive header.
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

// ---------------------------------------------------------------------------
// encrypted read helpers
// ---------------------------------------------------------------------------

func (r *Reader) readDecryptBytes(size int) ([]byte, error) {
	if size < 0 {
		return nil, fmt.Errorf("negative read size %d", size)
	}
	// Every read length here derives from on-disk header/chunk fields. None can
	// legitimately exceed the file itself, so reject oversized requests before
	// allocating to avoid a corrupt archive triggering a huge allocation.
	if int64(size) > r.fileSize {
		return nil, fmt.Errorf("read size %d exceeds file size %d", size, r.fileSize)
	}
	seed := uint8(r.currentPosition())
	data := make([]byte, size)
	if _, err := io.ReadFull(r.file, data); err != nil {
		return nil, err
	}
	common.DecryptBuffer(r.decryptKey, seed, data)
	return data, nil
}

func (r *Reader) readDecryptUint32() (uint32, error) {
	data, err := r.readDecryptBytes(4)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(data), nil
}

func (r *Reader) currentPosition() int64 {
	pos, _ := r.file.Seek(0, io.SeekCurrent)
	return pos
}

// ---------------------------------------------------------------------------
// header + directory parsing
// ---------------------------------------------------------------------------

func (r *Reader) readHeader() error {
	info, err := r.file.Stat()
	if err != nil {
		return err
	}
	r.fileSize = info.Size()

	if _, err := r.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	header, err := common.ReadHeader(r.file)
	if err != nil {
		return err
	}
	if header.Version != common.VersionV1 {
		return fmt.Errorf("not a v1 HPI archive: version 0x%X", header.Version)
	}
	r.header = header
	headerKey := uint8(header.DecryptKey)
	r.decryptKey = (headerKey << 2) | (headerKey >> 6)
	return nil
}

func (r *Reader) readDirectory() error {
	dirStart := r.header.Offset
	if dirStart == 0 {
		dirStart = uint32(common.HeaderSize)
	}

	// DirectorySize and Offset come straight from the on-disk header; validate
	// them against the real file size before trusting them to size a buffer.
	if int64(r.header.DirectorySize) > r.fileSize {
		return fmt.Errorf("directory size %d exceeds file size %d", r.header.DirectorySize, r.fileSize)
	}
	if dirStart > r.header.DirectorySize {
		return fmt.Errorf("directory offset %d past directory end %d", dirStart, r.header.DirectorySize)
	}

	dirBuffer := make([]byte, r.header.DirectorySize)

	if _, err := r.file.Seek(int64(dirStart), io.SeekStart); err != nil {
		return err
	}

	readSize := r.header.DirectorySize - dirStart
	decryptedData, err := r.readDecryptBytes(int(readSize))
	if err != nil {
		return err
	}
	copy(dirBuffer[dirStart:], decryptedData)

	root, err := r.parsePathData(dirBuffer, int(dirStart))
	if err != nil {
		return err
	}
	r.root = &common.Entry{Name: "", IsDir: true, Children: root}
	for _, child := range root {
		child.Parent = r.root
	}
	return nil
}

func (r *Reader) parsePathData(buffer []byte, offset int) ([]*common.Entry, error) {
	if offset+8 > len(buffer) {
		return nil, errors.New("path data out of bounds")
	}

	numEntries := binary.LittleEndian.Uint32(buffer[offset:])
	entryListOffset := binary.LittleEndian.Uint32(buffer[offset+4:])

	var entries []*common.Entry
	for i := uint32(0); i < numEntries; i++ {
		entryOffset := int(entryListOffset) + int(i)*9
		if entryOffset+9 > len(buffer) {
			return nil, fmt.Errorf("entry %d out of bounds", i)
		}

		nameOffset := binary.LittleEndian.Uint32(buffer[entryOffset:])
		dataOffset := binary.LittleEndian.Uint32(buffer[entryOffset+4:])
		isDir := buffer[entryOffset+8]

		name, err := readNullTerminatedString(buffer, int(nameOffset))
		if err != nil {
			return nil, fmt.Errorf("failed to read entry name: %w", err)
		}

		entry := &common.Entry{Name: name, IsDir: isDir != 0}

		if isDir != 0 {
			children, err := r.parsePathData(buffer, int(dataOffset))
			if err != nil {
				return nil, err
			}
			entry.Children = children
			for _, child := range children {
				child.Parent = entry
			}
		} else {
			if int(dataOffset)+9 > len(buffer) {
				return nil, fmt.Errorf("file data out of bounds for %s", name)
			}
			entry.Offset = binary.LittleEndian.Uint32(buffer[dataOffset:])
			entry.Size = binary.LittleEndian.Uint32(buffer[dataOffset+4:])
			entry.CompType = buffer[dataOffset+8]
		}

		entries = append(entries, entry)
	}

	return entries, nil
}

func readNullTerminatedString(buffer []byte, offset int) (string, error) {
	if offset >= len(buffer) {
		return "", errors.New("string offset out of bounds")
	}

	end := offset
	maxLen := len(buffer) - offset
	if maxLen > 256 {
		maxLen = 256
	}

	for i := 0; i < maxLen; i++ {
		if buffer[offset+i] == 0 {
			end = offset + i
			break
		}
	}

	if end == offset && (offset >= len(buffer) || buffer[offset] != 0) {
		return "", errors.New("no null terminator found")
	}

	return string(buffer[offset:end]), nil
}

// ---------------------------------------------------------------------------
// file extraction
// ---------------------------------------------------------------------------

func (r *Reader) extractFile(entry *common.Entry) ([]byte, error) {
	switch entry.CompType {
	case common.CompressionNone:
		return r.extractUncompressed(entry)
	case common.CompressionLZ77, common.CompressionZLib:
		return r.extractCompressed(entry)
	default:
		return nil, fmt.Errorf("unknown compression type: %d", entry.CompType)
	}
}

func (r *Reader) extractUncompressed(entry *common.Entry) ([]byte, error) {
	if _, err := r.file.Seek(int64(entry.Offset), io.SeekStart); err != nil {
		return nil, err
	}
	return r.readDecryptBytes(int(entry.Size))
}

func (r *Reader) extractCompressed(entry *common.Entry) ([]byte, error) {
	numChunks := entry.Size / chunkMaxDecomp
	if entry.Size%chunkMaxDecomp != 0 {
		numChunks++
	}

	if _, err := r.file.Seek(int64(entry.Offset), io.SeekStart); err != nil {
		return nil, err
	}

	chunkSizes := make([]uint32, numChunks)
	for i := range chunkSizes {
		size, err := r.readDecryptUint32()
		if err != nil {
			return nil, err
		}
		chunkSizes[i] = size
	}

	// entry.Size is the decompressed length and can legitimately exceed the
	// archive size, so it cannot be bounded by fileSize. Cap only the initial
	// capacity hint; append grows the slice if the real output is larger.
	capHint := entry.Size
	if int64(capHint) > r.fileSize {
		capHint = uint32(r.fileSize)
	}
	output := make([]byte, 0, capHint)
	for i := uint32(0); i < numChunks; i++ {
		chunk, err := r.readChunk()
		if err != nil {
			return nil, fmt.Errorf("failed to read chunk %d: %w", i, err)
		}
		output = append(output, chunk...)
	}

	return output, nil
}

// readChunk reads and decrypts one SQSH chunk straight from the encrypted
// stream, then decodes it via the shared chunk decoder.
func (r *Reader) readChunk() ([]byte, error) {
	hdr, err := r.readDecryptBytes(common.SQSHHeaderSize)
	if err != nil {
		return nil, err
	}
	if binary.LittleEndian.Uint32(hdr[:4]) != common.ChunkMarker {
		return nil, fmt.Errorf("invalid chunk marker: 0x%X", binary.LittleEndian.Uint32(hdr[:4]))
	}
	compSize := binary.LittleEndian.Uint32(hdr[7:11])

	payload, err := r.readDecryptBytes(int(compSize))
	if err != nil {
		return nil, err
	}

	full := make([]byte, common.SQSHHeaderSize+len(payload))
	copy(full, hdr)
	copy(full[common.SQSHHeaderSize:], payload)
	return common.DecodeChunk(full)
}
