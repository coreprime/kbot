package gaf

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"io"
)

// ToPNG converts a single frame to PNG format
func (f *Frame) ToPNG(palette *Palette, w io.Writer) error {
	// Build palette
	var pal color.Palette
	if palette != nil {
		pal = palette.ColorModel()
	} else {
		pal = FallbackPalette().ColorModel()
	}

	// Write PNG signature
	if _, err := w.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10}); err != nil {
		return err
	}

	// Write IHDR chunk
	ihdr := &bytes.Buffer{}
	_ = binary.Write(ihdr, binary.BigEndian, uint32(f.Width))
	_ = binary.Write(ihdr, binary.BigEndian, uint32(f.Height))
	_ = binary.Write(ihdr, binary.BigEndian, uint8(8)) // bit depth
	_ = binary.Write(ihdr, binary.BigEndian, uint8(3)) // color type (indexed)
	_ = binary.Write(ihdr, binary.BigEndian, uint8(0)) // compression
	_ = binary.Write(ihdr, binary.BigEndian, uint8(0)) // filter
	_ = binary.Write(ihdr, binary.BigEndian, uint8(0)) // interlace
	if err := writeChunk(w, "IHDR", ihdr.Bytes()); err != nil {
		return err
	}

	// Write PLTE chunk (palette)
	plte := &bytes.Buffer{}
	for _, c := range pal {
		r, g, b, _ := c.RGBA()
		plte.WriteByte(byte(r >> 8))
		plte.WriteByte(byte(g >> 8))
		plte.WriteByte(byte(b >> 8))
	}
	if err := writeChunk(w, "PLTE", plte.Bytes()); err != nil {
		return err
	}

	// Write tRNS chunk (transparency)
	trns := make([]byte, len(pal))
	for i := range trns {
		if i == int(f.TransparencyIndex) {
			trns[i] = 0 // Transparent
		} else {
			trns[i] = 255 // Opaque
		}
	}
	if err := writeChunk(w, "tRNS", trns); err != nil {
		return err
	}

	// Encode image to get IDAT data
	img := f.ToImage(palette)
	pngBuf := &bytes.Buffer{}
	if err := png.Encode(pngBuf, img); err != nil {
		return err
	}

	// Extract and write IDAT chunks
	idatData, err := extractAllIDAT(pngBuf.Bytes())
	if err != nil {
		return err
	}
	if err := writeChunk(w, "IDAT", idatData); err != nil {
		return err
	}

	// Write IEND chunk
	return writeChunk(w, "IEND", nil)
}

// ToAPNG converts a sequence to an animated PNG (APNG) format
// ToAPNG converts a sequence to an animated PNG (APNG) format
func (s *Sequence) ToAPNG(palette *Palette, w io.Writer) error {
	if len(s.Frames) == 0 {
		return fmt.Errorf("no frames in sequence")
	}

	// For single frame, just write PNG
	if len(s.Frames) == 1 {
		return s.Frames[0].ToPNG(palette, w)
	}

	// Calculate canvas dimensions using same logic as GIF
	var minX, minY, maxX, maxY int16
	for i, frame := range s.Frames {
		if frame == nil {
			continue
		}
		left := -frame.OriginX
		top := -frame.OriginY
		right := int16(frame.Width) - frame.OriginX
		bottom := int16(frame.Height) - frame.OriginY

		if i == 0 || left < minX {
			minX = left
		}
		if i == 0 || top < minY {
			minY = top
		}
		if i == 0 || right > maxX {
			maxX = right
		}
		if i == 0 || bottom > maxY {
			maxY = bottom
		}
	}

	canvasWidth := int(maxX - minX)
	canvasHeight := int(maxY - minY)

	// Get transparency index from first frame
	transparencyIndex := uint8(0)
	if len(s.Frames) > 0 && s.Frames[0] != nil {
		transparencyIndex = s.Frames[0].TransparencyIndex
	}

	// Build palette
	var pal color.Palette
	if palette != nil {
		pal = palette.ColorModel()
	} else {
		pal = FallbackPalette().ColorModel()
	}

	// Write PNG signature
	if _, err := w.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10}); err != nil {
		return err
	}

	// Write IHDR chunk
	ihdr := &bytes.Buffer{}
	_ = binary.Write(ihdr, binary.BigEndian, uint32(canvasWidth))
	_ = binary.Write(ihdr, binary.BigEndian, uint32(canvasHeight))
	_ = binary.Write(ihdr, binary.BigEndian, uint8(8)) // bit depth
	_ = binary.Write(ihdr, binary.BigEndian, uint8(3)) // color type (indexed)
	_ = binary.Write(ihdr, binary.BigEndian, uint8(0)) // compression
	_ = binary.Write(ihdr, binary.BigEndian, uint8(0)) // filter
	_ = binary.Write(ihdr, binary.BigEndian, uint8(0)) // interlace
	if err := writeChunk(w, "IHDR", ihdr.Bytes()); err != nil {
		return err
	}

	// Write acTL chunk (animation control) - MUST come before IDAT
	actl := &bytes.Buffer{}
	_ = binary.Write(actl, binary.BigEndian, uint32(len(s.Frames))) // num_frames
	_ = binary.Write(actl, binary.BigEndian, uint32(0))             // num_plays (0 = infinite)
	if err := writeChunk(w, "acTL", actl.Bytes()); err != nil {
		return err
	}

	// Write PLTE chunk (palette)
	plte := &bytes.Buffer{}
	for _, c := range pal {
		r, g, b, _ := c.RGBA()
		_ = plte.WriteByte(byte(r >> 8))
		_ = plte.WriteByte(byte(g >> 8))
		_ = plte.WriteByte(byte(b >> 8))
	}
	if err := writeChunk(w, "PLTE", plte.Bytes()); err != nil {
		return err
	}

	// Write tRNS chunk (transparency) - index 0 is fully transparent
	trns := make([]byte, len(pal))
	for i := range trns {
		if i == int(transparencyIndex) {
			trns[i] = 0 // Index 0 is transparent
		} else {
			trns[i] = 255 // All others opaque
		}
	}
	if err := writeChunk(w, "tRNS", trns); err != nil {
		return err
	}

	sequenceNumber := uint32(0)

	// Write frames
	for frameIdx, frame := range s.Frames {
		if frame == nil {
			continue
		}

		// Calculate frame position on canvas
		offsetX := int(-minX) - int(frame.OriginX)
		offsetY := int(-minY) - int(frame.OriginY)

		// Create canvas for this frame
		canvas := image.NewPaletted(
			image.Rect(0, 0, canvasWidth, canvasHeight),
			pal,
		)

		// Fill with transparent pixels
		for i := range canvas.Pix {
			canvas.Pix[i] = transparencyIndex
		}

		// Copy frame pixels to canvas
		frameImg := frame.ToImage(palette)

		for y := 0; y < int(frame.Height); y++ {
			for x := 0; x < int(frame.Width); x++ {
				canvasX := x + offsetX
				canvasY := y + offsetY
				if canvasX >= 0 && canvasX < canvasWidth && canvasY >= 0 && canvasY < canvasHeight {
					srcIdx := y*int(frame.Width) + x
					dstIdx := canvasY*canvasWidth + canvasX
					canvas.Pix[dstIdx] = frameImg.Pix[srcIdx]
				}
			}
		}

		// Calculate delay
		delay := uint16((frame.Duration * 100) / 30)
		if delay == 0 {
			delay = 10 // Default ~100ms (10/100 = 0.1s)
		}

		// Write fcTL chunk (frame control)
		fctl := &bytes.Buffer{}
		_ = binary.Write(fctl, binary.BigEndian, sequenceNumber)       // sequence_number
		_ = binary.Write(fctl, binary.BigEndian, uint32(canvasWidth))  // width (full canvas)
		_ = binary.Write(fctl, binary.BigEndian, uint32(canvasHeight)) // height (full canvas)
		_ = binary.Write(fctl, binary.BigEndian, uint32(0))            // x_offset (always 0 for full canvas)
		_ = binary.Write(fctl, binary.BigEndian, uint32(0))            // y_offset (always 0 for full canvas)
		_ = binary.Write(fctl, binary.BigEndian, delay)                // delay_num
		_ = binary.Write(fctl, binary.BigEndian, uint16(100))          // delay_den
		_ = binary.Write(fctl, binary.BigEndian, uint8(1))             // dispose_op (1 = source, replace)
		_ = binary.Write(fctl, binary.BigEndian, uint8(0))             // blend_op (0 = clear to transparency)
		if err := writeChunk(w, "fcTL", fctl.Bytes()); err != nil {
			return err
		}
		sequenceNumber++

		// Encode full canvas
		var pngBuf bytes.Buffer
		encoder := png.Encoder{CompressionLevel: png.NoCompression}
		if err := encoder.Encode(&pngBuf, canvas); err != nil {
			return err
		}

		// Extract ALL IDAT data from PNG (can be multiple chunks)
		// fmt.Printf("Frame %d: Extracting IDAT chunks\n", frameIdx)
		pngData := pngBuf.Bytes()
		var idatData []byte
		pos := 0

		for {
			idx := bytes.Index(pngData[pos:], []byte("IDAT"))
			if idx < 0 {
				break
			}
			idx += pos

			if idx < 4 {
				return fmt.Errorf("invalid IDAT position in frame %d", frameIdx)
			}

			// Get length (4 bytes before "IDAT")
			length := binary.BigEndian.Uint32(pngData[idx-4 : idx])
			// Get data (after "IDAT" type)
			chunkData := pngData[idx+4 : idx+4+int(length)]
			idatData = append(idatData, chunkData...)
			// fmt.Printf("  IDAT chunk at pos %d, length %d\n", idx, length)

			// Move past this chunk (length + type + data + CRC)
			pos = idx + 4 + int(length) + 4
		}

		if len(idatData) == 0 {
			return fmt.Errorf("no IDAT chunks found in frame %d", frameIdx)
		}
		// First frame uses IDAT, subsequent frames use fdAT
		if frameIdx == 0 {
			if err := writeChunk(w, "IDAT", idatData); err != nil {
				return err
			}
		} else {
			fdat := &bytes.Buffer{}
			_ = binary.Write(fdat, binary.BigEndian, sequenceNumber) // sequence_number
			_, _ = fdat.Write(idatData)
			if err := writeChunk(w, "fdAT", fdat.Bytes()); err != nil {
				return err
			}
			sequenceNumber++
		}
	}

	// Write IEND chunk
	return writeChunk(w, "IEND", nil)
}

// writeChunk writes a PNG chunk with length, type, data, and CRC
func writeChunk(w io.Writer, chunkType string, data []byte) error {
	// Length
	if err := binary.Write(w, binary.BigEndian, uint32(len(data))); err != nil {
		return err
	}

	// Type + Data for CRC calculation
	typeAndData := append([]byte(chunkType), data...)

	// Type
	if _, err := w.Write([]byte(chunkType)); err != nil {
		return err
	}

	// Data
	if data != nil {
		if _, err := w.Write(data); err != nil {
			return err
		}
	}

	// CRC
	crc := crc32.ChecksumIEEE(typeAndData)
	return binary.Write(w, binary.BigEndian, crc)
}

// extractAllIDAT extracts all IDAT chunk data from a PNG file
func extractAllIDAT(pngData []byte) ([]byte, error) {
	var idatData []byte
	pos := 0

	for {
		idx := bytes.Index(pngData[pos:], []byte("IDAT"))
		if idx < 0 {
			break
		}
		idx += pos

		if idx < 4 {
			return nil, fmt.Errorf("invalid IDAT position")
		}

		// Get length (4 bytes before "IDAT")
		length := binary.BigEndian.Uint32(pngData[idx-4 : idx])
		// Get data (after "IDAT" type)
		chunkData := pngData[idx+4 : idx+4+int(length)]
		idatData = append(idatData, chunkData...)

		// Move past this chunk (length + type + data + CRC)
		pos = idx + 4 + int(length) + 4
	}

	if len(idatData) == 0 {
		return nil, fmt.Errorf("no IDAT chunks found")
	}

	return idatData, nil
}
