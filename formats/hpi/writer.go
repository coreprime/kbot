package hpi

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// WriterEntry holds a file's metadata and payload for writing into an archive.
type WriterEntry struct {
	Path string
	Data []byte

	// When RawChunks is set the writer stores these bytes verbatim instead of
	// compressing Data. This is used for byte-perfect round-trips where the
	// original compressed representation must be preserved.
	RawChunks    []byte
	DecompSize   uint32
	CompType     uint8
	IsRawPassthrough bool
}

// Writer builds an HPI archive.
type Writer struct {
	file              *os.File
	entries           []WriterEntry
	trailer           []byte
	CompressionLevel  int   // zlib level (0–9); 0 means default
	CompressionMethod uint8 // 0=none, 1=LZ77, 2=zlib (default)

	// HeaderKey is the raw HeaderKey value stored in the HPI header. The
	// reader transforms it into the per-byte XOR key used for the
	// directory and chunk regions. A value of 0 disables encryption.
	// Defaults to DefaultHeaderKey when the writer is created via
	// CreateWriter.
	HeaderKey uint8

	// ChunkEncoded controls whether each SQSH chunk's compressed payload
	// is run through the per-position add/XOR transform (the chunk
	// header's "encoded" byte). Defaults to true, matching every chunk
	// shipped in retail TA archives.
	ChunkEncoded bool
}

// CreateWriter creates a new HPI archive at the given path. The writer is
// initialised with the Total Annihilation retail defaults: HeaderKey 0xBF,
// LZ77 compression, encoded chunks, and the Cavedog copyright trailer.
// Override any of these fields (or call SetTrailer) before adding files to
// change the produced archive.
func CreateWriter(path string) (*Writer, error) {
	file, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	return &Writer{
		file:              file,
		HeaderKey:         DefaultHeaderKey,
		CompressionMethod: CompressionLZ77,
		ChunkEncoded:      true,
		trailer:           []byte(DefaultTrailer),
	}, nil
}

// SetTrailer sets optional trailing bytes appended after the file data section.
func (w *Writer) SetTrailer(data []byte) {
	w.trailer = append([]byte(nil), data...)
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
// The compression method used is determined by the Writer's
// CompressionMethod field (default: LZ77).
func (w *Writer) AddFileFromBytes(archivePath string, data []byte) error {
	method := w.CompressionMethod
	if method == 0 {
		method = CompressionLZ77
	}
	w.entries = append(w.entries, WriterEntry{
		Path:       filepath.ToSlash(archivePath),
		Data:       data,
		DecompSize: uint32(len(data)),
		CompType:   method,
	})
	return nil
}

// AddRawEntry adds a pre-compressed file entry whose chunk payload will be
// written verbatim. Used for lossless round-trips.
func (w *Writer) AddRawEntry(archivePath string, rawChunks []byte, decompSize uint32, compType uint8) {
	w.entries = append(w.entries, WriterEntry{
		Path:             filepath.ToSlash(archivePath),
		RawChunks:        rawChunks,
		DecompSize:       decompSize,
		CompType:         compType,
		IsRawPassthrough: true,
	})
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
	name     string
	children []*dirNode // in insertion order
	files    []*fileNode
	ordered  []interface{} // interleaved *dirNode / *fileNode in insertion order
}

type fileNode struct {
	name       string
	entryIndex int // index into Writer.entries
}

func (d *dirNode) findOrCreateChild(name string) *dirNode {
	for _, c := range d.children {
		if c.name == name {
			return c
		}
	}
	child := &dirNode{name: name}
	d.children = append(d.children, child)
	d.ordered = append(d.ordered, child)
	return child
}

func (d *dirNode) addFile(name string, idx int) {
	fn := &fileNode{name: name, entryIndex: idx}
	d.files = append(d.files, fn)
	d.ordered = append(d.ordered, fn)
}

func buildTree(entries []WriterEntry) *dirNode {
	root := &dirNode{}
	for i, e := range entries {
		parts := strings.Split(e.Path, "/")
		cur := root
		for _, p := range parts[:len(parts)-1] {
			cur = cur.findOrCreateChild(p)
		}
		cur.addFile(parts[len(parts)-1], i)
	}
	return root
}

// ---------------------------------------------------------------------------
// internal: two-pass directory serialization
//
// Pass 1 – compute sizes so we know absolute offsets.
// Pass 2 – emit bytes.
//
// Layout of a directory node D with N children (dirs + files):
//
//   DirNodeHeader  [8 bytes]  numEntries | entryListOffset
//   EntryList      [N×9 bytes]
//   For each child in insertion order:
//     NullTerminatedName
//     if file:  FileDataRecord [9 bytes]
//     if dir:   [child subtree recursively]
// ---------------------------------------------------------------------------

// dirSize returns the total byte size of the serialized directory subtree
// rooted at d (not including d's own DirNodeHeader, which is written by the
// parent's child-loop).
func dirSize(d *dirNode) int {
	n := len(d.ordered)
	// DirNodeHeader(8) + EntryList(N*9)
	size := 8 + n*9
	for _, item := range d.ordered {
		switch v := item.(type) {
		case *fileNode:
			size += len(v.name) + 1 + 9 // name\0 + FileDataRecord
		case *dirNode:
			size += len(v.name) + 1 + dirSize(v) // name\0 + subtree
		}
	}
	return size
}

// serializeDir writes the directory subtree into buf starting at buf[base].
// absBase is the absolute file offset that corresponds to buf[base]; all
// pointers written into the buffer use absolute file offsets.
func serializeDir(buf []byte, base int, absBase int, d *dirNode, fileOffsets []uint32, currentFileDataOffset *uint32, entries []WriterEntry, chunkSizes []int) {
	n := uint32(len(d.ordered))
	entryListOff := absBase + 8

	binary.LittleEndian.PutUint32(buf[base:], n)
	binary.LittleEndian.PutUint32(buf[base+4:], uint32(entryListOff))

	// The payload region (names + child data) starts right after the entry list.
	payloadBuf := base + 8 + int(n)*9
	payloadAbs := absBase + 8 + int(n)*9

	for i, item := range d.ordered {
		entryBuf := (base + 8) + i*9

		switch v := item.(type) {
		case *fileNode:
			nameAbs := payloadAbs
			copy(buf[payloadBuf:], v.name)
			buf[payloadBuf+len(v.name)] = 0
			payloadBuf += len(v.name) + 1
			payloadAbs += len(v.name) + 1

			dataRecAbs := payloadAbs
			dataRecBuf := payloadBuf
			e := entries[v.entryIndex]

			binary.LittleEndian.PutUint32(buf[dataRecBuf:], *currentFileDataOffset)
			binary.LittleEndian.PutUint32(buf[dataRecBuf+4:], e.DecompSize)
			buf[dataRecBuf+8] = e.CompType
			payloadBuf += 9
			payloadAbs += 9

			rawLen := chunkSizes[v.entryIndex]
			fileOffsets[v.entryIndex] = *currentFileDataOffset
			*currentFileDataOffset += uint32(rawLen)

			binary.LittleEndian.PutUint32(buf[entryBuf:], uint32(nameAbs))
			binary.LittleEndian.PutUint32(buf[entryBuf+4:], uint32(dataRecAbs))
			buf[entryBuf+8] = 0

		case *dirNode:
			nameAbs := payloadAbs
			copy(buf[payloadBuf:], v.name)
			buf[payloadBuf+len(v.name)] = 0
			payloadBuf += len(v.name) + 1
			payloadAbs += len(v.name) + 1

			childBuf := payloadBuf
			childAbs := payloadAbs

			binary.LittleEndian.PutUint32(buf[entryBuf:], uint32(nameAbs))
			binary.LittleEndian.PutUint32(buf[entryBuf+4:], uint32(childAbs))
			buf[entryBuf+8] = 1

			serializeDir(buf, childBuf, childAbs, v, fileOffsets, currentFileDataOffset, entries, chunkSizes)
			subtreeSize := dirSize(v)
			payloadBuf = childBuf + subtreeSize
			payloadAbs = childAbs + subtreeSize
		}
	}
}

const chunkMaxDecomp = 65536

// buildChunks compresses data into the HPI chunk format (size table + SQSH
// chunk headers + payloads). compType selects the algorithm (LZ77 or zlib).
// level is the zlib compression level; values ≤0 use zlib.DefaultCompression.
// When chunkEncoded is true the compressed bytes of each chunk are run
// through encodeChunkBuffer before the checksum is computed, and the chunk
// header's "encoded" byte is set so the reader applies the inverse pass.
func buildChunks(data []byte, compType uint8, level int, chunkEncoded bool) []byte {
	numChunks := len(data) / chunkMaxDecomp
	if len(data)%chunkMaxDecomp != 0 || numChunks == 0 {
		numChunks++
	}

	// Compress each chunk first so we know sizes.
	type chunk struct {
		compressed []byte
		decompSize uint32
	}
	chunks := make([]chunk, numChunks)
	for i := range chunks {
		lo := i * chunkMaxDecomp
		hi := lo + chunkMaxDecomp
		if hi > len(data) {
			hi = len(data)
		}
		block := data[lo:hi]

		var compressed []byte
		switch compType {
		case CompressionLZ77:
			compressed = compressLZ77(block)
		default:
			var zbuf bytes.Buffer
			zlibLevel := level
			if zlibLevel <= 0 {
				zlibLevel = zlib.DefaultCompression
			}
			zw, _ := zlib.NewWriterLevel(&zbuf, zlibLevel)
			_, _ = zw.Write(block)
			_ = zw.Close()
			compressed = zbuf.Bytes()
		}
		if chunkEncoded {
			encodeChunkBuffer(compressed)
		}
		chunks[i] = chunk{compressed: compressed, decompSize: uint32(len(block))}
	}

	encodedByte := byte(0)
	if chunkEncoded {
		encodedByte = 1
	}

	// Compute total size: sizeTable(numChunks*4) + sum(19 + compSize)
	total := numChunks * 4
	for _, c := range chunks {
		total += 19 + len(c.compressed)
	}

	out := make([]byte, total)
	pos := 0

	// Write chunk size table
	for _, c := range chunks {
		chunkTotal := uint32(19 + len(c.compressed))
		binary.LittleEndian.PutUint32(out[pos:], chunkTotal)
		pos += 4
	}

	// Write chunk headers + data. The checksum is computed on the bytes
	// as written (post-encode), matching the reader which verifies the
	// checksum before applying decodeChunkBuffer.
	for _, c := range chunks {
		binary.LittleEndian.PutUint32(out[pos:], ChunkMarker)
		out[pos+4] = 2 // version
		out[pos+5] = compType
		out[pos+6] = encodedByte
		binary.LittleEndian.PutUint32(out[pos+7:], uint32(len(c.compressed)))
		binary.LittleEndian.PutUint32(out[pos+11:], c.decompSize)
		binary.LittleEndian.PutUint32(out[pos+15:], computeChecksum(c.compressed))
		pos += 19
		copy(out[pos:], c.compressed)
		pos += len(c.compressed)
	}

	return out
}

// encodeChunkBuffer is the inverse of decodeChunkBuffer: for each byte at
// position i it computes (b ^ i) + i. Both operations use uint8 arithmetic.
func encodeChunkBuffer(data []byte) {
	for i := range data {
		pos := uint8(i)
		data[i] = (data[i] ^ pos) + pos
	}
}

// ---------------------------------------------------------------------------
// writeArchive lays out: Header | DirSection | FileData | Trailer
// ---------------------------------------------------------------------------

func (w *Writer) writeArchive() error {
	if len(w.entries) == 0 {
		return fmt.Errorf("no entries to write")
	}

	// Pre-build compressed chunks for non-raw entries so we can compute sizes.
	chunkBlobs := make([][]byte, len(w.entries))
	for i, e := range w.entries {
		if e.IsRawPassthrough {
			chunkBlobs[i] = e.RawChunks
		} else {
			chunkBlobs[i] = buildChunks(e.Data, e.CompType, w.CompressionLevel, w.ChunkEncoded)
		}
	}

	tree := buildTree(w.entries)
	dirSectionSize := dirSize(tree)
	fileDataStart := uint32(HeaderSize + dirSectionSize)

	// Build a lookup from entry index to pre-computed raw size so the
	// directory serializer does not need to re-compress.
	chunkSizes := make([]int, len(w.entries))
	for i := range chunkBlobs {
		chunkSizes[i] = len(chunkBlobs[i])
	}

	// Serialize directory. All pointers inside the directory section are
	// absolute file offsets, so the root DirNode starts at HeaderSize.
	dirBuf := make([]byte, dirSectionSize)
	fileOffsets := make([]uint32, len(w.entries))
	fdOffset := fileDataStart
	serializeDir(dirBuf, 0, HeaderSize, tree, fileOffsets, &fdOffset, w.entries, chunkSizes)

	// Write header (always plaintext — the header carries the HeaderKey
	// that the reader uses to decrypt everything that follows).
	hdr := Header{
		Marker:        HeaderMarker,
		Version:       0x00010000,
		DirectorySize: fileDataStart,
		DecryptKey:    uint32(w.HeaderKey),
		Offset:        uint32(HeaderSize),
	}
	if err := binary.Write(w.file, binary.LittleEndian, &hdr); err != nil {
		return fmt.Errorf("writing header: %w", err)
	}

	xorKey := transformHeaderKey(w.HeaderKey)
	offset := int64(HeaderSize)

	// Write directory section (encrypted when HeaderKey != 0).
	encryptInPlace(xorKey, offset, dirBuf)
	if _, err := w.file.Write(dirBuf); err != nil {
		return fmt.Errorf("writing directory: %w", err)
	}
	offset += int64(len(dirBuf))

	// Write file data in insertion order (matches directory walk order).
	// chunkBlobs for raw passthrough entries belong to the caller, so we
	// copy before encrypting in place.
	for i := range w.entries {
		blob := chunkBlobs[i]
		if xorKey != 0 {
			enc := make([]byte, len(blob))
			copy(enc, blob)
			encryptInPlace(xorKey, offset, enc)
			blob = enc
		}
		if _, err := w.file.Write(blob); err != nil {
			return fmt.Errorf("writing file data for %s: %w", w.entries[i].Path, err)
		}
		offset += int64(len(blob))
	}

	// Write optional trailer. The reader's ReadTrailer helper does not
	// apply HPI decryption to trailer bytes, so we keep them plaintext to
	// stay symmetric with that helper.
	if len(w.trailer) > 0 {
		if _, err := w.file.Write(w.trailer); err != nil {
			return fmt.Errorf("writing trailer: %w", err)
		}
	}

	return nil
}

// transformHeaderKey converts the raw HeaderKey value stored in the HPI
// header into the per-byte XOR key used to (de)scramble the directory and
// chunk regions. Mirrors the transformation performed in Reader.readHeader.
func transformHeaderKey(headerKey uint8) uint8 {
	if headerKey == 0 {
		return 0
	}
	return (headerKey << 2) | (headerKey >> 6)
}

// encryptInPlace XORs each byte of data with (uint8(startOffset+i) ^ key).
// This is the symmetric XOR scheme used by the HPI reader (decryptBuffer);
// applying it again yields the original bytes.
func encryptInPlace(key uint8, startOffset int64, data []byte) {
	if key == 0 {
		return
	}
	for i := range data {
		p := uint8(uint64(startOffset) + uint64(i))
		data[i] ^= p ^ key
	}
}

// ---------------------------------------------------------------------------
// Reader helpers for raw chunk extraction
// ---------------------------------------------------------------------------

// ReadRawFileData returns the raw on-disk bytes for a compressed file entry:
// the chunk size table followed by the SQSH chunk headers and their payloads.
// This is the exact byte sequence stored in the archive, suitable for writing
// back verbatim into a new archive via AddRawEntry.
func (r *Reader) ReadRawFileData(entry *Entry) ([]byte, error) {
	if entry.IsDir {
		return nil, fmt.Errorf("cannot read raw data for a directory")
	}

	numChunks := entry.Size / chunkMaxDecomp
	if entry.Size%chunkMaxDecomp != 0 {
		numChunks++
	}

	// Seek to the entry's data offset.
	if _, err := r.file.Seek(int64(entry.Offset), io.SeekStart); err != nil {
		return nil, err
	}

	// Read the chunk size table to determine total payload length.
	sizeTableBytes, err := r.readDecryptBytes(int(numChunks) * 4)
	if err != nil {
		return nil, fmt.Errorf("reading chunk size table: %w", err)
	}

	totalChunkData := 0
	for i := uint32(0); i < numChunks; i++ {
		totalChunkData += int(binary.LittleEndian.Uint32(sizeTableBytes[i*4:]))
	}

	chunkPayload, err := r.readDecryptBytes(totalChunkData)
	if err != nil {
		return nil, fmt.Errorf("reading chunk data: %w", err)
	}

	raw := make([]byte, len(sizeTableBytes)+len(chunkPayload))
	copy(raw, sizeTableBytes)
	copy(raw[len(sizeTableBytes):], chunkPayload)
	return raw, nil
}

// ReadTrailer returns any bytes that follow the last file's chunk data up to
// the end of the archive. Returns nil if there is no trailing data.
func (r *Reader) ReadTrailer() ([]byte, error) {
	// Find the end of the last file's raw data by computing
	// the maximum (offset + raw length) across all file entries.
	var maxEnd int64
	if r.root != nil {
		_ = r.root.Walk(func(e *Entry) error {
			if e.IsDir {
				return nil
			}
			numChunks := e.Size / chunkMaxDecomp
			if e.Size%chunkMaxDecomp != 0 {
				numChunks++
			}
			// Seek and read chunk sizes to compute raw length.
			if _, err := r.file.Seek(int64(e.Offset), io.SeekStart); err != nil {
				return nil
			}
			sizeTable, err := r.readDecryptBytes(int(numChunks) * 4)
			if err != nil {
				return nil
			}
			total := int64(e.Offset) + int64(numChunks)*4
			for i := uint32(0); i < numChunks; i++ {
				total += int64(binary.LittleEndian.Uint32(sizeTable[i*4:]))
			}
			if total > maxEnd {
				maxEnd = total
			}
			return nil
		})
	}

	fileSize, err := r.file.Seek(0, io.SeekEnd)
	if err != nil {
		return nil, err
	}

	if maxEnd >= fileSize {
		return nil, nil
	}

	trailerLen := fileSize - maxEnd
	if _, err := r.file.Seek(maxEnd, io.SeekStart); err != nil {
		return nil, err
	}
	trailer := make([]byte, trailerLen)
	if _, err := io.ReadFull(r.file, trailer); err != nil {
		return nil, err
	}
	return trailer, nil
}
