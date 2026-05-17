// Package fnt implements reading of Total Annihilation bitmap font files.
//
// FNT files contain 1-bit-per-pixel glyph data for up to 256 characters.
// Format:
//   - 2 bytes: uint16 glyph height (all glyphs share the same height)
//   - 2 bytes: uint16 unknown/flags
//   - 256 × 2 bytes: uint16 offset table (offset from file start to each glyph, 0 = not present)
//   - Glyph data: for each glyph at its offset:
//     - 1 byte: pixel width
//     - ceil(width * height / 8) bytes: 1bpp pixel data, MSB-first continuous bit stream
package fnt

import (
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
)

// Glyph is a single character's bitmap data.
type Glyph struct {
	Char   int     // Character code (0-255)
	Width  int     // Pixel width
	Height int     // Pixel height (same as font height)
	Pixels []bool  // Width × Height pixel values (true = set)
}

// Font is a parsed FNT file.
type Font struct {
	Height  int       // Glyph height in pixels
	Flags   uint16    // Unknown flags field
	Glyphs  [256]*Glyph // Glyph for each character (nil if not present)
}

// GlyphCount returns the number of defined glyphs.
func (f *Font) GlyphCount() int {
	n := 0
	for _, g := range f.Glyphs {
		if g != nil {
			n++
		}
	}
	return n
}

// LoadFromReader parses an FNT file.
func LoadFromReader(r io.ReadSeeker) (*Font, error) {
	f := &Font{}

	var height, flags uint16
	if err := binary.Read(r, binary.LittleEndian, &height); err != nil {
		return nil, fmt.Errorf("failed to read font height: %w", err)
	}
	if err := binary.Read(r, binary.LittleEndian, &flags); err != nil {
		return nil, fmt.Errorf("failed to read font flags: %w", err)
	}
	f.Height = int(height)
	f.Flags = flags

	if f.Height <= 0 || f.Height > 128 {
		return nil, fmt.Errorf("invalid font height: %d", f.Height)
	}

	// Read 256 offsets.
	var offsets [256]uint16
	if err := binary.Read(r, binary.LittleEndian, &offsets); err != nil {
		return nil, fmt.Errorf("failed to read offset table: %w", err)
	}

	// Read the entire remaining data for random access to glyph data.
	_, _ = r.Seek(0, io.SeekCurrent)
	endPos, _ := r.Seek(0, io.SeekEnd)
	fileSize := int(endPos)
	allData := make([]byte, fileSize)
	_, _ = r.Seek(0, io.SeekStart)
	_, _ = io.ReadFull(r, allData)

	for ch := 0; ch < 256; ch++ {
		off := int(offsets[ch])
		if off == 0 || off >= len(allData) {
			continue
		}

		w := int(allData[off])
		if w <= 0 || w > 128 {
			continue
		}

		totalBits := w * f.Height
		totalBytes := (totalBits + 7) / 8
		dataStart := off + 1
		if dataStart+totalBytes > len(allData) {
			continue
		}

		bitData := allData[dataStart : dataStart+totalBytes]
		pixels := make([]bool, w*f.Height)

		bitIdx := 0
		for y := 0; y < f.Height; y++ {
			for x := 0; x < w; x++ {
				bytePos := bitIdx / 8
				bitPos := 7 - (bitIdx % 8) // MSB first
				if bytePos < len(bitData) {
					pixels[y*w+x] = (bitData[bytePos]>>uint(bitPos))&1 == 1
				}
				bitIdx++
			}
		}

		f.Glyphs[ch] = &Glyph{
			Char:   ch,
			Width:  w,
			Height: f.Height,
			Pixels: pixels,
		}
	}

	return f, nil
}

// RenderGlyph renders a single glyph as an RGBA image.
func (g *Glyph) RenderImage(fg, bg color.Color) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, g.Width, g.Height))
	for y := 0; y < g.Height; y++ {
		for x := 0; x < g.Width; x++ {
			if g.Pixels[y*g.Width+x] {
				img.Set(x, y, fg)
			} else {
				img.Set(x, y, bg)
			}
		}
	}
	return img
}

// RenderSheet renders all glyphs as a sprite sheet (16 columns).
func (f *Font) RenderSheet(fg, bg color.Color) *image.RGBA {
	cols := 16
	maxW := 0
	for _, g := range f.Glyphs {
		if g != nil && g.Width > maxW {
			maxW = g.Width
		}
	}
	if maxW == 0 {
		maxW = 8
	}
	cellW := maxW + 2
	cellH := f.Height + 2
	rows := (256 + cols - 1) / cols // 16 rows

	img := image.NewRGBA(image.Rect(0, 0, cols*cellW, rows*cellH))
	// Fill with background.
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			img.Set(x, y, bg)
		}
	}

	for ch := 0; ch < 256; ch++ {
		g := f.Glyphs[ch]
		if g == nil {
			continue
		}
		col := ch % cols
		row := ch / cols
		ox := col*cellW + 1
		oy := row*cellH + 1
		for y := 0; y < g.Height; y++ {
			for x := 0; x < g.Width; x++ {
				if g.Pixels[y*g.Width+x] {
					img.Set(ox+x, oy+y, fg)
				}
			}
		}
	}
	return img
}

// RenderText renders a string using this font.
func (f *Font) RenderText(text string, fg, bg color.Color) *image.RGBA {
	// Calculate total width.
	totalW := 0
	for _, ch := range text {
		g := f.Glyphs[int(ch)%256]
		if g != nil {
			totalW += g.Width + 1
		} else {
			totalW += f.Height/2 + 1
		}
	}
	if totalW <= 0 {
		totalW = 1
	}

	img := image.NewRGBA(image.Rect(0, 0, totalW, f.Height))
	for y := 0; y < f.Height; y++ {
		for x := 0; x < totalW; x++ {
			img.Set(x, y, bg)
		}
	}

	cx := 0
	for _, ch := range text {
		g := f.Glyphs[int(ch)%256]
		if g != nil {
			for y := 0; y < g.Height; y++ {
				for x := 0; x < g.Width; x++ {
					if g.Pixels[y*g.Width+x] {
						img.Set(cx+x, y, fg)
					}
				}
			}
			cx += g.Width + 1
		} else {
			cx += f.Height/2 + 1
		}
	}
	return img
}

// WritePNG encodes an image to PNG.
func WritePNG(w io.Writer, img image.Image) error {
	return png.Encode(w, img)
}
