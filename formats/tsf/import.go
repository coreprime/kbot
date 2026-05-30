package tsf

import (
	"fmt"
	"image"
	"image/draw"
	"image/gif"
)

// FromGIF builds a TAF from a decoded animated GIF. Every GIF frame is
// flattened against the running canvas (honouring background/none disposal) so
// each TAF frame is a full-size truecolor image in the requested format. GIF
// delays (1/100s) are converted back to TA: Kingdoms ticks.
func FromGIF(g *gif.GIF, format PixelFormat, name string) (*TAF, error) {
	if format != FormatARGB4444 && format != FormatARGB1555 {
		return nil, fmt.Errorf("tsf: invalid pixel format 0x%02X", uint8(format))
	}
	if g == nil || len(g.Image) == 0 {
		return nil, fmt.Errorf("tsf: gif has no frames")
	}
	w, h := g.Config.Width, g.Config.Height
	if w == 0 || h == 0 {
		b := g.Image[0].Bounds()
		w, h = b.Dx(), b.Dy()
	}
	if w <= 0 || h <= 0 || w > 0xFFFF || h > 0xFFFF {
		return nil, fmt.Errorf("tsf: gif has unusable dimensions %dx%d", w, h)
	}

	canvas := image.NewNRGBA(image.Rect(0, 0, w, h))
	taf := &TAF{Name: name, Frames: make([]*Frame, 0, len(g.Image))}

	for i, src := range g.Image {
		draw.Draw(canvas, src.Bounds(), src, src.Bounds().Min, draw.Over)

		snap := image.NewNRGBA(canvas.Bounds())
		copy(snap.Pix, canvas.Pix)
		pixels, err := PixelsFromNRGBA(snap, format)
		if err != nil {
			return nil, fmt.Errorf("tsf: gif frame %d: %w", i, err)
		}
		taf.Frames = append(taf.Frames, &Frame{
			Width:    uint16(w),
			Height:   uint16(h),
			Format:   format,
			Duration: centisecondsToTicks(gifDelayAt(g, i)),
			Pixels:   pixels,
		})

		switch disposalAt(g, i) {
		case gif.DisposalBackground:
			draw.Draw(canvas, src.Bounds(), image.Transparent, image.Point{}, draw.Src)
		case gif.DisposalPrevious:
			// Restoring the prior canvas is rare in practice; approximate by
			// leaving the current contents in place.
		}
	}
	return taf, nil
}

// FromSheet slices a sprite-sheet image into frames of frameW×frameH, walking
// left-to-right then top-to-bottom. When count is zero every full cell is
// taken; otherwise the first count cells are used. Each frame is given the same
// duration (in ticks).
func FromSheet(img image.Image, frameW, frameH, count int, format PixelFormat, name string, duration uint32) (*TAF, error) {
	if format != FormatARGB4444 && format != FormatARGB1555 {
		return nil, fmt.Errorf("tsf: invalid pixel format 0x%02X", uint8(format))
	}
	if frameW <= 0 || frameH <= 0 {
		return nil, fmt.Errorf("tsf: frame size must be positive, got %dx%d", frameW, frameH)
	}
	if frameW > 0xFFFF || frameH > 0xFFFF {
		return nil, fmt.Errorf("tsf: frame size %dx%d exceeds 16-bit range", frameW, frameH)
	}
	b := img.Bounds()
	cols := b.Dx() / frameW
	rows := b.Dy() / frameH
	if cols < 1 || rows < 1 {
		return nil, fmt.Errorf("tsf: sheet %dx%d is smaller than one %dx%d frame", b.Dx(), b.Dy(), frameW, frameH)
	}
	total := cols * rows
	if count > 0 && count < total {
		total = count
	}

	taf := &TAF{Name: name, Frames: make([]*Frame, 0, total)}
	for i := 0; i < total; i++ {
		cx := b.Min.X + (i%cols)*frameW
		cy := b.Min.Y + (i/cols)*frameH
		cell := image.NewNRGBA(image.Rect(0, 0, frameW, frameH))
		draw.Draw(cell, cell.Bounds(), img, image.Point{X: cx, Y: cy}, draw.Src)
		pixels, err := PixelsFromNRGBA(cell, format)
		if err != nil {
			return nil, fmt.Errorf("tsf: sheet cell %d: %w", i, err)
		}
		taf.Frames = append(taf.Frames, &Frame{
			Width:    uint16(frameW),
			Height:   uint16(frameH),
			Format:   format,
			Duration: duration,
			Pixels:   pixels,
		})
	}
	return taf, nil
}

// centisecondsToTicks converts a GIF delay (1/100s) back to TA:K ticks.
func centisecondsToTicks(cs int) uint32 {
	if cs <= 0 {
		return 0
	}
	return uint32(cs * ticksPerSecond / 100)
}

func gifDelayAt(g *gif.GIF, i int) int {
	if i < len(g.Delay) {
		return g.Delay[i]
	}
	return 0
}

func disposalAt(g *gif.GIF, i int) byte {
	if i < len(g.Disposal) {
		return g.Disposal[i]
	}
	return gif.DisposalNone
}
