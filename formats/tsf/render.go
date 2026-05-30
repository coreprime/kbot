package tsf

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/color/palette"
	"image/draw"
	"image/gif"
	"image/png"
	"io"
)

// ticksPerSecond is the TA: Kingdoms simulation rate; frame durations are
// expressed in these ticks, matching Total Annihilation.
const ticksPerSecond = 30

// CanvasBounds returns the bounding box that contains every frame once each is
// positioned by its origin. The rectangle is expressed in origin space, so its
// Min may be negative; its width and height give the canvas size an animation
// renders into.
func (t *TAF) CanvasBounds() (image.Rectangle, error) {
	if len(t.Frames) == 0 {
		return image.Rectangle{}, fmt.Errorf("tsf: animation has no frames")
	}
	var r image.Rectangle
	for i, f := range t.Frames {
		fr := image.Rect(
			-int(f.OriginX), -int(f.OriginY),
			int(f.Width)-int(f.OriginX), int(f.Height)-int(f.OriginY),
		)
		if i == 0 {
			r = fr
		} else {
			r = r.Union(fr)
		}
	}
	if r.Dx() <= 0 || r.Dy() <= 0 {
		return image.Rectangle{}, fmt.Errorf("tsf: animation has a zero-size canvas")
	}
	return r, nil
}

// FrameImage decodes frame i to a non-premultiplied RGBA image at its own
// dimensions (origin ignored).
func (t *TAF) FrameImage(i int) (*image.NRGBA, error) {
	if i < 0 || i >= len(t.Frames) {
		return nil, fmt.Errorf("tsf: frame index %d out of range (0..%d)", i, len(t.Frames)-1)
	}
	return t.Frames[i].ToNRGBA()
}

// compositeFrame draws frame i onto a fresh canvas of the given bounds,
// positioned by its origin. Pixels outside the frame stay transparent.
func (t *TAF) compositeFrame(i int, bounds image.Rectangle) (*image.NRGBA, error) {
	f := t.Frames[i]
	src, err := f.ToNRGBA()
	if err != nil {
		return nil, err
	}
	canvas := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	x := -int(f.OriginX) - bounds.Min.X
	y := -int(f.OriginY) - bounds.Min.Y
	draw.Draw(canvas, image.Rect(x, y, x+int(f.Width), y+int(f.Height)), src, image.Point{}, draw.Src)
	return canvas, nil
}

// RenderSheet lays every frame out in a grid sprite sheet with cols columns.
// Each cell is sized to the largest frame; smaller frames are anchored
// top-left. When bg is nil the sheet background stays transparent.
func (t *TAF) RenderSheet(cols int, bg color.Color) (*image.NRGBA, error) {
	if len(t.Frames) == 0 {
		return nil, fmt.Errorf("tsf: animation has no frames")
	}
	if cols < 1 {
		cols = 1
	}
	cellW, cellH := 0, 0
	for _, f := range t.Frames {
		if int(f.Width) > cellW {
			cellW = int(f.Width)
		}
		if int(f.Height) > cellH {
			cellH = int(f.Height)
		}
	}
	rows := (len(t.Frames) + cols - 1) / cols
	sheet := image.NewNRGBA(image.Rect(0, 0, cols*cellW, rows*cellH))
	if bg != nil {
		draw.Draw(sheet, sheet.Bounds(), image.NewUniform(bg), image.Point{}, draw.Src)
	}
	for i, f := range t.Frames {
		img, err := f.ToNRGBA()
		if err != nil {
			return nil, err
		}
		cx := (i % cols) * cellW
		cy := (i / cols) * cellH
		draw.Draw(sheet, image.Rect(cx, cy, cx+int(f.Width), cy+int(f.Height)), img, image.Point{}, draw.Over)
	}
	return sheet, nil
}

// ToGIF renders the animation to an animated GIF. The truecolor frames are
// quantised to a 255-colour adaptive table plus a transparent slot, so alpha is
// reduced to a 1-bit cutout — adequate for previews; use ToAPNG to keep the
// full alpha channel.
func (t *TAF) ToGIF() (*gif.GIF, error) {
	bounds, err := t.CanvasBounds()
	if err != nil {
		return nil, err
	}
	w, h := bounds.Dx(), bounds.Dy()
	g := &gif.GIF{
		Image:     make([]*image.Paletted, 0, len(t.Frames)),
		Delay:     make([]int, 0, len(t.Frames)),
		Disposal:  make([]byte, 0, len(t.Frames)),
		Config:    image.Config{Width: w, Height: h, ColorModel: gifPalette()},
		LoopCount: 0,
	}
	for i := range t.Frames {
		canvas, cerr := t.compositeFrame(i, bounds)
		if cerr != nil {
			return nil, cerr
		}
		g.Image = append(g.Image, quantizeNRGBA(canvas))
		g.Delay = append(g.Delay, ticksToCentiseconds(t.Frames[i].Duration))
		g.Disposal = append(g.Disposal, gif.DisposalBackground)
	}
	return g, nil
}

// gifPalette is the shared 256-entry GIF table: index 0 is transparent, the
// remaining 255 come from the standard Plan9 spread.
func gifPalette() color.Palette {
	pal := make(color.Palette, 0, 256)
	pal = append(pal, color.Transparent)
	pal = append(pal, palette.Plan9[:255]...)
	return pal
}

// quantizeNRGBA reduces an NRGBA canvas to a paletted image, mapping pixels
// whose alpha is below the midpoint to the transparent slot.
func quantizeNRGBA(img *image.NRGBA) *image.Paletted {
	p := image.NewPaletted(img.Bounds(), gifPalette())
	draw.FloydSteinberg.Draw(p, img.Bounds(), img, image.Point{})
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if img.NRGBAAt(x, y).A < 128 {
				p.SetColorIndex(x, y, 0)
			}
		}
	}
	return p
}

// ticksToCentiseconds converts a tick duration to GIF's 1/100s delay unit,
// clamping to a sane minimum so zero-duration frames still advance.
func ticksToCentiseconds(ticks uint32) int {
	d := int(ticks) * 100 / ticksPerSecond
	if d < 2 {
		d = 2
	}
	return d
}

var pngSignature = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}

// forceAlpha wraps an NRGBA image so the standard PNG encoder always selects
// the truecolor-alpha colour type (6) instead of dropping the alpha channel for
// fully opaque frames. APNG requires every frame to share one IHDR colour type.
type forceAlpha struct{ *image.NRGBA }

// Opaque always reports false, steering the encoder onto the RGBA path.
func (forceAlpha) Opaque() bool { return false }

// ToAPNG renders the animation to an animated PNG, preserving the full RGBA
// channels (including partial alpha). A single-frame animation is written as a
// plain PNG.
func (t *TAF) ToAPNG(w io.Writer) error {
	bounds, err := t.CanvasBounds()
	if err != nil {
		return err
	}
	cw, ch := bounds.Dx(), bounds.Dy()

	if len(t.Frames) == 1 {
		canvas, cerr := t.compositeFrame(0, bounds)
		if cerr != nil {
			return cerr
		}
		return png.Encode(w, canvas)
	}

	if _, err := w.Write(pngSignature); err != nil {
		return err
	}

	ihdr := &bytes.Buffer{}
	_ = binary.Write(ihdr, binary.BigEndian, uint32(cw))
	_ = binary.Write(ihdr, binary.BigEndian, uint32(ch))
	ihdr.WriteByte(8) // bit depth
	ihdr.WriteByte(6) // colour type: truecolour with alpha
	ihdr.WriteByte(0) // compression
	ihdr.WriteByte(0) // filter
	ihdr.WriteByte(0) // interlace
	if err := writeChunk(w, "IHDR", ihdr.Bytes()); err != nil {
		return err
	}

	actl := &bytes.Buffer{}
	_ = binary.Write(actl, binary.BigEndian, uint32(len(t.Frames)))
	_ = binary.Write(actl, binary.BigEndian, uint32(0)) // play count: infinite
	if err := writeChunk(w, "acTL", actl.Bytes()); err != nil {
		return err
	}

	seq := uint32(0)
	for i := range t.Frames {
		canvas, cerr := t.compositeFrame(i, bounds)
		if cerr != nil {
			return cerr
		}

		delay := uint16(int(t.Frames[i].Duration) * 100 / ticksPerSecond)
		if delay < 2 {
			delay = 2
		}

		fctl := &bytes.Buffer{}
		_ = binary.Write(fctl, binary.BigEndian, seq)
		_ = binary.Write(fctl, binary.BigEndian, uint32(cw))
		_ = binary.Write(fctl, binary.BigEndian, uint32(ch))
		_ = binary.Write(fctl, binary.BigEndian, uint32(0)) // x offset
		_ = binary.Write(fctl, binary.BigEndian, uint32(0)) // y offset
		_ = binary.Write(fctl, binary.BigEndian, delay)
		_ = binary.Write(fctl, binary.BigEndian, uint16(100)) // delay denominator
		fctl.WriteByte(1)                                     // dispose: clear to background
		fctl.WriteByte(0)                                     // blend: source (overwrite)
		if err := writeChunk(w, "fcTL", fctl.Bytes()); err != nil {
			return err
		}
		seq++

		var buf bytes.Buffer
		// forceAlpha keeps every frame encoded as colour type 6 (RGBA) so the
		// extracted IDAT/fdAT streams match the truecolor-alpha IHDR above,
		// regardless of whether an individual frame happens to be opaque.
		if err := png.Encode(&buf, forceAlpha{canvas}); err != nil {
			return err
		}
		idat, err := extractIDAT(buf.Bytes())
		if err != nil {
			return err
		}
		if i == 0 {
			if err := writeChunk(w, "IDAT", idat); err != nil {
				return err
			}
			continue
		}
		fdat := &bytes.Buffer{}
		_ = binary.Write(fdat, binary.BigEndian, seq)
		fdat.Write(idat)
		if err := writeChunk(w, "fdAT", fdat.Bytes()); err != nil {
			return err
		}
		seq++
	}

	return writeChunk(w, "IEND", nil)
}

// writeChunk emits a single length-prefixed, CRC-suffixed PNG chunk.
func writeChunk(w io.Writer, chunkType string, data []byte) error {
	if err := binary.Write(w, binary.BigEndian, uint32(len(data))); err != nil {
		return err
	}
	if _, err := w.Write([]byte(chunkType)); err != nil {
		return err
	}
	if len(data) > 0 {
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
	h := crc32.NewIEEE()
	_, _ = h.Write([]byte(chunkType))
	_, _ = h.Write(data)
	return binary.Write(w, binary.BigEndian, h.Sum32())
}

// extractIDAT concatenates every IDAT chunk's payload from a complete PNG byte
// stream, which is how APNG reuses the standard encoder's output.
func extractIDAT(pngData []byte) ([]byte, error) {
	var out []byte
	pos := 8 // skip signature
	for pos+8 <= len(pngData) {
		length := binary.BigEndian.Uint32(pngData[pos:])
		chunkType := string(pngData[pos+4 : pos+8])
		start := pos + 8
		end := start + int(length)
		if end > len(pngData) {
			break
		}
		if chunkType == "IDAT" {
			out = append(out, pngData[start:end]...)
		}
		pos = end + 4 // skip CRC
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("tsf: no IDAT chunks in encoded frame")
	}
	return out, nil
}
