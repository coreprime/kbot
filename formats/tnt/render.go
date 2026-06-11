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
// Pixel(x, y) = TileAttr[y*AttrW+x].Height.  TA:K maps render their DataUnit
// heightmap bytes directly — the same 16px cell resolution.
func (m *Map) RenderHeightMapRaw() *image.Gray {
	if m.IsTAK {
		if m.TAKHeight == nil || m.TAKW == 0 {
			return nil
		}
		img := image.NewGray(image.Rect(0, 0, m.TAKW, m.TAKH))
		copy(img.Pix, m.TAKHeight)
		return img
	}
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
// read squarish in a terminal).  TA:K maps render from the DataUnit
// heightmap at the same 16px cell resolution.
func (m *Map) RenderASCII(maxCols int) string {
	if m.IsTAK {
		return renderASCIIHeights(m.TAKHeight, m.TAKW, m.TAKH, maxCols)
	}
	if m.TileAttr == nil || m.AttrW == 0 || m.AttrH == 0 {
		return ""
	}
	heights := make([]byte, len(m.TileAttr))
	for i, a := range m.TileAttr {
		heights[i] = a.Height
	}
	return renderASCIIHeights(heights, m.AttrW, m.AttrH, maxCols)
}

// renderASCIIHeights is the elevation-grid-to-ASCII core shared by the TA
// attribute grid and the TA:K DataUnit heightmap.
func renderASCIIHeights(heights []byte, w, h, maxCols int) string {
	if len(heights) == 0 || w == 0 || h == 0 {
		return ""
	}
	if maxCols <= 0 {
		maxCols = 80
	}
	cols := maxCols
	if cols > w {
		cols = w
	}
	// Terminal characters are roughly twice as tall as they are wide.
	rows := (h * cols) / w / 2
	if rows < 1 {
		rows = 1
	}

	minH, maxH := uint8(255), uint8(0)
	for _, v := range heights {
		if v < minH {
			minH = v
		}
		if v > maxH {
			maxH = v
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
			sx0 := rx * w / cols
			sx1 := (rx + 1) * w / cols
			sy0 := ry * h / rows
			sy1 := (ry + 1) * h / rows
			if sx1 <= sx0 {
				sx1 = sx0 + 1
			}
			if sy1 <= sy0 {
				sy1 = sy0 + 1
			}
			sum, n := 0, 0
			for sy := sy0; sy < sy1 && sy < h; sy++ {
				for sx := sx0; sx < sx1 && sx < w; sx++ {
					sum += int(heights[sy*w+sx])
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

// Cliff-edge threshold reused by RenderBuildMap.  Adjacent attribute
// cells whose |Δheight| exceeds this read as cliffs in TA's pathing —
// ground units can't traverse them and you can't site a building
// straddling one.  Lives in the format package so the renderer doesn't
// reach into internal/maplint; keep the constant in sync.
const buildMapCliffThreshold = 32

// Build-map classification palette.  RGBA so callers can composite the
// result with the tile or height render.  Colors are chosen for
// at-a-glance reading at 16px-per-cell — green = go, blue = water,
// yellow = cliff, red = blocking feature, black = engine-void.
var (
	buildMapBuildable    = color.RGBA{R: 0x46, G: 0xb0, B: 0x55, A: 0xff}
	buildMapUnderwater   = color.RGBA{R: 0x2f, G: 0x6f, B: 0xc8, A: 0xff}
	buildMapCliff        = color.RGBA{R: 0xe6, G: 0xc8, B: 0x39, A: 0xff}
	buildMapFeatureBlock = color.RGBA{R: 0xc2, G: 0x4a, B: 0x4a, A: 0xff}
	buildMapVoid         = color.RGBA{R: 0x12, G: 0x12, B: 0x14, A: 0xff}
)

// RenderBuildMap produces an attribute-resolution RGBA image showing
// per-cell buildability.  Each cell is classified, in priority order:
//
//	void          Feature == 0xFFFC (canonical engine-void sentinel)
//	feature       Feature is a valid index in the .tnt feature table
//	underwater    Height < seaLevel (the cell would be submerged)
//	cliff         max |Δheight| to a 4-neighbour exceeds the cliff
//	              threshold — TA's pathing blocks traversal so no
//	              build either
//	buildable     otherwise
//
// 0xFFFD / 0xFFFE are deliberately not treated as void — see
// docs/formats/tnt.md.  When seaLevel is 0 the underwater check is
// skipped (matches a map authoring tool that never wrote a sea level).
// Returns nil when the map has no attribute grid.
func (m *Map) RenderBuildMap(seaLevel uint32) *image.RGBA {
	if m.TileAttr == nil || m.AttrW == 0 || m.AttrH == 0 {
		return nil
	}
	w, h := m.AttrW, m.AttrH
	img := image.NewRGBA(image.Rect(0, 0, w, h))

	// Pre-fetch heights as ints to avoid repeated uint8→int conversions
	// in the cliff check.
	heights := make([]int, w*h)
	for i, a := range m.TileAttr {
		heights[i] = int(a.Height)
	}

	// Header.TileAnims is the size of the feature name table — any
	// Feature value below it is a real placement; anything ≥ it that
	// isn't 0xFFFC is a non-sentinel oddity we treat as "no feature".
	maxFeature := uint16(m.Header.TileAnims)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := y*w + x
			a := m.TileAttr[i]
			switch {
			case a.Feature == 0xFFFC:
				img.SetRGBA(x, y, buildMapVoid)
				continue
			case a.Feature < maxFeature:
				img.SetRGBA(x, y, buildMapFeatureBlock)
				continue
			}
			if seaLevel > 0 && uint32(a.Height) < seaLevel {
				img.SetRGBA(x, y, buildMapUnderwater)
				continue
			}
			if cellIsCliff(heights, w, h, x, y) {
				img.SetRGBA(x, y, buildMapCliff)
				continue
			}
			img.SetRGBA(x, y, buildMapBuildable)
		}
	}
	return img
}

// cellIsCliff returns true when the cell at (x,y) has a 4-neighbour
// whose absolute elevation delta is above buildMapCliffThreshold.
// Out-of-bounds neighbours are skipped — they don't push a border cell
// into the cliff bucket.
func cellIsCliff(heights []int, w, h, x, y int) bool {
	c := heights[y*w+x]
	check := func(dx, dy int) bool {
		nx, ny := x+dx, y+dy
		if nx < 0 || ny < 0 || nx >= w || ny >= h {
			return false
		}
		d := heights[ny*w+nx] - c
		if d < 0 {
			d = -d
		}
		return d > buildMapCliffThreshold
	}
	return check(-1, 0) || check(1, 0) || check(0, -1) || check(0, 1)
}

// VoidMap classification palette.  Void cells render as opaque red so
// they show up against any backdrop; non-void cells are transparent so
// callers can composite the result over the tile render.
var (
	voidMapVoid    = color.RGBA{R: 0xc2, G: 0x4a, B: 0x4a, A: 0xff}
	voidMapPassage = color.RGBA{}
)

// RenderVoidMap produces an attribute-resolution RGBA image with the
// engine-void cells (Feature == 0xFFFC) painted opaque-red and every
// other cell transparent.  See [Map.RenderBuildMap] for why 0xFFFD /
// 0xFFFE are not treated as void.  Returns nil when the map has no
// attribute grid.
func (m *Map) RenderVoidMap() *image.RGBA {
	if m.TileAttr == nil || m.AttrW == 0 || m.AttrH == 0 {
		return nil
	}
	w, h := m.AttrW, m.AttrH
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			a := m.TileAttr[y*w+x]
			if a.Feature == 0xFFFC {
				img.SetRGBA(x, y, voidMapVoid)
				continue
			}
			img.SetRGBA(x, y, voidMapPassage)
		}
	}
	return img
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
