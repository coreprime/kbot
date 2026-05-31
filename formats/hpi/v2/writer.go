package v2

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/coreprime/kbot/formats/hpi/common"
)

// fileDataStart is the absolute offset at which the file-data section begins:
// the 8-byte marker+version prologue followed by the 24-byte v2 header.
const fileDataStart = 8 + headerV2Size

// WriterEntry holds a file's metadata and payload for writing into an archive.
type WriterEntry struct {
	Path string
	Data []byte
}

// Writer builds a TA: Kingdoms (v2) HPI archive. Unlike v1 there is no XOR
// cipher; each file is stored either raw or as a single zlib-compressed SQSH
// chunk, and the directory and name blocks are written uncompressed.
type Writer struct {
	file              *os.File
	entries           []WriterEntry
	CompressionLevel  int   // zlib level (0–9); 0 means default
	CompressionMethod uint8 // common.CompressionNone or common.CompressionZLib (default)
}

// CreateWriter creates a new v2 HPI archive at the given path, defaulting to
// zlib compression.
func CreateWriter(path string) (*Writer, error) {
	file, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	return &Writer{
		file:              file,
		CompressionMethod: common.CompressionZLib,
	}, nil
}

// AddFile reads a file from disk and adds it to the archive.
func (w *Writer) AddFile(archivePath, filePath string) error {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("reading %s: %w", filePath, err)
	}
	return w.AddFileFromBytes(archivePath, data)
}

// AddFileFromBytes adds a file from an in-memory byte slice.
func (w *Writer) AddFileFromBytes(archivePath string, data []byte) error {
	w.entries = append(w.entries, WriterEntry{
		Path: filepath.ToSlash(archivePath),
		Data: append([]byte(nil), data...),
	})
	return nil
}

// AddDirectory recursively adds every file under dirPath, rooted at
// archivePath inside the archive.
func (w *Writer) AddDirectory(archivePath, dirPath string) error {
	return filepath.Walk(dirPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dirPath, path)
		if err != nil {
			return err
		}
		ap := filepath.ToSlash(rel)
		if archivePath != "" {
			ap = archivePath + "/" + ap
		}
		return w.AddFile(ap, path)
	})
}

// Close finalises the archive and closes the underlying file.
func (w *Writer) Close() error {
	if err := w.writeArchive(); err != nil {
		_ = w.file.Close()
		return err
	}
	return w.file.Close()
}

// ---------------------------------------------------------------------------
// internal: directory tree used during serialization
// ---------------------------------------------------------------------------

type dirNode struct {
	name    string
	subdirs []*dirNode
	files   []*fileNode

	// assigned during layout
	recordOff   int
	firstSubDir int
	firstFile   int
}

type fileNode struct {
	name       string
	entryIndex int

	// assigned during file-data layout
	start      uint32
	decompSize uint32
	compSize   uint32 // includes the 19-byte SQSH header; 0 when stored raw
}

func (d *dirNode) findOrCreateChild(name string) *dirNode {
	for _, c := range d.subdirs {
		if c.name == name {
			return c
		}
	}
	child := &dirNode{name: name}
	d.subdirs = append(d.subdirs, child)
	return child
}

func buildTree(entries []WriterEntry) *dirNode {
	root := &dirNode{}
	for i, e := range entries {
		parts := strings.Split(e.Path, "/")
		cur := root
		for _, p := range parts[:len(parts)-1] {
			cur = cur.findOrCreateChild(p)
		}
		cur.files = append(cur.files, &fileNode{name: parts[len(parts)-1], entryIndex: i})
	}
	return root
}

// layoutDir assigns directory-block offsets. Each node's own 20-byte record
// sits at recordOff; its child directory records form a contiguous array at
// firstSubDir and its file records a contiguous array at firstFile. The cursor
// tracks the next free byte in the directory block.
func layoutDir(node *dirNode, recordOff int, cursor *int) {
	node.recordOff = recordOff
	node.firstSubDir = *cursor
	*cursor += len(node.subdirs) * dirV2Size
	node.firstFile = *cursor
	*cursor += len(node.files) * entryV2Size
	for i, sub := range node.subdirs {
		layoutDir(sub, node.firstSubDir+i*dirV2Size, cursor)
	}
}

// serializeDir writes a directory node and its file records into buf, then
// recurses into subdirectories (whose records live in this node's subdir array).
func serializeDir(buf []byte, node *dirNode, nameOffsets map[string]int) {
	off := node.recordOff
	binary.LittleEndian.PutUint32(buf[off:], uint32(nameOffsets[node.name]))
	binary.LittleEndian.PutUint32(buf[off+4:], uint32(node.firstSubDir))
	binary.LittleEndian.PutUint32(buf[off+8:], uint32(len(node.subdirs)))
	binary.LittleEndian.PutUint32(buf[off+12:], uint32(node.firstFile))
	binary.LittleEndian.PutUint32(buf[off+16:], uint32(len(node.files)))

	for i, f := range node.files {
		foff := node.firstFile + i*entryV2Size
		binary.LittleEndian.PutUint32(buf[foff:], uint32(nameOffsets[f.name]))
		binary.LittleEndian.PutUint32(buf[foff+4:], f.start)
		binary.LittleEndian.PutUint32(buf[foff+8:], f.decompSize)
		binary.LittleEndian.PutUint32(buf[foff+12:], f.compSize)
		binary.LittleEndian.PutUint32(buf[foff+16:], 0) // Date
		binary.LittleEndian.PutUint32(buf[foff+20:], 0) // Checksum
	}

	for _, sub := range node.subdirs {
		serializeDir(buf, sub, nameOffsets)
	}
}

// buildNameBlock collects every directory and file name into a single block of
// null-terminated strings, returning the block and a name→offset map. The block
// opens with a lone null byte so the unnamed root resolves to the empty string.
func buildNameBlock(root *dirNode) ([]byte, map[string]int) {
	offsets := map[string]int{"": 0}
	buf := []byte{0}
	var collect func(d *dirNode)
	add := func(name string) {
		if _, ok := offsets[name]; ok {
			return
		}
		offsets[name] = len(buf)
		buf = append(buf, name...)
		buf = append(buf, 0)
	}
	collect = func(d *dirNode) {
		for _, sub := range d.subdirs {
			add(sub.name)
		}
		for _, f := range d.files {
			add(f.name)
		}
		for _, sub := range d.subdirs {
			collect(sub)
		}
	}
	collect(root)
	return buf, offsets
}

// buildBlob compresses (or stores raw) a single file's payload and returns the
// bytes to write plus the decompressed and stored sizes. A compSize of 0
// signals an uncompressed payload to the reader.
func (w *Writer) buildBlob(data []byte) (blob []byte, decompSize, compSize uint32) {
	if len(data) == 0 || w.CompressionMethod == common.CompressionNone {
		return data, uint32(len(data)), 0
	}

	level := w.CompressionLevel
	if level <= 0 {
		level = zlib.DefaultCompression
	}
	var zbuf bytes.Buffer
	zw, _ := zlib.NewWriterLevel(&zbuf, level)
	_, _ = zw.Write(data)
	_ = zw.Close()
	compressed := zbuf.Bytes()

	chunk := make([]byte, common.SQSHHeaderSize+len(compressed))
	binary.LittleEndian.PutUint32(chunk[0:], common.ChunkMarker)
	chunk[4] = 2 // version
	chunk[5] = common.CompressionZLib
	chunk[6] = 0 // payload is not run through the chunk transform
	binary.LittleEndian.PutUint32(chunk[7:], uint32(len(compressed)))
	binary.LittleEndian.PutUint32(chunk[11:], uint32(len(data)))
	binary.LittleEndian.PutUint32(chunk[15:], common.Checksum(compressed))
	copy(chunk[common.SQSHHeaderSize:], compressed)

	return chunk, uint32(len(data)), uint32(len(chunk))
}

// ---------------------------------------------------------------------------
// writeArchive lays out: marker+version | v2 header | FileData | DirBlock | NameBlock
// ---------------------------------------------------------------------------

func (w *Writer) writeArchive() error {
	tree := buildTree(w.entries)

	// Compress every file and assign data offsets.
	blobs := make([][]byte, len(w.entries))
	fileNodes := make([]*fileNode, len(w.entries))
	collectFileNodes(tree, fileNodes)

	offset := uint32(fileDataStart)
	for i := range w.entries {
		blob, decomp, comp := w.buildBlob(w.entries[i].Data)
		blobs[i] = blob
		fn := fileNodes[i]
		fn.start = offset
		fn.decompSize = decomp
		fn.compSize = comp
		offset += uint32(len(blob))
	}

	// Lay out and serialize the directory block.
	cursor := dirV2Size // reserve the root record at offset 0
	layoutDir(tree, 0, &cursor)
	dirBlockSize := cursor

	nameBlock, nameOffsets := buildNameBlock(tree)
	dirBlock := make([]byte, dirBlockSize)
	serializeDir(dirBlock, tree, nameOffsets)

	// Write marker + version.
	if _, err := w.file.Seek(0, 0); err != nil {
		return err
	}
	if err := binary.Write(w.file, binary.LittleEndian, uint32(common.HeaderMarker)); err != nil {
		return fmt.Errorf("writing marker: %w", err)
	}
	if err := binary.Write(w.file, binary.LittleEndian, common.VersionV2); err != nil {
		return fmt.Errorf("writing version: %w", err)
	}

	// Reserve the 24-byte v2 header; patched after the trailing blocks land.
	if _, err := w.file.Write(make([]byte, headerV2Size)); err != nil {
		return fmt.Errorf("reserving header: %w", err)
	}

	// File data.
	for i := range w.entries {
		if _, err := w.file.Write(blobs[i]); err != nil {
			return fmt.Errorf("writing file data for %s: %w", w.entries[i].Path, err)
		}
	}

	// Directory block, then name block.
	dirBlockOffset := offset
	if _, err := w.file.Write(dirBlock); err != nil {
		return fmt.Errorf("writing directory block: %w", err)
	}
	nameBlockOffset := dirBlockOffset + uint32(len(dirBlock))
	if _, err := w.file.Write(nameBlock); err != nil {
		return fmt.Errorf("writing name block: %w", err)
	}

	// Patch the v2 header now that block offsets are known.
	h := headerV2{
		DirectoryBlock: int32(dirBlockOffset),
		DirectorySize:  int32(len(dirBlock)),
		NameBlock:      int32(nameBlockOffset),
		NameSize:       int32(len(nameBlock)),
		Data:           0x20,
		Last78:         0,
	}
	if _, err := w.file.Seek(8, 0); err != nil {
		return err
	}
	if err := binary.Write(w.file, binary.LittleEndian, &h); err != nil {
		return fmt.Errorf("writing v2 header: %w", err)
	}
	return nil
}

// collectFileNodes maps each entry index back to its fileNode so file-data
// offsets can be recorded during the write pass.
func collectFileNodes(d *dirNode, out []*fileNode) {
	for _, f := range d.files {
		out[f.entryIndex] = f
	}
	for _, sub := range d.subdirs {
		collectFileNodes(sub, out)
	}
}
