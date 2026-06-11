package tnt

import (
	"bytes"
	"image/color"
	"os"
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

// buildSyntheticMap returns a minimal 4x4-cell (2x2-tile) map with the
// requested tile graphics, tilemap, and heightmap.  It's the canonical
// fixture used to exercise Map.Optimize without touching disk.
func buildSyntheticMap(tiles [][]byte, tilemap []uint16, heights []uint8) *Map {
	tileW, tileH := 2, 2
	attrW, attrH := tileW*2, tileH*2
	attrs := make([]TileAttr, attrW*attrH)
	for i := range attrs {
		attrs[i] = TileAttr{Height: heights[i], Feature: 0xFFFF}
	}
	return &Map{
		Header:   Header{IDVersion: 8192},
		TileW:    tileW,
		TileH:    tileH,
		AttrW:    attrW,
		AttrH:    attrH,
		TileMap:  tilemap,
		TileAttr: attrs,
		Tiles:    tiles,
	}
}

func solidTile(v byte) []byte {
	t := make([]byte, 1024)
	for i := range t {
		t[i] = v
	}
	return t
}

func TestOptimizeExactDuplicates(t *testing.T) {
	// Three "logical" tile graphics but tile #1 is a byte-identical copy
	// of tile #0.  After Optimize they should collapse to two tiles.
	tiles := [][]byte{
		solidTile(10),
		solidTile(10), // duplicate of tile 0
		solidTile(20),
	}
	tilemap := []uint16{0, 1, 2, 0}
	heights := []uint8{
		5, 5, 7, 7,
		5, 5, 7, 7,
		3, 3, 9, 9,
		3, 3, 9, 9,
	}
	m := buildSyntheticMap(tiles, tilemap, heights)

	stats, err := m.Optimize(OptimizeOptions{SimilarityPercent: 0})
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if stats.ExactMerges != 1 {
		t.Errorf("ExactMerges = %d, want 1", stats.ExactMerges)
	}
	if len(m.Tiles) != 2 {
		t.Fatalf("Tiles after = %d, want 2", len(m.Tiles))
	}
	// Cells that referenced the duplicate should now share index 0.
	if m.TileMap[0] != m.TileMap[1] {
		t.Errorf("tilemap[0]=%d tilemap[1]=%d; expected to share canonical index",
			m.TileMap[0], m.TileMap[1])
	}
	// The tile that was originally index 2 should still be reachable.
	if m.TileMap[2] >= uint16(len(m.Tiles)) {
		t.Errorf("tilemap[2]=%d points past tile list (len=%d)", m.TileMap[2], len(m.Tiles))
	}
}

func TestOptimizeUnusedRemoved(t *testing.T) {
	// Tile #1 has unique pixels but nothing references it.
	tiles := [][]byte{
		solidTile(10),
		solidTile(99), // unused
		solidTile(20),
	}
	tilemap := []uint16{0, 0, 2, 2}
	heights := make([]uint8, 16)
	m := buildSyntheticMap(tiles, tilemap, heights)

	stats, err := m.Optimize(OptimizeOptions{SimilarityPercent: 0})
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if stats.UnusedRemoved != 1 {
		t.Errorf("UnusedRemoved = %d, want 1", stats.UnusedRemoved)
	}
	if len(m.Tiles) != 2 {
		t.Errorf("Tiles after = %d, want 2", len(m.Tiles))
	}
}

func TestOptimizeKeepUnused(t *testing.T) {
	tiles := [][]byte{
		solidTile(10),
		solidTile(99), // unused
	}
	tilemap := []uint16{0, 0, 0, 0}
	heights := make([]uint8, 16)
	m := buildSyntheticMap(tiles, tilemap, heights)

	stats, err := m.Optimize(OptimizeOptions{SimilarityPercent: 0, KeepUnused: true})
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if stats.UnusedRemoved != 0 {
		t.Errorf("UnusedRemoved = %d, want 0", stats.UnusedRemoved)
	}
	if len(m.Tiles) != 2 {
		t.Errorf("Tiles after = %d, want 2 (KeepUnused)", len(m.Tiles))
	}
}

func TestOptimizeSimilaritySameHeights(t *testing.T) {
	// Tile A and tile B differ by one pixel-value-of-1 channel offset --
	// trivially within a 1% threshold once translated through a grayscale
	// palette.  They share the same height footprint (5,5,5,5) so they
	// should consolidate.  Tile C is placed in a different height
	// context, so it should NOT consolidate even though its pixels are
	// also similar.
	tiles := [][]byte{
		solidTile(0), // -> rgb (0,0,0)
		solidTile(1), // -> rgb (1,1,1) — visually identical
		solidTile(0), // tile 2: pixels match tile 0 exactly
	}
	tilemap := []uint16{0, 1, 2, 2}
	heights := []uint8{
		5, 5, 5, 5,
		5, 5, 5, 5,
		9, 9, 9, 9, // tile 2 placements (rows 2-3) live at a different elevation
		9, 9, 9, 9,
	}
	m := buildSyntheticMap(tiles, tilemap, heights)

	// Build a 256-entry grayscale palette so that palette[i] is (i,i,i).
	pal := make(color.Palette, 256)
	for i := 0; i < 256; i++ {
		pal[i] = color.RGBA{uint8(i), uint8(i), uint8(i), 255}
	}

	stats, err := m.Optimize(OptimizeOptions{
		SimilarityPercent: 1.0,
		Palette:           pal,
	})
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}

	// Pass 1 collapses tile 0 and tile 2 (byte-identical).  Pass 2 then
	// sees their merged height set {(5,5,5,5),(9,9,9,9)} which does not
	// match tile 1's {(5,5,5,5)}, so the similarity merge must NOT fire.
	if stats.ExactMerges != 1 {
		t.Errorf("ExactMerges = %d, want 1", stats.ExactMerges)
	}
	if stats.SimilarityMerges != 0 {
		t.Errorf("SimilarityMerges = %d, want 0 (height context differs)",
			stats.SimilarityMerges)
	}
}

func TestOptimizeSimilarityMergesWhenHeightsMatch(t *testing.T) {
	// Two tiles with near-identical greyscale pixels, both placed in
	// cells with the same 4-tuple heightmap footprint.
	tiles := [][]byte{
		solidTile(40),
		solidTile(41),
	}
	tilemap := []uint16{0, 1, 0, 1}
	heights := []uint8{
		3, 3, 3, 3,
		3, 3, 3, 3,
		3, 3, 3, 3,
		3, 3, 3, 3,
	}
	m := buildSyntheticMap(tiles, tilemap, heights)
	pal := make(color.Palette, 256)
	for i := 0; i < 256; i++ {
		pal[i] = color.RGBA{uint8(i), uint8(i), uint8(i), 255}
	}

	stats, err := m.Optimize(OptimizeOptions{
		SimilarityPercent: 1.0,
		Palette:           pal,
	})
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	if stats.SimilarityMerges != 1 {
		t.Errorf("SimilarityMerges = %d, want 1", stats.SimilarityMerges)
	}
	if len(m.Tiles) != 1 {
		t.Errorf("Tiles after = %d, want 1", len(m.Tiles))
	}
}

func TestOptimizeRoundTripOnRealMap(t *testing.T) {
	// Load a real corpus map, optimise it, and make sure the result
	// still parses and the heightmap survives byte-for-byte.
	path := testutil.UnpackedFile(t, "maps", "cc02.tnt")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	r := bytes.NewReader(data)
	m, err := LoadFromReader(r)
	if err != nil {
		t.Fatalf("LoadFromReader: %v", err)
	}
	features, err := m.LoadFeatures(r)
	if err != nil {
		t.Fatalf("LoadFeatures: %v", err)
	}

	heightsBefore := make([]uint8, len(m.TileAttr))
	for i, a := range m.TileAttr {
		heightsBefore[i] = a.Height
	}

	stats, err := m.Optimize(OptimizeOptions{SimilarityPercent: 0})
	if err != nil {
		t.Fatalf("Optimize: %v", err)
	}
	t.Logf("cc02.tnt: %d -> %d tiles (exact=%d unused=%d)",
		stats.TilesBefore, stats.TilesAfter, stats.ExactMerges, stats.UnusedRemoved)

	for i, a := range m.TileAttr {
		if a.Height != heightsBefore[i] {
			t.Fatalf("height mutated at %d: %d -> %d", i, heightsBefore[i], a.Height)
		}
	}

	var buf bytes.Buffer
	if err := m.Save(&buf, features); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := LoadFromReader(bytes.NewReader(buf.Bytes())); err != nil {
		t.Fatalf("reload after optimize: %v", err)
	}
}
