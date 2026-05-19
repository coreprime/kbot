package hpi

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Entry represents a file or directory in the HPI archive.
//
// For v1 archives, Size is the file's decompressed size and CompType selects
// the per-file compression scheme used by the multi-chunk file payload.
//
// For v2 archives (TA: Kingdoms), Size is the decompressed size and
// CompressedSize is the on-disk SQSH chunk size; CompressedSize == 0 means the
// payload is stored uncompressed.
type Entry struct {
	Name           string
	IsDir          bool
	Offset         uint32
	Size           uint32
	CompressedSize uint32
	CompType       uint8
	Children       []*Entry
	Parent         *Entry
}

// FullPath returns the full path of this entry
func (e *Entry) FullPath() string {
	if e.Parent == nil {
		return e.Name
	}
	parentPath := e.Parent.FullPath()
	if parentPath == "" {
		return e.Name
	}
	return filepath.Join(parentPath, e.Name)
}

// Find locates an entry by path
func (e *Entry) Find(path string) *Entry {
	parts := strings.Split(filepath.ToSlash(path), "/")
	current := e
	
	for _, part := range parts {
		if part == "" {
			continue
		}
		found := false
		for _, child := range current.Children {
			if strings.EqualFold(child.Name, part) {
				current = child
				found = true
				break
			}
		}
		if !found {
			return nil
		}
	}
	return current
}

// Walk traverses the entry tree
func (e *Entry) Walk(fn func(*Entry) error) error {
	if err := fn(e); err != nil {
		return err
	}
	for _, child := range e.Children {
		if err := child.Walk(fn); err != nil {
			return err
		}
	}
	return nil
}

// Reader reads HPI archives
type Reader struct {
	file       *os.File
	header     *Header
	root       *Entry
	decryptKey uint8
	version    uint32
}

// Version reports the on-disk HPI version (VersionV1 or VersionV2).
func (r *Reader) Version() uint32 {
	return r.version
}

// OpenReader opens an HPI file for reading
func OpenReader(path string) (*Reader, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	reader := &Reader{file: file}
	if err := reader.readHeader(); err != nil {
		_ = file.Close()
		return nil, err
	}

	if err := reader.readDirectory(); err != nil {
		_ = file.Close()
		return nil, err
	}

	return reader, nil
}

// Close closes the HPI file
func (r *Reader) Close() error {
	if r.file != nil {
		return r.file.Close()
	}
	return nil
}

// Header returns the HPI file header
func (r *Reader) Header() *Header {
	return r.header
}

// List returns all files in the archive
func (r *Reader) List() []string {
	var files []string
	if r.root != nil {
		_ = r.root.Walk(func(e *Entry) error {
			if !e.IsDir {
				files = append(files, e.FullPath())
			}
			return nil
		})
	}
	return files
}

// Walk traverses all entries in the archive
func (r *Reader) Walk(fn func(*Entry) error) error {
	if r.root == nil {
		return nil
	}
	return r.root.Walk(fn)
}

// Find locates an entry by path
func (r *Reader) Find(path string) *Entry {
	if r.root == nil {
		return nil
	}
	return r.root.Find(path)
}

// Root returns the root entry
func (r *Reader) Root() *Entry {
	return r.root
}

// Open opens a file from the archive
func (r *Reader) Open(path string) (io.ReadCloser, error) {
	entry := r.Find(path)
	if entry == nil {
		return nil, fmt.Errorf("file not found: %s", path)
	}
	return r.OpenEntry(entry)
}

// OpenEntry opens a file entry
func (r *Reader) OpenEntry(entry *Entry) (io.ReadCloser, error) {
	if entry.IsDir {
		return nil, errors.New("cannot open directory")
	}

	data, err := r.extractFile(entry)
	if err != nil {
		return nil, err
	}

	return io.NopCloser(bytes.NewReader(data)), nil
}

// decryptBuffer decrypts a buffer using HPI's XOR encryption
func decryptBuffer(key uint8, seed uint8, data []byte) {
	if key == 0 {
		return
	}
	for i := 0; i < len(data); i++ {
		pos := seed + uint8(i)
		data[i] ^= (pos ^ key)
	}
}

// readDecryptBytes reads and decrypts bytes from the file
func (r *Reader) readDecryptBytes(size int) ([]byte, error) {
	seed := uint8(r.getCurrentPosition())
	data := make([]byte, size)
	n, err := r.file.Read(data)
	if err != nil {
		return nil, err
	}
	decryptBuffer(r.decryptKey, seed, data[:n])
	return data[:n], nil
}

// readDecryptUint32 reads and decrypts a uint32
func (r *Reader) readDecryptUint32() (uint32, error) {
	data, err := r.readDecryptBytes(4)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(data), nil
}

// readDecryptUint8 reads and decrypts a uint8
func (r *Reader) readDecryptUint8() (uint8, error) {
	data, err := r.readDecryptBytes(1)
	if err != nil {
		return 0, err
	}
	return data[0], nil
}

// getCurrentPosition returns current file position
func (r *Reader) getCurrentPosition() int64 {
	pos, _ := r.file.Seek(0, io.SeekCurrent)
	return pos
}

// readHeader reads the HPI header. Only the first 8 bytes (marker + version)
// have the same meaning across v1 and v2; the rest of the v1 Header struct is
// only valid when Version == VersionV1.
func (r *Reader) readHeader() error {
	// Read marker + version up-front so we can dispatch on version.
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
	if marker != HeaderMarker {
		return fmt.Errorf("invalid HPI marker: 0x%X", marker)
	}

	switch version {
	case VersionV1:
		// Re-read the full v1 header at offset 0.
		if _, err := r.file.Seek(0, io.SeekStart); err != nil {
			return err
		}
		header := &Header{}
		if err := binary.Read(r.file, binary.LittleEndian, header); err != nil {
			return err
		}
		r.header = header
		r.version = VersionV1
		// Transform decrypt key as the v1 loader does.
		headerKey := uint8(header.DecryptKey)
		r.decryptKey = (headerKey << 2) | (headerKey >> 6)
		return nil

	case VersionV2:
		// v2 has a different layout after the version word; record the marker
		// and version so callers can introspect, leave v1-only fields zero.
		r.header = &Header{Marker: marker, Version: version}
		r.version = VersionV2
		r.decryptKey = 0
		return nil

	default:
		return fmt.Errorf("unsupported HPI version: 0x%X", version)
	}
}

// readDirectory reads the directory structure (dispatches on version).
func (r *Reader) readDirectory() error {
	if r.version == VersionV2 {
		return r.readDirectoryV2()
	}
	return r.readDirectoryV1()
}

func (r *Reader) readDirectoryV1() error {
	// Allocate buffer for full directory size
	dirBuffer := make([]byte, r.header.DirectorySize)
	
	// Seek to the start offset within the directory
	dirStart := r.header.Offset
	if dirStart == 0 {
		dirStart = uint32(HeaderSize)
	}
	
	if _, err := r.file.Seek(int64(dirStart), io.SeekStart); err != nil {
		return err
	}

	// Read and decrypt only the portion from start to end
	readSize := r.header.DirectorySize - dirStart
	decryptedData, err := r.readDecryptBytes(int(readSize))
	if err != nil {
		return err
	}
	
	// Copy into the buffer at the correct offset
	copy(dirBuffer[dirStart:], decryptedData)

	// Parse root directory from buffer (at the start offset)
	root, err := r.parsePathData(dirBuffer, int(dirStart))
	if err != nil {
		return err
	}

	r.root = &Entry{
		Name:     "",
		IsDir:    true,
		Children: root,
	}

	return nil
}

// parsePathData parses a directory structure from the buffer
func (r *Reader) parsePathData(buffer []byte, offset int) ([]*Entry, error) {
	if offset+8 > len(buffer) {
		return nil, errors.New("path data out of bounds")
	}

	numEntries := binary.LittleEndian.Uint32(buffer[offset:])
	entryListOffset := binary.LittleEndian.Uint32(buffer[offset+4:])

	var entries []*Entry
	for i := uint32(0); i < numEntries; i++ {
		entryOffset := int(entryListOffset) + int(i)*9
		if entryOffset+9 > len(buffer) {
			return nil, fmt.Errorf("entry %d out of bounds", i)
		}

		nameOffset := binary.LittleEndian.Uint32(buffer[entryOffset:])
		dataOffset := binary.LittleEndian.Uint32(buffer[entryOffset+4:])
		isDir := buffer[entryOffset+8]

		// Read null-terminated name
		name, err := r.readNullTerminatedString(buffer, int(nameOffset))
		if err != nil {
			return nil, fmt.Errorf("failed to read entry name: %w", err)
		}

		entry := &Entry{
			Name:  name,
			IsDir: isDir != 0,
		}

		if isDir != 0 {
			// Parse subdirectory
			children, err := r.parsePathData(buffer, int(dataOffset))
			if err != nil {
				return nil, err
			}
			entry.Children = children
			for _, child := range children {
				child.Parent = entry
			}
		} else {
			// Parse file data
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

// readNullTerminatedString reads a null-terminated string from buffer
func (r *Reader) readNullTerminatedString(buffer []byte, offset int) (string, error) {
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

// extractFile extracts a file's data.
func (r *Reader) extractFile(entry *Entry) ([]byte, error) {
	if r.version == VersionV2 {
		return r.extractFileV2(entry)
	}
	switch entry.CompType {
	case CompressionNone:
		return r.extractUncompressed(entry)
	case CompressionLZ77, CompressionZLib:
		return r.extractCompressed(entry)
	default:
		return nil, fmt.Errorf("unknown compression type: %d", entry.CompType)
	}
}

// extractUncompressed extracts an uncompressed file
func (r *Reader) extractUncompressed(entry *Entry) ([]byte, error) {
	if _, err := r.file.Seek(int64(entry.Offset), io.SeekStart); err != nil {
		return nil, err
	}
	return r.readDecryptBytes(int(entry.Size))
}

// extractCompressed extracts a compressed file
func (r *Reader) extractCompressed(entry *Entry) ([]byte, error) {
	// Calculate number of chunks (each chunk is 64KB max)
	numChunks := (entry.Size / 65536)
	if entry.Size%65536 != 0 {
		numChunks++
	}

	if _, err := r.file.Seek(int64(entry.Offset), io.SeekStart); err != nil {
		return nil, err
	}

	// Read chunk sizes
	chunkSizes := make([]uint32, numChunks)
	for i := range chunkSizes {
		size, err := r.readDecryptUint32()
		if err != nil {
			return nil, err
		}
		chunkSizes[i] = size
	}

	// Decompress chunks
	output := make([]byte, 0, entry.Size)
	for i := uint32(0); i < numChunks; i++ {
		chunk, err := r.readChunk()
		if err != nil {
			return nil, fmt.Errorf("failed to read chunk %d: %w", i, err)
		}
		output = append(output, chunk...)
	}

	return output, nil
}

// ChunkHeader represents a chunk header
type ChunkHeader struct {
	Magic            uint32
	Version          uint8
	CompressionType  uint8
	Encoded          uint8
	CompressedSize   uint32
	DecompressedSize uint32
	Checksum         uint32
}

// readChunk reads and decompresses a single chunk
func (r *Reader) readChunk() ([]byte, error) {
	// Read chunk header (encrypted)
	magic, err := r.readDecryptUint32()
	if err != nil {
		return nil, err
	}
	_, err = r.readDecryptUint8() // version (unused)
	if err != nil {
		return nil, err
	}
	compressionType, err := r.readDecryptUint8()
	if err != nil {
		return nil, err
	}
	encoded, err := r.readDecryptUint8()
	if err != nil {
		return nil, err
	}
	compressedSize, err := r.readDecryptUint32()
	if err != nil {
		return nil, err
	}
	decompressedSize, err := r.readDecryptUint32()
	if err != nil {
		return nil, err
	}
	checksum, err := r.readDecryptUint32()
	if err != nil {
		return nil, err
	}

	if magic != ChunkMarker {
		return nil, fmt.Errorf("invalid chunk marker: 0x%X", magic)
	}

	// Read compressed data (encrypted)
	compressedData, err := r.readDecryptBytes(int(compressedSize))
	if err != nil {
		return nil, err
	}

	// Verify checksum
	computedChecksum := computeChecksum(compressedData)
	if computedChecksum != checksum {
		return nil, fmt.Errorf("checksum mismatch: expected 0x%X, got 0x%X", checksum, computedChecksum)
	}

	// Decode if needed
	if encoded != 0 {
		decodeChunkBuffer(compressedData)
	}

	// Decompress
	switch compressionType {
	case CompressionNone:
		if uint32(len(compressedData)) != decompressedSize {
			return nil, fmt.Errorf("size mismatch for uncompressed chunk")
		}
		return compressedData, nil

	case CompressionZLib:
		reader, err := zlib.NewReader(bytes.NewReader(compressedData))
		if err != nil {
			return nil, err
		}
		defer func() { _ = reader.Close() }()
		return io.ReadAll(reader)

	case CompressionLZ77:
		return decompressLZ77(compressedData, int(decompressedSize))

	default:
		return nil, fmt.Errorf("unknown compression type: %d", compressionType)
	}
}

// computeChecksum computes HPI checksum (sum of all bytes)
func computeChecksum(data []byte) uint32 {
	var sum uint32
	for _, b := range data {
		sum += uint32(b)
	}
	return sum
}

// decodeChunkBuffer decodes chunk buffer
func decodeChunkBuffer(data []byte) {
	for i := 0; i < len(data); i++ {
		pos := uint8(i)
		data[i] = (data[i] - pos) ^ pos
	}
}

// decompressLZ77 decompresses LZ77 data using sliding window
func decompressLZ77(compressed []byte, decompressedSize int) ([]byte, error) {
	output := make([]byte, 0, decompressedSize)
	window := make([]byte, 4096)
	inPos := 0
	windowPos := uint32(1)

	for inPos < len(compressed) {

		tag := uint8(compressed[inPos])
		inPos++

		for bit := uint32(0); bit < 8; bit++ {
			if (tag & 1) == 0 {
				// Literal byte
				if inPos >= len(compressed) {
					break
				}

				if len(output) >= decompressedSize {
					return output, nil
				}

				b := compressed[inPos]
				output = append(output, b)
				window[windowPos] = b
				windowPos = (windowPos + 1) & 0xFFF
				inPos++
			} else {
				// Window reference
				if inPos+1 >= len(compressed) {
					break
				}

				packedData := uint32(compressed[inPos]) | (uint32(compressed[inPos+1]) << 8)
				offset := packedData >> 4
				count := (packedData & 0x0F) + 2

				inPos += 2

				if offset == 0 {
					return output, nil
				}

				if len(output)+int(count) > decompressedSize {
					count = uint32(decompressedSize - len(output))
				}

				for x := uint32(0); x < count; x++ {
					b := window[offset]
					output = append(output, b)
					window[windowPos] = b
					offset = (offset + 1) & 0xFFF
					windowPos = (windowPos + 1) & 0xFFF
				}
			}

			tag >>= 1
		}

		if len(output) >= decompressedSize {
			return output, nil
		}
	}

	return output, nil
}


