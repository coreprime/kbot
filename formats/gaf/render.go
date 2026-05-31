package gaf

import (
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"io"
)

// ToImage converts a frame to an image.Image using the given palette and the
// auto-resolved transparency index.
func (f *Frame) ToImage(palette *Palette) *image.Paletted {
	return f.ToImageWith(palette, RenderOptions{Mode: TransparencyModeAuto})
}

// ToImageWith renders a frame with explicit transparency handling.
func (f *Frame) ToImageWith(palette *Palette, opts RenderOptions) *image.Paletted {
	var pal color.Palette
	if palette != nil {
		pal = palette.ColorModel()
	} else {
		pal = FallbackPalette().ColorModel()
	}

	transIdx, apply := f.resolveTransparency(opts)

	// Set transparency in the palette for GIF encoding. Go's gif package
	// detects the transparent index by finding color.Transparent in the
	// palette.
	palCopy := make(color.Palette, len(pal))
	copy(palCopy, pal)
	if apply {
		palCopy[transIdx] = color.Transparent
	}
	pal = palCopy

	img := image.NewPaletted(
		image.Rect(0, 0, int(f.Width), int(f.Height)),
		pal,
	)

	// Validate pixel data matches frame dimensions; corrupt/unusual GAF files
	// can disagree, so pad or truncate to the expected size.
	expectedSize := int(f.Width) * int(f.Height)
	if len(f.Pixels) != expectedSize {
		if len(f.Pixels) < expectedSize {
			padded := make([]byte, expectedSize)
			copy(padded, f.Pixels)
			for i := len(f.Pixels); i < expectedSize; i++ {
				padded[i] = transIdx
			}
			copy(img.Pix, padded)
		} else {
			copy(img.Pix, f.Pixels[:expectedSize])
		}
	} else {
		copy(img.Pix, f.Pixels)
	}

	return img
}

// ToGIF converts a sequence to an animated GIF using auto transparency.
func (s *Sequence) ToGIF(palette *Palette) (*gif.GIF, error) {
	return s.ToGIFWith(palette, RenderOptions{Mode: TransparencyModeAuto})
}

// ToGIFWith converts a sequence to an animated GIF using explicit transparency
// options.
func (s *Sequence) ToGIFWith(palette *Palette, opts RenderOptions) (*gif.GIF, error) {
	if len(s.Frames) == 0 {
		return nil, fmt.Errorf("no frames in sequence")
	}

	// Calculate the bounding box that contains all frames when positioned by
	// their origins. OriginX/OriginY represent the "hotspot" center point of
	// each frame.
	var minX, minY, maxX, maxY int16
	for i, frame := range s.Frames {
		if frame == nil {
			continue
		}
		// Frame extends from (-OriginX, -OriginY) to (Width-OriginX, Height-OriginY).
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

	// Resolve transparency once from the first frame so the GIF's global
	// palette is built around what will actually render as transparent.
	transparencyIndex := uint8(0)
	applyTransparency := true
	if len(s.Frames) > 0 && s.Frames[0] != nil {
		transparencyIndex, applyTransparency = s.Frames[0].resolveTransparency(opts)
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

	palCopy := make(color.Palette, len(pal))
	copy(palCopy, pal)
	if applyTransparency {
		palCopy[transparencyIndex] = color.Transparent
	}
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
		if frame == nil {
			return nil, fmt.Errorf("frame %d is nil", i)
		}
		if frame.Width == 0 || frame.Height == 0 {
			return nil, fmt.Errorf("frame %d has invalid dimensions: %dx%d", i, frame.Width, frame.Height)
		}

		canvas := image.NewPaletted(
			image.Rect(0, 0, canvasWidth, canvasHeight),
			pal,
		)

		// Fill with the transparency index.
		for i := range canvas.Pix {
			canvas.Pix[i] = transparencyIndex
		}

		// Carry the same transparency options through so the per-frame palette
		// matches the GIF's global palette.
		frameImg := frame.ToImageWith(palette, opts)

		// Position the frame on the canvas. The frame's top-left is at
		// (-OriginX, -OriginY) relative to the hotspot; the canvas hotspot is
		// at (-minX, -minY).
		xOffset := int(-frame.OriginX - minX)
		yOffset := int(-frame.OriginY - minY)

		for y := 0; y < int(frame.Height); y++ {
			for x := 0; x < int(frame.Width); x++ {
				canvasX := x + xOffset
				canvasY := y + yOffset

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

		// Duration is in game ticks (1/30th second); GIF delay is in 1/100th
		// second, so delay = duration * 100/30 = duration * 10 / 3.
		delay := int(frame.Duration) * 10 / 3
		if delay < 1 {
			delay = 3 // ~30 FPS minimum
		}
		g.Delay = append(g.Delay, delay)
	}

	return g, nil
}

// WriteGIF writes an animated GIF to the given writer using auto transparency.
func (s *Sequence) WriteGIF(w io.Writer, palette *Palette) error {
	return s.WriteGIFWith(w, palette, RenderOptions{Mode: TransparencyModeAuto})
}

// WriteGIFWith writes an animated GIF using explicit transparency options.
func (s *Sequence) WriteGIFWith(w io.Writer, palette *Palette, opts RenderOptions) error {
	g, err := s.ToGIFWith(palette, opts)
	if err != nil {
		return err
	}
	return gif.EncodeAll(w, g)
}
