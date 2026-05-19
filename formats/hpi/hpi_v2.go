package hpi

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
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

// readDirectoryV2 reads the TA: Kingdoms style directory tree. The directory
// and name blocks live at arbitrary offsets in the archive (typically at the
// tail), each optionally wrapped in a single SQSH chunk.
func (r *Reader) readDirectoryV2() error {
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

	children, err := parseDirV2Children(dirBuf, nameBuf, 0)
	if err != nil {
		return err
	}
	r.root = &Entry{IsDir: true, Children: children}
	for _, c := range children {
		c.Parent = r.root
	}
	return nil
}

// parseDirV2Children parses an HpiDir2 at dirOffset and returns its
// subdirectory and file children with v2 entries fully populated.
func parseDirV2Children(dir, names []byte, dirOffset int) ([]*Entry, error) {
	if dirOffset < 0 || dirOffset+dirV2Size > len(dir) {
		return nil, fmt.Errorf("v2 directory offset %d out of range (len=%d)", dirOffset, len(dir))
	}
	_ = int32(binary.LittleEndian.Uint32(dir[dirOffset:])) // NamePtr (unused for root)
	firstSubDir := int32(binary.LittleEndian.Uint32(dir[dirOffset+4:]))
	subCount := int32(binary.LittleEndian.Uint32(dir[dirOffset+8:]))
	firstFile := int32(binary.LittleEndian.Uint32(dir[dirOffset+12:]))
	fileCount := int32(binary.LittleEndian.Uint32(dir[dirOffset+16:]))

	var children []*Entry
	for i := int32(0); i < subCount; i++ {
		off := int(firstSubDir) + int(i)*dirV2Size
		entry, err := parseDirV2(dir, names, off)
		if err != nil {
			return nil, err
		}
		children = append(children, entry)
	}
	for i := int32(0); i < fileCount; i++ {
		off := int(firstFile) + int(i)*entryV2Size
		entry, err := parseFileV2(dir, names, off)
		if err != nil {
			return nil, err
		}
		children = append(children, entry)
	}
	return children, nil
}

func parseDirV2(dir, names []byte, off int) (*Entry, error) {
	if off < 0 || off+dirV2Size > len(dir) {
		return nil, fmt.Errorf("v2 subdir offset %d out of range (len=%d)", off, len(dir))
	}
	namePtr := int32(binary.LittleEndian.Uint32(dir[off:]))
	name, err := readNameV2(names, int(namePtr))
	if err != nil {
		return nil, fmt.Errorf("read subdir name: %w", err)
	}
	entry := &Entry{Name: name, IsDir: true}
	kids, err := parseDirV2Children(dir, names, off)
	if err != nil {
		return nil, err
	}
	entry.Children = kids
	for _, c := range kids {
		c.Parent = entry
	}
	return entry, nil
}

func parseFileV2(dir, names []byte, off int) (*Entry, error) {
	if off < 0 || off+entryV2Size > len(dir) {
		return nil, fmt.Errorf("v2 file offset %d out of range (len=%d)", off, len(dir))
	}
	namePtr := int32(binary.LittleEndian.Uint32(dir[off:]))
	start := int32(binary.LittleEndian.Uint32(dir[off+4:]))
	decompressed := int32(binary.LittleEndian.Uint32(dir[off+8:]))
	compressed := int32(binary.LittleEndian.Uint32(dir[off+12:]))
	// Bytes 16-23 are Date and Checksum; not needed for read-only access.

	name, err := readNameV2(names, int(namePtr))
	if err != nil {
		return nil, fmt.Errorf("read file name: %w", err)
	}
	if start < 0 || decompressed < 0 || compressed < 0 {
		return nil, fmt.Errorf("v2 file %q has negative size/offset (start=%d, decomp=%d, comp=%d)", name, start, decompressed, compressed)
	}
	return &Entry{
		Name:           name,
		IsDir:          false,
		Offset:         uint32(start),
		Size:           uint32(decompressed),
		CompressedSize: uint32(compressed),
	}, nil
}

func readNameV2(names []byte, offset int) (string, error) {
	if offset < 0 || offset >= len(names) {
		return "", fmt.Errorf("name offset %d out of range (len=%d)", offset, len(names))
	}
	end := bytes.IndexByte(names[offset:], 0)
	if end < 0 {
		return "", errors.New("name missing null terminator")
	}
	return string(names[offset : offset+end]), nil
}

// readMaybeCompressedBlock reads `size` bytes at `offset`. If the buffer starts
// with the SQSH chunk marker, it is decompressed in-line and the decompressed
// bytes are returned instead. v2 archives store the directory and name blocks
// this way to keep the inflated index out of disk-resident memory.
func (r *Reader) readMaybeCompressedBlock(offset int64, size int) ([]byte, error) {
	if size < 0 {
		return nil, fmt.Errorf("negative block size %d", size)
	}
	if _, err := r.file.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r.file, buf); err != nil {
		return nil, err
	}
	if size >= 4 && binary.LittleEndian.Uint32(buf[:4]) == ChunkMarker {
		return decodeV2Chunk(buf)
	}
	return buf, nil
}

// extractFileV2 returns the (possibly decompressed) bytes of a v2 file entry.
func (r *Reader) extractFileV2(entry *Entry) ([]byte, error) {
	if entry.CompressedSize == 0 {
		if _, err := r.file.Seek(int64(entry.Offset), io.SeekStart); err != nil {
			return nil, err
		}
		buf := make([]byte, entry.Size)
		if _, err := io.ReadFull(r.file, buf); err != nil {
			return nil, err
		}
		return buf, nil
	}
	if _, err := r.file.Seek(int64(entry.Offset), io.SeekStart); err != nil {
		return nil, err
	}
	chunk := make([]byte, entry.CompressedSize)
	if _, err := io.ReadFull(r.file, chunk); err != nil {
		return nil, err
	}
	return decodeV2Chunk(chunk)
}

// decodeV2Chunk parses a single SQSH chunk header at the start of buf and
// returns the decompressed payload. The chunk header layout matches v1, but in
// v2 archives the bytes are stored without XOR encryption applied.
func decodeV2Chunk(buf []byte) ([]byte, error) {
	if len(buf) < SQSHHeaderSize {
		return nil, fmt.Errorf("chunk too small: %d bytes", len(buf))
	}
	if binary.LittleEndian.Uint32(buf[:4]) != ChunkMarker {
		return nil, fmt.Errorf("invalid SQSH marker: 0x%X", binary.LittleEndian.Uint32(buf[:4]))
	}
	compType := buf[5]
	encoded := buf[6]
	compSize := binary.LittleEndian.Uint32(buf[7:11])
	decompSize := binary.LittleEndian.Uint32(buf[11:15])
	checksum := binary.LittleEndian.Uint32(buf[15:19])

	if uint64(SQSHHeaderSize)+uint64(compSize) > uint64(len(buf)) {
		return nil, fmt.Errorf("compressed payload %d exceeds buffer (%d available)", compSize, len(buf)-SQSHHeaderSize)
	}
	payload := make([]byte, compSize)
	copy(payload, buf[SQSHHeaderSize:SQSHHeaderSize+compSize])

	var sum uint32
	for _, b := range payload {
		sum += uint32(b)
	}
	if sum != checksum {
		return nil, fmt.Errorf("SQSH checksum mismatch: expected 0x%X, got 0x%X", checksum, sum)
	}
	if encoded != 0 {
		decodeChunkBuffer(payload)
	}

	switch compType {
	case CompressionNone:
		if uint32(len(payload)) != decompSize {
			return nil, fmt.Errorf("stored chunk size mismatch: header says %d, payload has %d", decompSize, len(payload))
		}
		return payload, nil
	case CompressionZLib:
		zr, err := zlib.NewReader(bytes.NewReader(payload))
		if err != nil {
			return nil, fmt.Errorf("zlib reader: %w", err)
		}
		defer func() { _ = zr.Close() }()
		out, err := io.ReadAll(zr)
		if err != nil {
			return nil, fmt.Errorf("zlib decode: %w", err)
		}
		if uint32(len(out)) != decompSize {
			return nil, fmt.Errorf("zlib chunk size mismatch: header says %d, decoded %d", decompSize, len(out))
		}
		return out, nil
	case CompressionLZ77:
		return decompressLZ77(payload, int(decompSize))
	default:
		return nil, fmt.Errorf("unknown SQSH compression type: %d", compType)
	}
}
