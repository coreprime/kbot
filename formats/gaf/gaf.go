// Package gaf implements reading and writing of Total Annihilation GAF (Graphics Animation Format) files.
package gaf

import (
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"io"
	"os"
)

// Standard GAF version
const VersionTA = 0x00010100

// isSupportedGAFVersion reports whether a header version field is recognised.
// Cavedog shipped a handful of stock GAFs (e.g. anims/terrain.gaf,
// anims/vismasks.gaf) with the version field set to zero; original TA tooling
// like Kinboat treats the field as opaque and reads them fine.
func isSupportedGAFVersion(v uint32) bool {
	return v == VersionTA || v == 0
}

// Header represents the GAF file header (12 bytes)
type Header struct {
	Version       uint32 // Always 0x00010100
	SequenceCount uint32 // Number of animation sequences
	Unknown1      uint32 // Always 0
}

// SequenceHeader represents an animation sequence header (40 bytes)
type SequenceHeader struct {
	FrameCount uint16   // Number of frames
	Unknown1   uint16   // Unknown
	Unknown2   uint32   // Unknown
	Name       [32]byte // Sequence name (null-terminated)
}

// FrameListItem describes a frame entry (8 bytes)
type FrameListItem struct {
	PtrFrameInfo uint32 // Pointer to frame info
	Duration     uint32 // Duration in game ticks (1/30th second)
}

// FrameInfo describes frame properties (24 bytes)
type FrameInfo struct {
	Width             uint16 // Frame width
	Height            uint16 // Frame height
	OriginX           int16  // X origin offset
	OriginY           int16  // Y origin offset
	TransparencyIndex uint8  // Transparent color index
	Compressed        uint8  // 0=uncompressed, 1=compressed
	LayerCount        uint16 // Number of subframes (0 for simple frames)
	Unknown2          uint32 // Unknown
	PtrFrameData      uint32 // Pointer to pixel data
	Unknown3          uint32 // Unknown
}

// Sequence represents a complete animation sequence
type Sequence struct {
	Name   string
	Frames []*Frame
}

// Frame represents a single animation frame
type Frame struct {
	Width             uint16
	Height            uint16
	OriginX           int16
	OriginY           int16
	TransparencyIndex uint8
	Duration          uint32 // In game ticks (1/30th second)
	Pixels            []byte // Palette indices
}

// Reader reads GAF files
type Reader struct {
	file   io.ReadSeeker
	header Header
}

// OpenReader opens a GAF file for reading
// NewReader creates a new Reader from an io.ReadSeeker
func LoadFromReader(rs io.ReadSeeker) (*Reader, error) {
	r := &Reader{file: rs}

	// Read header
	if err := binary.Read(rs, binary.LittleEndian, &r.header); err != nil {
		return nil, fmt.Errorf("failed to read GAF header: %w", err)
	}

	// Validate version
	if !isSupportedGAFVersion(r.header.Version) {
		return nil, fmt.Errorf("unsupported GAF version: 0x%08X", r.header.Version)
	}

	return r, nil
}

func LoadFromFile(path string) (*Reader, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	r := &Reader{file: file}

	// Read header
	if err := binary.Read(file, binary.LittleEndian, &r.header); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("failed to read GAF header: %w", err)
	}

	// Validate version
	if !isSupportedGAFVersion(r.header.Version) {
		_ = file.Close()
		return nil, fmt.Errorf("unsupported GAF version: 0x%08X (expected 0x%08X)", r.header.Version, VersionTA)
	}

	return r, nil
}

// Close closes the reader
func (r *Reader) Close() error {
	if r.file != nil {
		if closer, ok := r.file.(io.Closer); ok {
			return closer.Close()
		}
	}
	return nil
}

// Header returns the file header
func (r *Reader) Header() *Header {
	return &r.header
}

// ReadSequences reads all animation sequences from the file
func (r *Reader) ReadSequences() ([]*Sequence, error) {
	// Seek to sequence pointers (after 12-byte header)
	if _, err := r.file.Seek(12, io.SeekStart); err != nil {
		return nil, err
	}

	// Read sequence pointers
	pointers := make([]uint32, r.header.SequenceCount)
	for i := uint32(0); i < r.header.SequenceCount; i++ {
		if err := binary.Read(r.file, binary.LittleEndian, &pointers[i]); err != nil {
			return nil, fmt.Errorf("failed to read sequence pointer %d: %w", i, err)
		}
	}

	// Read each sequence
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

// readSequence reads a single sequence at the given offset
func (r *Reader) readSequence(offset uint32) (*Sequence, error) {
	// Seek to sequence header
	if _, err := r.file.Seek(int64(offset), io.SeekStart); err != nil {
		return nil, err
	}

	// Read sequence header
	var sh SequenceHeader
	if err := binary.Read(r.file, binary.LittleEndian, &sh); err != nil {
		return nil, fmt.Errorf("failed to read sequence header: %w", err)
	}

	name := nullTerminatedString(sh.Name[:])

	// Read frame list items
	frameListItems := make([]FrameListItem, sh.FrameCount)
	for i := uint16(0); i < sh.FrameCount; i++ {
		if err := binary.Read(r.file, binary.LittleEndian, &frameListItems[i]); err != nil {
			return nil, fmt.Errorf("failed to read frame list item %d: %w", i, err)
		}
	}

	// Read all frames
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

// readFrame reads a single frame at the given offset
func (r *Reader) readFrame(offset uint32, duration uint32) (*Frame, error) {
	// Seek to frame info
	if _, err := r.file.Seek(int64(offset), io.SeekStart); err != nil {
		return nil, err
	}

	// Read frame info
	var fi FrameInfo
	if err := binary.Read(r.file, binary.LittleEndian, &fi); err != nil {
		return nil, fmt.Errorf("failed to read frame info: %w", err)
	}

	// Handle subframes (layers)
	if fi.LayerCount > 0 {
		// Sanity check: LayerCount should be reasonable (< 100 layers is sane)
		if fi.LayerCount > 100 {
			return nil, fmt.Errorf("invalid layer count %d (possibly corrupt file)", fi.LayerCount)
		}

		// Read inline layer FrameInfo structures (not pointers)
		layerFrames := make([]FrameInfo, fi.LayerCount)
		for i := uint16(0); i < fi.LayerCount; i++ {
			if err := binary.Read(r.file, binary.LittleEndian, &layerFrames[i]); err != nil {
				return nil, fmt.Errorf("failed to read layer %d frame info: %w", i, err)
			}
		}

		// Read the first layer (multi-layer compositing not yet supported).
		firstLayer := &layerFrames[0]
		return r.readSimpleFrame(firstLayer, fi.TransparencyIndex, duration)
	}

	return r.readSimpleFrame(&fi, fi.TransparencyIndex, duration)
}

// readSimpleFrame reads pixel data for a simple (non-layered) frame
func (r *Reader) readSimpleFrame(fi *FrameInfo, transparencyIndex uint8, duration uint32) (*Frame, error) {
	// Seek to pixel data (PtrFrameData is absolute offset)
	if _, err := r.file.Seek(int64(fi.PtrFrameData), io.SeekStart); err != nil {
		return nil, fmt.Errorf("failed to seek to pixel data at offset 0x%X: %w", fi.PtrFrameData, err)
	}

	// Read pixel data
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

// readUncompressed reads uncompressed pixel data
func (r *Reader) readUncompressed(width, height uint16) ([]byte, error) {
	size := int(width) * int(height)
	pixels := make([]byte, size)
	if _, err := io.ReadFull(r.file, pixels); err != nil {
		return nil, fmt.Errorf("failed to read uncompressed pixels: %w", err)
	}
	return pixels, nil
}

// readCompressed reads compressed pixel data (row-based compression)
func (r *Reader) readCompressed(width, height uint16, transparencyIndex uint8) ([]byte, error) {
	pixels := make([]byte, int(width)*int(height))
	pos := 0

	// Process each row
	for row := uint16(0); row < height; row++ {
		// Read row size (2 bytes)
		var rowSize uint16
		if err := binary.Read(r.file, binary.LittleEndian, &rowSize); err != nil {
			return nil, fmt.Errorf("failed to read row %d size: %w", row, err)
		}

		// Read compressed row data
		compressedRow := make([]byte, rowSize)
		if _, err := io.ReadFull(r.file, compressedRow); err != nil {
			return nil, fmt.Errorf("failed to read compressed row %d: %w", row, err)
		}

		// Decompress row
		rowPos := 0
		bytesLeft := int(width)
		i := 0

		for i < len(compressedRow) && bytesLeft > 0 {
			mask := compressedRow[i]
			i++

			if (mask & 0x01) != 0 {
				// Transparent pixels
				count := int(mask >> 1)
				if count > bytesLeft {
					count = bytesLeft
				}
				for j := 0; j < count; j++ {
					pixels[pos+rowPos] = transparencyIndex
					rowPos++
				}
				bytesLeft -= count
			} else if (mask & 0x02) != 0 {
				// RLE: repeat next byte
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
			} else {
				// Copy literal bytes
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

		// Fill any remaining bytes in row with transparency
		for bytesLeft > 0 {
			pixels[pos+rowPos] = transparencyIndex
			rowPos++
			bytesLeft--
		}

		pos += int(width)
	}

	return pixels, nil
}

// ToImage converts a frame to an image.Image using the TA palette
func (f *Frame) ToImage(palette *Palette) *image.Paletted {
	var pal color.Palette
	if palette != nil {
		pal = palette.ColorModel()
	} else {
		pal = FallbackPalette().ColorModel()
	}

	// Set transparency in palette for GIF encoding
	// Go's gif package detects transparent index by finding color.Transparent in palette
	palCopy := make(color.Palette, len(pal))
	copy(palCopy, pal)
	palCopy[f.TransparencyIndex] = color.Transparent
	pal = palCopy

	img := image.NewPaletted(
		image.Rect(0, 0, int(f.Width), int(f.Height)),
		pal,
	)

	// Validate pixel data matches frame dimensions
	expectedSize := int(f.Width) * int(f.Height)
	if len(f.Pixels) != expectedSize {
		// Pixel data doesn't match dimensions - this can happen with corrupt/unusual GAF files
		// Resize or pad the pixel buffer to match
		if len(f.Pixels) < expectedSize {
			// Pad with transparent pixels (index 0)
			padded := make([]byte, expectedSize)
			copy(padded, f.Pixels)
			// Fill rest with transparency index
			for i := len(f.Pixels); i < expectedSize; i++ {
				padded[i] = f.TransparencyIndex
			}
			copy(img.Pix, padded)
		} else {
			// Truncate excess pixels
			copy(img.Pix, f.Pixels[:expectedSize])
		}
	} else {
		copy(img.Pix, f.Pixels)
	}

	return img
}

// ToGIF converts a sequence to an animated GIF
func (s *Sequence) ToGIF(palette *Palette) (*gif.GIF, error) {
	if len(s.Frames) == 0 {
		return nil, fmt.Errorf("no frames in sequence")
	}

	// Calculate bounding box that contains all frames when positioned by their origins
	// OriginX/OriginY represent the "hotspot" center point of each frame
	var minX, minY, maxX, maxY int16
	for i, frame := range s.Frames {
		if frame == nil {
			continue
		}
		// Frame extends from (-OriginX, -OriginY) to (Width-OriginX, Height-OriginY)
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

	if canvasWidth <= 0 || canvasHeight <= 0 {
		return nil, fmt.Errorf("no valid frames with non-zero dimensions")
	}

	var pal color.Palette
	if palette != nil {
		pal = palette.ColorModel()
	} else {
		pal = FallbackPalette().ColorModel()
	}

	// Set transparency in palette for GIF encoding
	// Go's gif package detects transparent index by finding color.Transparent in palette
	palCopy := make(color.Palette, len(pal))
	copy(palCopy, pal)
	palCopy[transparencyIndex] = color.Transparent
	pal = palCopy

	g := &gif.GIF{
		Image: make([]*image.Paletted, 0, len(s.Frames)),
		Delay: make([]int, 0, len(s.Frames)),
		Config: image.Config{
			Width:      canvasWidth,
			Height:     canvasHeight,
			ColorModel: pal,
		},
	}

	for i, frame := range s.Frames {
		// Validate frame has data
		if frame == nil {
			return nil, fmt.Errorf("frame %d is nil", i)
		}
		if frame.Width == 0 || frame.Height == 0 {
			return nil, fmt.Errorf("frame %d has invalid dimensions: %dx%d", i, frame.Width, frame.Height)
		}

		// Create canvas
		canvas := image.NewPaletted(
			image.Rect(0, 0, canvasWidth, canvasHeight),
			pal,
		)

		// Fill with transparency (index 0)
		for i := range canvas.Pix {
			canvas.Pix[i] = transparencyIndex
		}

		// Get frame image
		frameImg := frame.ToImage(palette)

		// Position frame on canvas
		// Frame's top-left is at (-OriginX, -OriginY) relative to hotspot
		// Canvas has hotspot at (-minX, -minY)
		xOffset := int(-frame.OriginX - minX)
		yOffset := int(-frame.OriginY - minY)

		// Copy frame pixels to canvas at the correct position
		for y := 0; y < int(frame.Height); y++ {
			for x := 0; x < int(frame.Width); x++ {
				canvasX := x + xOffset
				canvasY := y + yOffset

				// Ensure we're within canvas bounds
				if canvasX >= 0 && canvasX < canvasWidth && canvasY >= 0 && canvasY < canvasHeight {
					srcIdx := y*int(frame.Width) + x
					dstIdx := canvasY*canvasWidth + canvasX

					if srcIdx < len(frameImg.Pix) && dstIdx < len(canvas.Pix) {
						canvas.Pix[dstIdx] = frameImg.Pix[srcIdx]
					}
				}
			}
		}

		g.Image = append(g.Image, canvas)

		// Duration is in game ticks (1/30th second)
		// GIF delay is in 1/100th second
		// So: delay = duration * (100/30) = duration * 10 / 3
		delay := int(frame.Duration) * 10 / 3
		if delay < 1 {
			delay = 3 // 30ms minimum (roughly 30 FPS)
		}
		g.Delay = append(g.Delay, delay)
	}

	return g, nil
}

// WriteGIF writes an animated GIF to the given writer
func (s *Sequence) WriteGIF(w io.Writer, palette *Palette) error {
	g, err := s.ToGIF(palette)
	if err != nil {
		return err
	}
	return gif.EncodeAll(w, g)
}

// nullTerminatedString converts a null-terminated byte array to a string
func nullTerminatedString(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
