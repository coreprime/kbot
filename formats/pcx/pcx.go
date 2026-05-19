// Package pcx provides support for reading and writing PCX image files.
// PCX is a raster image format originally developed by ZSoft Corporation.
package pcx

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"io"
	
	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/formats/gaf"
)

// Header represents the PCX file header
type Header struct {
	Manufacturer byte   // Always 0x0A
	Version      byte   // Version information
	Encoding     byte   // 1 = RLE encoding
	BitsPerPixel byte   // Bits per pixel per plane
	XMin         uint16 // Image dimensions
	YMin         uint16
	XMax         uint16
	YMax         uint16
	HorzDPI      uint16 // Horizontal DPI
	VertDPI      uint16 // Vertical DPI
	Palette      [48]byte
	Reserved     byte
	NumPlanes    byte   // Number of color planes
	BytesPerLine uint16 // Bytes per scan line per plane
	PaletteInfo  uint16 // How to interpret palette (1=color, 2=grayscale)
	HorzScreen   uint16 // Horizontal screen size
	VertScreen   uint16 // Vertical screen size
	Filler       [54]byte
}

// Reader provides methods for reading PCX files
type Reader struct {
	r        io.Reader
	header   Header
	rawData  []byte // Store raw file data for palette extraction
	embedded bool   // Whether file has embedded palette
}

// OpenReader opens a PCX file for reading
func LoadFromReader(r io.Reader) (*Reader, error) {
	// Read entire file to support embedded palettes
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("failed to read PCX data: %w", err)
	}
	
	reader := &Reader{
		r:       bytes.NewReader(data),
		rawData: data,
	}
	
	// Read header
	if err := binary.Read(reader.r, binary.LittleEndian, &reader.header); err != nil {
		return nil, fmt.Errorf("failed to read PCX header: %w", err)
	}
	
	// Validate header
	if reader.header.Manufacturer != 0x0A {
		return nil, fmt.Errorf("invalid PCX file: manufacturer byte is 0x%02X (expected 0x0A)", reader.header.Manufacturer)
	}
	
	// Check for embedded palette (marker 0x0C before last 768 bytes)
	if len(data) >= 769 && data[len(data)-769] == 0x0C {
		reader.embedded = true
	}
	
	return reader, nil
}

// Header returns the PCX file header
func (r *Reader) Header() *Header {
	return &r.header
}

// Width returns the image width
func (r *Reader) Width() int {
	return int(r.header.XMax - r.header.XMin + 1)
}

// Height returns the image height
func (r *Reader) Height() int {
	return int(r.header.YMax - r.header.YMin + 1)
}

// BitsPerPixel returns the total bits per pixel
func (r *Reader) BitsPerPixel() int {
	return int(r.header.BitsPerPixel) * int(r.header.NumPlanes)
}

// Decode decodes the PCX image and returns an image.Image
func (r *Reader) Decode() (image.Image, error) {
	width := r.Width()
	height := r.Height()
	bitsPerPixel := r.BitsPerPixel()
	
	// Create image based on bit depth
	var img image.Image
	var palette color.Palette
	
	if bitsPerPixel == 8 && r.header.NumPlanes == 1 {
		// 8-bit paletted image
		pal, err := r.readPalette()
		if err != nil {
			return nil, err
		}
		palette = pal
		
		paletted := image.NewPaletted(image.Rect(0, 0, width, height), palette)
		
		// Decode RLE data
		if err := r.decodeRLE8(paletted); err != nil {
			return nil, err
		}
		
		img = paletted
	} else if bitsPerPixel == 24 && r.header.NumPlanes == 3 {
		// 24-bit RGB image
		rgba := image.NewRGBA(image.Rect(0, 0, width, height))
		
		if err := r.decodeRLE24(rgba); err != nil {
			return nil, err
		}
		
		img = rgba
	} else {
		return nil, fmt.Errorf("unsupported PCX format: %d bits per pixel, %d planes", r.header.BitsPerPixel, r.header.NumPlanes)
	}
	
	return img, nil
}

// readPalette reads the 256-color palette from the PCX file
func (r *Reader) readPalette() (color.Palette, error) {
	// Check for embedded palette
	if r.embedded && len(r.rawData) >= 769 {
		// Extract palette from end of file (last 768 bytes after 0x0C marker)
		paletteData := r.rawData[len(r.rawData)-768:]
		pal := make(color.Palette, 256)
		
		for i := 0; i < 256; i++ {
			pal[i] = color.RGBA{
				R: paletteData[i*3],
				G: paletteData[i*3+1],
				B: paletteData[i*3+2],
				A: 255,
			}
		}
		
		return pal, nil
	}
	
	// Use embedded TA palette (most TA PCX files use this palette anyway)
	palette, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	if err != nil {
		// Fallback to grayscale if TA palette fails
		pal := make(color.Palette, 256)
		for i := 0; i < 256; i++ {
			v := uint8(i)
			pal[i] = color.RGBA{v, v, v, 255}
		}
		return pal, nil
	}
	
	// Convert gaf.Palette to color.Palette
	colorPalette := make(color.Palette, len(palette.Colors))
	for i, c := range palette.Colors {
		colorPalette[i] = c
	}
	
	return colorPalette, nil
}

// decodeRLE8 decodes an 8-bit RLE-encoded image
func (r *Reader) decodeRLE8(img *image.Paletted) error {
	width := r.Width()
	height := r.Height()
	bytesPerLine := int(r.header.BytesPerLine)
	
	br := bufio.NewReader(r.r)
	scanline := make([]byte, bytesPerLine)
	
	for y := 0; y < height; y++ {
		// Decode one scanline
		x := 0
		for x < bytesPerLine {
			b, err := br.ReadByte()
			if err != nil {
				if err == io.EOF {
					// Hit EOF early - file may be truncated, use what we have
					return nil
				}
				return fmt.Errorf("failed to read RLE data at line %d: %w", y, err)
			}
			
			if (b & 0xC0) == 0xC0 {
				// Run length encoded
				count := int(b & 0x3F)
				value, err := br.ReadByte()
				if err != nil {
					if err == io.EOF {
						// Hit EOF early - file may be truncated
						return nil
					}
					return fmt.Errorf("failed to read RLE value at line %d: %w", y, err)
				}
				
				for i := 0; i < count && x < bytesPerLine; i++ {
					scanline[x] = value
					x++
				}
			} else {
				// Literal byte
				scanline[x] = b
				x++
			}
		}
		
		// Copy scanline to image
		for x := 0; x < width && x < bytesPerLine; x++ {
			img.SetColorIndex(x, y, scanline[x])
		}
	}
	
	return nil
}

// decodeRLE24 decodes a 24-bit RLE-encoded image
func (r *Reader) decodeRLE24(img *image.RGBA) error {
	width := r.Width()
	height := r.Height()
	bytesPerLine := int(r.header.BytesPerLine)
	
	br := bufio.NewReader(r.r)
	
	// Three planes: R, G, B
	rPlane := make([]byte, bytesPerLine)
	gPlane := make([]byte, bytesPerLine)
	bPlane := make([]byte, bytesPerLine)
	
	for y := 0; y < height; y++ {
		// Decode R plane
		if err := r.decodeScanline(br, rPlane); err != nil {
			return fmt.Errorf("failed to decode R plane at line %d: %w", y, err)
		}
		
		// Decode G plane
		if err := r.decodeScanline(br, gPlane); err != nil {
			return fmt.Errorf("failed to decode G plane at line %d: %w", y, err)
		}
		
		// Decode B plane
		if err := r.decodeScanline(br, bPlane); err != nil {
			return fmt.Errorf("failed to decode B plane at line %d: %w", y, err)
		}
		
		// Combine planes into RGB pixels
		for x := 0; x < width && x < bytesPerLine; x++ {
			img.SetRGBA(x, y, color.RGBA{
				R: rPlane[x],
				G: gPlane[x],
				B: bPlane[x],
				A: 255,
			})
		}
	}
	
	return nil
}

// decodeScanline decodes one RLE-encoded scanline
func (r *Reader) decodeScanline(br *bufio.Reader, scanline []byte) error {
	x := 0
	bytesPerLine := len(scanline)
	
	for x < bytesPerLine {
		b, err := br.ReadByte()
		if err != nil {
			return err
		}
		
		if (b & 0xC0) == 0xC0 {
			// Run length encoded
			count := int(b & 0x3F)
			value, err := br.ReadByte()
			if err != nil {
				return err
			}
			
			for i := 0; i < count && x < bytesPerLine; i++ {
				scanline[x] = value
				x++
			}
		} else {
			// Literal byte
			scanline[x] = b
			x++
		}
	}
	
	return nil
}

// ConvertToPNG converts a PCX image to PNG format
func ConvertToPNG(w io.Writer, r io.Reader) error {
	reader, err := LoadFromReader(r)
	if err != nil {
		return err
	}
	
	img, err := reader.Decode()
	if err != nil {
		return err
	}
	
	return png.Encode(w, img)
}

// ConvertToGIF converts a PCX image to GIF format
func ConvertToGIF(w io.Writer, r io.Reader) error {
	reader, err := LoadFromReader(r)
	if err != nil {
		return err
	}
	
	img, err := reader.Decode()
	if err != nil {
		return err
	}
	
	// If already paletted, encode directly
	if paletted, ok := img.(*image.Paletted); ok {
		return gif.Encode(w, paletted, nil)
	}
	
	// Otherwise convert to paletted with 256-color palette
	bounds := img.Bounds()
	
	// Create a simple 256-color palette
	palette := make(color.Palette, 256)
	for i := 0; i < 256; i++ {
		palette[i] = color.RGBA{uint8(i), uint8(i), uint8(i), 255}
	}
	
	paletted := image.NewPaletted(bounds, palette)
	
	// Copy pixels
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			paletted.Set(x, y, img.At(x, y))
		}
	}
	
	return gif.Encode(w, paletted, nil)
}

// ConvertToBMP converts a PCX image to BMP format
func ConvertToBMP(w io.Writer, r io.Reader) error {
	reader, err := LoadFromReader(r)
	if err != nil {
		return err
	}
	
	img, err := reader.Decode()
	if err != nil {
		return err
	}
	
	// Simple BMP encoding
	return encodeBMP(w, img)
}

// encodeBMP encodes an image as BMP
func encodeBMP(w io.Writer, img image.Image) error {
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	
	// Calculate row size (must be multiple of 4)
	rowSize := ((width * 3) + 3) & ^3
	imageSize := rowSize * height
	
	// BMP file header
	fileHeader := []byte{
		'B', 'M', // Signature
		0, 0, 0, 0, // File size (filled below)
		0, 0, 0, 0, // Reserved
		54, 0, 0, 0, // Pixel data offset
	}
	
	// BMP info header
	infoHeader := []byte{
		40, 0, 0, 0, // Header size
		0, 0, 0, 0, // Width (filled below)
		0, 0, 0, 0, // Height (filled below)
		1, 0, // Planes
		24, 0, // Bits per pixel
		0, 0, 0, 0, // Compression
		0, 0, 0, 0, // Image size (filled below)
		0, 0, 0, 0, // X pixels per meter
		0, 0, 0, 0, // Y pixels per meter
		0, 0, 0, 0, // Colors used
		0, 0, 0, 0, // Important colors
	}
	
	// Fill in file size
	fileSize := 54 + imageSize
	binary.LittleEndian.PutUint32(fileHeader[2:], uint32(fileSize))
	
	// Fill in dimensions
	binary.LittleEndian.PutUint32(infoHeader[4:], uint32(width))
	binary.LittleEndian.PutUint32(infoHeader[8:], uint32(height))
	binary.LittleEndian.PutUint32(infoHeader[20:], uint32(imageSize))
	
	// Write headers
	if _, err := w.Write(fileHeader); err != nil {
		return err
	}
	if _, err := w.Write(infoHeader); err != nil {
		return err
	}
	
	// Write pixel data (bottom-up, BGR format)
	padding := make([]byte, rowSize-(width*3))
	
	for y := height - 1; y >= 0; y-- {
		for x := 0; x < width; x++ {
			r, g, b, _ := img.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			// Write BGR
			if _, err := w.Write([]byte{byte(b >> 8), byte(g >> 8), byte(r >> 8)}); err != nil {
				return err
			}
		}
		// Write padding
		if len(padding) > 0 {
			if _, err := w.Write(padding); err != nil {
				return err
			}
		}
	}
	
	return nil
}

// ConvertToGIFWithPalette converts a PCX file to GIF using a custom palette
func ConvertToGIFWithPalette(w io.Writer, r io.Reader, pal *gaf.Palette) error {
	reader, err := LoadFromReader(r)
	if err != nil {
		return err
	}
	
	img, err := reader.Decode()
	if err != nil {
		return err
	}
	
	// Convert GAF palette to color.Palette
	palette := make(color.Palette, 256)
	for i := 0; i < 256; i++ {
		palette[i] = pal.Colors[i]
	}
	
	bounds := img.Bounds()
	paletted := image.NewPaletted(bounds, palette)
	
	// Copy pixels (index mapping)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			paletted.Set(x, y, img.At(x, y))
		}
	}
	
	return gif.Encode(w, paletted, nil)
}

// HasEmbeddedPalette returns true if the PCX file has an embedded 256-color palette
func (r *Reader) HasEmbeddedPalette() bool {
	return r.embedded
}

// EmbeddedPalette returns the 256-color palette embedded at the end of the PCX
// file as a *gaf.Palette. Returns nil if the file does not carry an embedded
// palette (PCX header signals the 0x0C marker before the trailing 768 bytes).
//
// TA: Kingdoms uses sidecar PCX files (often 1x1 px) purely as palette
// containers next to .gaf files, so this is the canonical way to fish the
// palette out without re-decoding the image data.
func (r *Reader) EmbeddedPalette() *gaf.Palette {
	if !r.embedded || len(r.rawData) < 768 {
		return nil
	}
	src := r.rawData[len(r.rawData)-768:]
	p := &gaf.Palette{}
	for i := 0; i < 256; i++ {
		p.Colors[i] = color.RGBA{R: src[i*3], G: src[i*3+1], B: src[i*3+2], A: 255}
	}
	p.Colors[0].A = 0
	return p
}
