package tsf

import (
	"encoding/binary"
	"fmt"
	"image"
)

// ToNRGBA decodes the frame's 16-bit pixels into a non-premultiplied RGBA
// image. Channels are expanded to 8 bits by bit replication, which makes the
// inverse (PixelsFromNRGBA) exactly reversible.
func (f *Frame) ToNRGBA() (*image.NRGBA, error) {
	if err := f.validate(); err != nil {
		return nil, err
	}
	img := image.NewNRGBA(image.Rect(0, 0, int(f.Width), int(f.Height)))
	n := int(f.Width) * int(f.Height)
	for i := 0; i < n; i++ {
		v := binary.LittleEndian.Uint16(f.Pixels[i*2:])
		r, g, b, a := decodePixel(v, f.Format)
		o := i * 4
		img.Pix[o+0] = r
		img.Pix[o+1] = g
		img.Pix[o+2] = b
		img.Pix[o+3] = a
	}
	return img, nil
}

// PixelsFromNRGBA encodes a non-premultiplied RGBA image into packed 16-bit
// pixels in the requested format. It is the exact inverse of ToNRGBA for any
// image that ToNRGBA produced.
func PixelsFromNRGBA(img *image.NRGBA, format PixelFormat) ([]byte, error) {
	if format != FormatARGB4444 && format != FormatARGB1555 {
		return nil, fmt.Errorf("invalid pixel format 0x%02X", uint8(format))
	}
	w := img.Rect.Dx()
	h := img.Rect.Dy()
	out := make([]byte, w*h*2)
	idx := 0
	for y := 0; y < h; y++ {
		row := img.PixOffset(img.Rect.Min.X, img.Rect.Min.Y+y)
		for x := 0; x < w; x++ {
			o := row + x*4
			v := encodePixel(img.Pix[o+0], img.Pix[o+1], img.Pix[o+2], img.Pix[o+3], format)
			binary.LittleEndian.PutUint16(out[idx:], v)
			idx += 2
		}
	}
	return out, nil
}

func decodePixel(v uint16, format PixelFormat) (r, g, b, a uint8) {
	switch format {
	case FormatARGB1555:
		a1 := (v >> 15) & 0x1
		r5 := (v >> 10) & 0x1f
		g5 := (v >> 5) & 0x1f
		b5 := v & 0x1f
		return expand5(r5), expand5(g5), expand5(b5), expand1(a1)
	default: // FormatARGB4444
		a4 := (v >> 12) & 0xf
		r4 := (v >> 8) & 0xf
		g4 := (v >> 4) & 0xf
		b4 := v & 0xf
		return expand4(r4), expand4(g4), expand4(b4), expand4(a4)
	}
}

func encodePixel(r, g, b, a uint8, format PixelFormat) uint16 {
	switch format {
	case FormatARGB1555:
		return uint16(a>>7)<<15 |
			uint16(r>>3)<<10 |
			uint16(g>>3)<<5 |
			uint16(b>>3)
	default: // FormatARGB4444
		return uint16(a>>4)<<12 |
			uint16(r>>4)<<8 |
			uint16(g>>4)<<4 |
			uint16(b>>4)
	}
}

// expand5 widens a 5-bit channel to 8 bits by bit replication; the inverse is
// a simple right shift by 3.
func expand5(v uint16) uint8 { return uint8(v<<3 | v>>2) }

// expand4 widens a 4-bit channel to 8 bits; the inverse is a right shift by 4.
func expand4(v uint16) uint8 { return uint8(v<<4 | v) }

// expand1 widens a 1-bit alpha to 0 or 255; the inverse is a right shift by 7.
func expand1(v uint16) uint8 {
	if v != 0 {
		return 0xFF
	}
	return 0
}
