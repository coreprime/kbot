package gaf

import (
	"encoding/binary"
	"fmt"
	"image/color"
	"io"
	"os"
)

// Palette represents a TA color palette
type Palette struct {
	Colors [256]color.RGBA
}

// LoadPalette loads a TA .PAL palette file
func LoadPalette(path string) (*Palette, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()

	return ReadPalette(file)
}

// ReadPalette reads a palette from an io.Reader
func ReadPalette(r io.Reader) (*Palette, error) {
	p := &Palette{}

	// TA palette files are 1024 bytes (256 colors * 4 bytes RGBA)
	// Format is R, G, B, A (alpha is usually ignored/0)
	for i := 0; i < 256; i++ {
		var rgba [4]byte
		if err := binary.Read(r, binary.LittleEndian, &rgba); err != nil {
			return nil, fmt.Errorf("failed to read color %d: %w", i, err)
		}

		p.Colors[i] = color.RGBA{
			R: rgba[0],
			G: rgba[1],
			B: rgba[2],
			A: 255, // Always opaque (alpha channel in file is ignored)
		}
	}

	// Color 0 is always transparent
	p.Colors[0].A = 0

	return p, nil
}

// ColorModel returns a color.Palette for this palette
func (p *Palette) ColorModel() color.Palette {
	palette := make(color.Palette, 256)
	for i := 0; i < 256; i++ {
		palette[i] = p.Colors[i]
	}
	return palette
}

// FallbackPalette returns a greyscale palette for when no real palette is available.
func FallbackPalette() *Palette {
	p := &Palette{}
	p.Colors[0] = color.RGBA{0, 0, 0, 0}
	for i := 1; i < 256; i++ {
		v := uint8(i)
		p.Colors[i] = color.RGBA{v, v, v, 255}
	}
	return p
}

// LoadPaletteFromBytes loads a palette from a byte slice.
func LoadPaletteFromBytes(data []byte) (*Palette, error) {
	if len(data) != 1024 {
		return nil, fmt.Errorf("invalid palette size: expected 1024 bytes, got %d", len(data))
	}
	
	p := &Palette{}
	for i := 0; i < 256; i++ {
		offset := i * 4
		p.Colors[i] = color.RGBA{
			R: data[offset],
			G: data[offset+1],
			B: data[offset+2],
			A: 255, // TA palettes don't use alpha, always opaque
		}
	}
	
	// Make color 0 transparent
	p.Colors[0].A = 0
	
	return p, nil
}


