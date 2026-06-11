package gaf

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// Reader reads GAF files.
type Reader struct {
	file   io.ReadSeeker
	header Header
}

// LoadFromReader creates a new Reader from an io.ReadSeeker and validates the
// GAF header.
func LoadFromReader(rs io.ReadSeeker) (*Reader, error) {
	r := &Reader{file: rs}

	if err := binary.Read(rs, binary.LittleEndian, &r.header); err != nil {
		return nil, fmt.Errorf("failed to read GAF header: %w", err)
	}

	if !isSupportedGAFVersion(r.header.Version) {
		return nil, fmt.Errorf("unsupported GAF version: 0x%08X", r.header.Version)
	}

	return r, nil
}

// LoadFromFile opens and validates a GAF file at path.
func LoadFromFile(path string) (*Reader, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	r := &Reader{file: file}

	if err := binary.Read(file, binary.LittleEndian, &r.header); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("failed to read GAF header: %w", err)
	}

	if !isSupportedGAFVersion(r.header.Version) {
		_ = file.Close()
		return nil, fmt.Errorf("unsupported GAF version: 0x%08X (expected 0x%08X)", r.header.Version, VersionTA)
	}

	return r, nil
}

// Close closes the reader if its underlying source is an io.Closer.
func (r *Reader) Close() error {
	if r.file != nil {
		if closer, ok := r.file.(io.Closer); ok {
			return closer.Close()
		}
	}
	return nil
}

// Header returns the file header.
func (r *Reader) Header() *Header {
	return &r.header
}

// ReadSequences reads all animation sequences from the file.
func (r *Reader) ReadSequences() ([]*Sequence, error) {
	// Seek to sequence pointers (after 12-byte header).
	if _, err := r.file.Seek(12, io.SeekStart); err != nil {
		return nil, err
	}

	pointers := make([]uint32, r.header.SequenceCount)
	for i := uint32(0); i < r.header.SequenceCount; i++ {
		if err := binary.Read(r.file, binary.LittleEndian, &pointers[i]); err != nil {
			return nil, fmt.Errorf("failed to read sequence pointer %d: %w", i, err)
		}
	}

	sequences := make([]*Sequence, 0, r.header.SequenceCount)
	for i, ptr := range pointers {
		seq, err := r.readSequence(ptr)
		if err != nil {
			return nil, fmt.Errorf("failed to read sequence %d at offset 0x%X: %w", i, ptr, err)
		}
		sequences = append(sequences, seq)
	}

	return sequences, nil
}

// readSequence reads a single sequence at the given offset.
func (r *Reader) readSequence(offset uint32) (*Sequence, error) {
	if _, err := r.file.Seek(int64(offset), io.SeekStart); err != nil {
		return nil, err
	}

	var sh SequenceHeader
	if err := binary.Read(r.file, binary.LittleEndian, &sh); err != nil {
		return nil, fmt.Errorf("failed to read sequence header: %w", err)
	}

	name := nullTerminatedString(sh.Name[:])

	frameListItems := make([]FrameListItem, sh.FrameCount)
	for i := uint16(0); i < sh.FrameCount; i++ {
		if err := binary.Read(r.file, binary.LittleEndian, &frameListItems[i]); err != nil {
			return nil, fmt.Errorf("failed to read frame list item %d: %w", i, err)
		}
	}

	frames := make([]*Frame, 0, sh.FrameCount)
	for i, item := range frameListItems {
		frame, err := r.readFrame(item.PtrFrameInfo, item.Duration)
		if err != nil {
			return nil, fmt.Errorf("failed to read frame %d at offset 0x%X: %w", i, item.PtrFrameInfo, err)
		}
		frames = append(frames, frame)
	}

	return &Sequence{
		Name:   name,
		Frames: frames,
	}, nil
}

// readFrame reads a single frame at the given offset.
func (r *Reader) readFrame(offset uint32, duration uint32) (*Frame, error) {
	if _, err := r.file.Seek(int64(offset), io.SeekStart); err != nil {
		return nil, err
	}

	var fi FrameInfo
	if err := binary.Read(r.file, binary.LittleEndian, &fi); err != nil {
		return nil, fmt.Errorf("failed to read frame info: %w", err)
	}

	// Layered frame: PtrFrameData is an array of LayerCount uint32 pointers
	// to nested FrameInfos, composited back-to-front inside the outer
	// frame's bounding box (see docs/formats/gaf.md). The TA:K cursor GAFs
	// build every frame this way.
	if fi.LayerCount > 0 {
		// Sanity check: LayerCount should be reasonable (< 100 layers is sane).
		if fi.LayerCount > 100 {
			return nil, fmt.Errorf("invalid layer count %d (possibly corrupt file)", fi.LayerCount)
		}
		return r.readLayeredFrame(&fi, duration)
	}

	return r.readSimpleFrame(&fi, fi.TransparencyIndex, duration)
}

// readLayeredFrame composites a multi-layer frame. Each layer carries its own
// origin (hotspot); layers align by hotspot, so a layer's top-left lands at
// (outer.Origin - layer.Origin) within the outer frame's Width×Height canvas.
// Layer pixels equal to the layer's own transparency index leave the canvas
// untouched, keeping lower layers visible.
func (r *Reader) readLayeredFrame(fi *FrameInfo, duration uint32) (*Frame, error) {
	if _, err := r.file.Seek(int64(fi.PtrFrameData), io.SeekStart); err != nil {
		return nil, fmt.Errorf("failed to seek to layer table at 0x%X: %w", fi.PtrFrameData, err)
	}
	ptrs := make([]uint32, fi.LayerCount)
	if err := binary.Read(r.file, binary.LittleEndian, &ptrs); err != nil {
		return nil, fmt.Errorf("failed to read layer pointers: %w", err)
	}

	w, h := int(fi.Width), int(fi.Height)
	canvas := make([]byte, w*h)
	for i := range canvas {
		canvas[i] = fi.TransparencyIndex
	}

	for li, p := range ptrs {
		var sub FrameInfo
		if _, err := r.file.Seek(int64(p), io.SeekStart); err != nil {
			return nil, fmt.Errorf("failed to seek to layer %d at 0x%X: %w", li, p, err)
		}
		if err := binary.Read(r.file, binary.LittleEndian, &sub); err != nil {
			return nil, fmt.Errorf("failed to read layer %d frame info: %w", li, err)
		}
		if sub.LayerCount > 0 {
			// Nested composites don't appear in the shipped corpus; skip
			// rather than recurse unbounded into a corrupt pointer loop.
			continue
		}
		lf, err := r.readSimpleFrame(&sub, sub.TransparencyIndex, 0)
		if err != nil {
			return nil, fmt.Errorf("failed to read layer %d pixels: %w", li, err)
		}
		// Hotspot alignment within the outer bounding box.
		dx := int(fi.OriginX) - int(sub.OriginX)
		dy := int(fi.OriginY) - int(sub.OriginY)
		for y := 0; y < int(sub.Height); y++ {
			ty := dy + y
			if ty < 0 || ty >= h {
				continue
			}
			for x := 0; x < int(sub.Width); x++ {
				tx := dx + x
				if tx < 0 || tx >= w {
					continue
				}
				px := lf.Pixels[y*int(sub.Width)+x]
				if px == sub.TransparencyIndex {
					continue
				}
				canvas[ty*w+tx] = px
			}
		}
	}

	return &Frame{
		Width:             fi.Width,
		Height:            fi.Height,
		OriginX:           fi.OriginX,
		OriginY:           fi.OriginY,
		TransparencyIndex: fi.TransparencyIndex,
		Duration:          duration,
		Pixels:            canvas,
	}, nil
}

// readSimpleFrame reads pixel data for a simple (non-layered) frame.
func (r *Reader) readSimpleFrame(fi *FrameInfo, transparencyIndex uint8, duration uint32) (*Frame, error) {
	// Seek to pixel data (PtrFrameData is an absolute offset).
	if _, err := r.file.Seek(int64(fi.PtrFrameData), io.SeekStart); err != nil {
		return nil, fmt.Errorf("failed to seek to pixel data at offset 0x%X: %w", fi.PtrFrameData, err)
	}

	var pixels []byte
	var err error

	if fi.Compressed != 0 {
		pixels, err = r.readCompressed(fi.Width, fi.Height, transparencyIndex)
	} else {
		pixels, err = r.readUncompressed(fi.Width, fi.Height)
	}
	if err != nil {
		return nil, err
	}

	return &Frame{
		Width:             fi.Width,
		Height:            fi.Height,
		OriginX:           fi.OriginX,
		OriginY:           fi.OriginY,
		TransparencyIndex: transparencyIndex,
		Duration:          duration,
		Pixels:            pixels,
	}, nil
}

// readUncompressed reads uncompressed pixel data.
func (r *Reader) readUncompressed(width, height uint16) ([]byte, error) {
	size := int(width) * int(height)
	pixels := make([]byte, size)
	if _, err := io.ReadFull(r.file, pixels); err != nil {
		return nil, fmt.Errorf("failed to read uncompressed pixels: %w", err)
	}
	return pixels, nil
}

// readCompressed reads compressed pixel data (row-based RLE compression).
func (r *Reader) readCompressed(width, height uint16, transparencyIndex uint8) ([]byte, error) {
	pixels := make([]byte, int(width)*int(height))
	pos := 0

	for row := uint16(0); row < height; row++ {
		// Read row size (2 bytes).
		var rowSize uint16
		if err := binary.Read(r.file, binary.LittleEndian, &rowSize); err != nil {
			return nil, fmt.Errorf("failed to read row %d size: %w", row, err)
		}

		compressedRow := make([]byte, rowSize)
		if _, err := io.ReadFull(r.file, compressedRow); err != nil {
			return nil, fmt.Errorf("failed to read compressed row %d: %w", row, err)
		}

		rowPos := 0
		bytesLeft := int(width)
		i := 0

		for i < len(compressedRow) && bytesLeft > 0 {
			mask := compressedRow[i]
			i++

			switch {
			case (mask & 0x01) != 0:
				// Transparent pixels.
				count := int(mask >> 1)
				if count > bytesLeft {
					count = bytesLeft
				}
				for j := 0; j < count; j++ {
					pixels[pos+rowPos] = transparencyIndex
					rowPos++
				}
				bytesLeft -= count
			case (mask & 0x02) != 0:
				// RLE: repeat next byte.
				count := int(mask>>2) + 1
				if count > bytesLeft {
					count = bytesLeft
				}
				if i >= len(compressedRow) {
					return nil, fmt.Errorf("unexpected end of compressed row %d", row)
				}
				value := compressedRow[i]
				i++
				for j := 0; j < count; j++ {
					pixels[pos+rowPos] = value
					rowPos++
				}
				bytesLeft -= count
			default:
				// Copy literal bytes.
				count := int(mask>>2) + 1
				if count > bytesLeft {
					count = bytesLeft
				}
				if i+count > len(compressedRow) {
					count = len(compressedRow) - i
				}
				for j := 0; j < count; j++ {
					pixels[pos+rowPos] = compressedRow[i]
					i++
					rowPos++
				}
				bytesLeft -= count
			}
		}

		// Fill any remaining bytes in the row with transparency.
		for bytesLeft > 0 {
			pixels[pos+rowPos] = transparencyIndex
			rowPos++
			bytesLeft--
		}

		pos += int(width)
	}

	return pixels, nil
}

// nullTerminatedString converts a null-terminated byte array to a string.
func nullTerminatedString(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
