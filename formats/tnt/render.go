package tnt

import (
	"image"
	"image/color"
	"strings"
)

// RenderHeightMapRaw returns an unflipped, unnormalized 8-bit grayscale image
// of the height attribute grid.  Pixel value equals the raw elevation byte at
// that cell — suitable for byte-perfect round-trip through PNG.
//
// Pixel(x, y) = TileAttr[y*AttrW+x].Height.
func (m *Map) RenderHeightMapRaw() *image.Gray {
	if m.TileAttr == nil {
		return nil
	}
	img := image.NewGray(image.Rect(0, 0, m.AttrW, m.AttrH))
	for y := 0; y < m.AttrH; y++ {
		for x := 0; x < m.AttrW; x++ {
			img.SetGray(x, y, color.Gray{Y: m.TileAttr[y*m.AttrW+x].Height})
		}
	}
	return img
}

// RenderMinimapPaletted returns the minimap as a paletted image preserving
// the original palette indices, including the void/padding byte.  Returns nil
// when no minimap is present.
func (m *Map) RenderMinimapPaletted(palette color.Palette) *image.Paletted {
	if m.Minimap == nil || m.MinimapW == 0 || m.MinimapH == 0 {
		return nil
	}
	pal := palette
	if len(pal) < 256 {
		pal = make(color.Palette, 256)
		copy(pal, palette)
		for i := len(palette); i < 256; i++ {
			pal[i] = color.RGBA{0, 0, 0, 0}
		}
	}
	img := image.NewPaletted(image.Rect(0, 0, m.MinimapW, m.MinimapH), pal)
	copy(img.Pix, m.Minimap)
	return img
}

// RenderTilePaletted returns a single 32×32 tile as a paletted image using
// the given palette.  Returns nil for out-of-range indices.
func (m *Map) RenderTilePaletted(index int, palette color.Palette) *image.Paletted {
	if index < 0 || index >= len(m.Tiles) {
		return nil
	}
	pal := palette
	if len(pal) < 256 {
		pal = make(color.Palette, 256)
		copy(pal, palette)
		for i := len(palette); i < 256; i++ {
			pal[i] = color.RGBA{0, 0, 0, 0}
		}
	}
	img := image.NewPaletted(image.Rect(0, 0, 32, 32), pal)
	copy(img.Pix, m.Tiles[index])
	return img
}

// asciiRamp orders characters from darkest to brightest for elevation gradients.
const asciiRamp = " .:-=+*#%@"

// RenderASCII produces a compact ASCII visualization of the height map,
// scaled down to fit within the given column width.  The aspect ratio of
// the source is preserved (with a 2:1 character cell adjustment so columns
// read squarish in a terminal).
func (m *Map) RenderASCII(maxCols int) string {
	if m.TileAttr == nil || m.AttrW == 0 || m.AttrH == 0 {
		return ""
	}
	if maxCols <= 0 {
		maxCols = 80
	}
	cols := maxCols
	if cols > m.AttrW {
		cols = m.AttrW
	}
	// Terminal characters are roughly twice as tall as they are wide.
	rows := (m.AttrH * cols) / m.AttrW / 2
	if rows < 1 {
		rows = 1
	}

	minH, maxH := uint8(255), uint8(0)
	for _, a := range m.TileAttr {
		if a.Height < minH {
			minH = a.Height
		}
		if a.Height > maxH {
			maxH = a.Height
		}
	}
	span := int(maxH) - int(minH)
	if span < 1 {
		span = 1
	}

	var b strings.Builder
	b.Grow((cols + 1) * rows)
	for ry := 0; ry < rows; ry++ {
		for rx := 0; rx < cols; rx++ {
			// Bilinear-ish sample: average the source cell block under this character.
			sx0 := rx * m.AttrW / cols
			sx1 := (rx + 1) * m.AttrW / cols
			sy0 := ry * m.AttrH / rows
			sy1 := (ry + 1) * m.AttrH / rows
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			if sy1 <= sy0 {
				sy1 = sy0 + 1
			}
			sum, n := 0, 0
			for sy := sy0; sy < sy1 && sy < m.AttrH; sy++ {
				for sx := sx0; sx < sx1 && sx < m.AttrW; sx++ {
					sum += int(m.TileAttr[sy*m.AttrW+sx].Height)
					n++
				}
			}
			avg := uint8(0)
			if n > 0 {
				avg = uint8(sum / n)
			}
			rampIdx := (int(avg) - int(minH)) * (len(asciiRamp) - 1) / span
			if rampIdx < 0 {
				rampIdx = 0
			}
			if rampIdx >= len(asciiRamp) {
				rampIdx = len(asciiRamp) - 1
			}
			b.WriteByte(asciiRamp[rampIdx])
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// FeatureCounts tallies placement counts keyed by feature index.
func (m *Map) FeatureCounts() map[int]int {
	out := make(map[int]int)
	if m.TileAttr == nil {
		return out
	}
	for _, a := range m.TileAttr {
		if a.Feature == 0xFFFF || a.Feature == 0xFFFC || a.Feature == 0xFFFE {
			continue
		}
		out[int(a.Feature)]++
	}
	return out
}
