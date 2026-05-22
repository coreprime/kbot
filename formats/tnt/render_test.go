package tnt

import (
	"image/color"
	"testing"
)

// TestRenderVoidMap synthesises a minimal Map and asserts that
// RenderVoidMap paints only the 0xFFFC cell as opaque-red.  0xFFFD and
// 0xFFFE land in the "passable" bucket per docs/formats/tnt.md — both
// must come out transparent.
func TestRenderVoidMap(t *testing.T) {
	m := makeTestMap(4, 2)
	m.TileAttr[0].Feature = 0xFFFC // void
	m.TileAttr[1].Feature = 0xFFFE // not-void (used by early Cavedog maps)
	m.TileAttr[2].Feature = 0xFFFD // not-void
	m.TileAttr[3].Feature = 0xFFFF // no feature

	img := m.RenderVoidMap()
	if img == nil {
		t.Fatal("RenderVoidMap returned nil")
	}
	if got := img.Bounds().Dx(); got != m.AttrW {
		t.Errorf("width: got %d, want %d", got, m.AttrW)
	}
	if got := img.Bounds().Dy(); got != m.AttrH {
		t.Errorf("height: got %d, want %d", got, m.AttrH)
	}
	got := img.RGBAAt(0, 0)
	if got != (color.RGBA{R: 0xc2, G: 0x4a, B: 0x4a, A: 0xff}) {
		t.Errorf("0xFFFC cell: got %+v, want opaque red", got)
	}
	for _, p := range []struct{ x, y int }{{1, 0}, {2, 0}, {3, 0}} {
		c := img.RGBAAt(p.x, p.y)
		if c.A != 0 {
			t.Errorf("non-void cell (%d,%d): A=%d, want 0", p.x, p.y, c.A)
		}
	}
}

// TestRenderBuildMap exercises every classification branch on a 4×2
// synthetic map.  Layout (x,y):
//
//	(0,0) void        Feature = 0xFFFC
//	(1,0) feature     Feature = 0 (valid index)
//	(2,0) underwater  Height = 10, SeaLevel = 80
//	(3,0) cliff       Height delta to (3,1) is 200
//	(0,1) buildable   default flat ground
//	(1,1) buildable   default flat ground
//	(2,1) buildable   default flat ground
//	(3,1) cliff       same edge as (3,0)
//
// 0xFFFE is verified to fall through into "buildable", not "void".
func TestRenderBuildMap(t *testing.T) {
	m := makeTestMap(4, 2)
	m.Header.TileAnims = 1

	m.TileAttr[0].Feature = 0xFFFC // void
	m.TileAttr[1].Feature = 0      // valid feature index (TileAnims = 1)
	m.TileAttr[2].Feature = 0xFFFF // no feature; gets the underwater branch
	m.TileAttr[2].Height = 10
	m.TileAttr[3].Feature = 0xFFFF // cliff branch — large delta to row below
	m.TileAttr[3].Height = 220
	m.TileAttr[m.AttrW+3].Feature = 0xFFFF
	m.TileAttr[m.AttrW+3].Height = 20

	img := m.RenderBuildMap(80)
	if img == nil {
		t.Fatal("RenderBuildMap returned nil")
	}

	cases := []struct {
		x, y int
		want color.RGBA
		name string
	}{
		{0, 0, buildMapVoid, "void"},
		{1, 0, buildMapFeatureBlock, "feature-block"},
		{2, 0, buildMapUnderwater, "underwater"},
		{3, 0, buildMapCliff, "cliff"},
		{0, 1, buildMapBuildable, "buildable-row1-col0"},
	}
	for _, c := range cases {
		got := img.RGBAAt(c.x, c.y)
		if got != c.want {
			t.Errorf("%s (%d,%d): got %+v, want %+v", c.name, c.x, c.y, got, c.want)
		}
	}
}

// TestRenderBuildMap_FFFENotVoid is the regression check for the
// 0xFFFE-as-void bug: a cell with Feature=0xFFFE on otherwise flat,
// above-sea-level ground must classify as buildable.
func TestRenderBuildMap_FFFENotVoid(t *testing.T) {
	m := makeTestMap(2, 1)
	m.Header.TileAnims = 0
	m.TileAttr[0].Feature = 0xFFFE
	m.TileAttr[0].Height = 120
	m.TileAttr[1].Feature = 0xFFFF
	m.TileAttr[1].Height = 120

	img := m.RenderBuildMap(80)
	if img == nil {
		t.Fatal("RenderBuildMap returned nil")
	}
	got := img.RGBAAt(0, 0)
	if got != buildMapBuildable {
		t.Errorf("0xFFFE cell: got %+v, want buildable", got)
	}
}

// makeTestMap returns a fully-zeroed Map sized to attrW × attrH
// attribute cells.  Heights default to 120 so under/over-sea checks
// are predictable.
func makeTestMap(attrW, attrH int) *Map {
	m := &Map{
		AttrW:    attrW,
		AttrH:    attrH,
		TileW:    attrW / 2,
		TileH:    attrH / 2,
		TileAttr: make([]TileAttr, attrW*attrH),
		Header: Header{
			Width:  uint32(attrW),
			Height: uint32(attrH),
		},
	}
	for i := range m.TileAttr {
		m.TileAttr[i] = TileAttr{Height: 120, Feature: 0xFFFF}
	}
	return m
}
