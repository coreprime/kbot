package gaf

import (
	"encoding/binary"
	"fmt"
	"io"
)

// WriteGAF writes a complete GAF file containing the given sequences.
// Frame pixel data must already be palette indices ([]byte, one byte per pixel).
func WriteGAF(w io.Writer, sequences []*Sequence) error {
	// We build the entire file in memory so we can compute absolute offsets.
	var buf []byte

	// ── header (12 bytes) ──────────────────────────────────────────────
	header := Header{
		Version:       VersionTA,
		SequenceCount: uint32(len(sequences)),
		Unknown1:      0,
	}
	buf = appendLE(buf, header)

	// ── sequence pointer table ─────────────────────────────────────────
	// Placeholder — filled in after we know each sequence's offset.
	ptrTableOffset := len(buf)
	for range sequences {
		buf = appendU32(buf, 0)
	}

	// ── per-sequence data ──────────────────────────────────────────────
	for si, seq := range sequences {
		// Record this sequence's absolute offset in the pointer table.
		seqOffset := uint32(len(buf))
		binary.LittleEndian.PutUint32(buf[ptrTableOffset+si*4:], seqOffset)

		// Sequence header (40 bytes).
		var sh SequenceHeader
		sh.FrameCount = uint16(len(seq.Frames))
		copy(sh.Name[:], seq.Name)
		buf = appendLE(buf, sh)

		// Frame list items — placeholders, patched below.
		frameListStart := len(buf)
		for range seq.Frames {
			buf = appendLE(buf, FrameListItem{})
		}

		// Write each frame's FrameInfo + pixel data.
		for fi, frame := range seq.Frames {
			frameInfoOffset := uint32(len(buf))

			// Compress pixel data.
			compressed := compressFrame(frame)

			// FrameInfo (24 bytes).
			info := FrameInfo{
				Width:             frame.Width,
				Height:            frame.Height,
				OriginX:           frame.OriginX,
				OriginY:           frame.OriginY,
				TransparencyIndex: frame.TransparencyIndex,
				Compressed:        1, // always write compressed
				LayerCount:        0,
				PtrFrameData:      0, // patched below
			}

			// Reserve space for FrameInfo.
			infoStart := len(buf)
			buf = appendLE(buf, info)

			// Write pixel data immediately after FrameInfo.
			pixelDataOffset := uint32(len(buf))
			buf = append(buf, compressed...)

			// Patch PtrFrameData in the FrameInfo we just wrote.
			// FrameInfo layout: Width(2)+Height(2)+OriginX(2)+OriginY(2)+
			//   TranspIdx(1)+Compressed(1)+LayerCount(2)+Unknown2(4) = offset 16
			binary.LittleEndian.PutUint32(buf[infoStart+16:], pixelDataOffset)

			// Patch the frame list item.
			itemOffset := frameListStart + fi*8
			binary.LittleEndian.PutUint32(buf[itemOffset:], frameInfoOffset)
			binary.LittleEndian.PutUint32(buf[itemOffset+4:], frame.Duration)
		}
	}

	_, err := w.Write(buf)
	return err
}

// compressFrame compresses pixel data using the GAF row-based compression.
func compressFrame(f *Frame) []byte {
	var out []byte
	w := int(f.Width)
	h := int(f.Height)

	for row := 0; row < h; row++ {
		rowStart := row * w
		rowPixels := f.Pixels[rowStart : rowStart+w]

		compressed := compressRow(rowPixels, f.TransparencyIndex)

		// Row size prefix (2 bytes little-endian).
		out = append(out, byte(len(compressed)), byte(len(compressed)>>8))
		out = append(out, compressed...)
	}

	return out
}

// compressRow compresses a single row using the three GAF encoding modes:
//
//	mask & 0x01: transparent run — mask>>1 = count
//	mask & 0x02: RLE — mask>>2 + 1 = count, followed by 1 byte value
//	else:        literal — mask>>2 + 1 = count, followed by N bytes
func compressRow(pixels []byte, transpIdx uint8) []byte {
	var out []byte
	n := len(pixels)
	i := 0

	for i < n {
		// Transparent run?
		if pixels[i] == transpIdx {
			count := 0
			for i+count < n && pixels[i+count] == transpIdx && count < 127 {
				count++
			}
			out = append(out, byte((count<<1)|0x01))
			i += count
			continue
		}

		// RLE: current pixel repeats?
		runLen := 1
		for i+runLen < n && pixels[i+runLen] == pixels[i] && runLen < 63 {
			runLen++
		}

		if runLen >= 3 {
			out = append(out, byte(((runLen-1)<<2)|0x02), pixels[i])
			i += runLen
			continue
		}

		// Literal run: collect non-repeating, non-transparent pixels.
		litStart := i
		for i < n && (i-litStart) < 63 {
			if pixels[i] == transpIdx {
				break
			}
			// Check if an RLE run of 3+ starts here.
			if i+2 < n && pixels[i] == pixels[i+1] && pixels[i] == pixels[i+2] {
				break
			}
			i++
		}
		count := i - litStart
		out = append(out, byte((count-1)<<2))
		out = append(out, pixels[litStart:litStart+count]...)
	}

	return out
}

// ── helpers ────────────────────────────────────────────────────────────────

func appendU32(buf []byte, v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return append(buf, b...)
}

func appendLE(buf []byte, v any) []byte {
	size := binary.Size(v)
	b := make([]byte, size)
	// Use a temporary writer to serialize.
	w := &sliceWriter{buf: b}
	_ = binary.Write(w, binary.LittleEndian, v)
	return append(buf, b...)
}

type sliceWriter struct {
	buf []byte
	pos int
}

func (sw *sliceWriter) Write(p []byte) (int, error) {
	n := copy(sw.buf[sw.pos:], p)
	sw.pos += n
	if n < len(p) {
		return n, fmt.Errorf("buffer overflow")
	}
	return n, nil
}
