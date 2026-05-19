package tnt

import (
	"image/color"
	"testing"
)

func grayPalette256() color.Palette {
	pal := make(color.Palette, 256)
	for i := 0; i < 256; i++ {
		pal[i] = color.RGBA{uint8(i), uint8(i), uint8(i), 255}
	}
	return pal
}

func TestLintReportsDuplicates(t *testing.T) {
	tiles := [][]byte{
		solidTile(10),
		solidTile(10), // duplicate
		solidTile(20),
	}
	tilemap := []uint16{0, 1, 2, 0}
	heights := make([]uint8, 16)
	m := buildSyntheticMap(tiles, tilemap, heights)

	diags, err := m.Lint(LintOptions{SimilarityPercent: 0})
	if err != nil {
		t.Fatalf("Lint: %v", err)
	}
	// Lint must not mutate the caller's map.
	if len(m.Tiles) != 3 {
		t.Fatalf("Lint mutated the map: Tiles=%d, want 3", len(m.Tiles))
	}
	if got := findDiag(diags, "duplicate-tiles"); got == nil {
		t.Fatalf("duplicate-tiles diagnostic missing; got %+v", diags)
	} else {
		if got.Count != 1 {
			t.Errorf("duplicate-tiles Count = %d, want 1", got.Count)
		}
		if got.BytesSaved != TileGfxSize {
			t.Errorf("duplicate-tiles BytesSaved = %d, want %d", got.BytesSaved, TileGfxSize)
		}
	}
}

func TestLintReportsUnused(t *testing.T) {
	tiles := [][]byte{
		solidTile(10),
		solidTile(99), // unused
	}
	tilemap := []uint16{0, 0, 0, 0}
	heights := make([]uint8, 16)
	m := buildSyntheticMap(tiles, tilemap, heights)

	diags, err := m.Lint(LintOptions{SimilarityPercent: 0})
	if err != nil {
		t.Fatalf("Lint: %v", err)
	}
	got := findDiag(diags, "unused-tiles")
	if got == nil || got.Count != 1 {
		t.Fatalf("unused-tiles count = %v, want 1; diags=%+v", got, diags)
	}
}

func TestLintReportsSimilarity(t *testing.T) {
	tiles := [][]byte{
		solidTile(40),
		solidTile(41), // close enough to 40 in greyscale palette
	}
	tilemap := []uint16{0, 1, 0, 1}
	heights := make([]uint8, 16) // all zero, identical footprint
	m := buildSyntheticMap(tiles, tilemap, heights)

	diags, err := m.Lint(LintOptions{SimilarityPercent: 1.0, Palette: grayPalette256()})
	if err != nil {
		t.Fatalf("Lint: %v", err)
	}
	got := findDiag(diags, "similar-tiles")
	if got == nil || got.Count != 1 {
		t.Fatalf("similar-tiles count = %v, want 1; diags=%+v", got, diags)
	}
	if got.BytesSaved != TileGfxSize {
		t.Errorf("similar-tiles BytesSaved = %d, want %d", got.BytesSaved, TileGfxSize)
	}
}

func TestLintCleanMap(t *testing.T) {
	tiles := [][]byte{
		solidTile(10),
		solidTile(200),
	}
	tilemap := []uint16{0, 1, 0, 1}
	heights := make([]uint8, 16)
	m := buildSyntheticMap(tiles, tilemap, heights)

	diags, err := m.Lint(LintOptions{SimilarityPercent: 1.0, Palette: grayPalette256()})
	if err != nil {
		t.Fatalf("Lint: %v", err)
	}
	if len(diags) != 0 {
		t.Errorf("clean map should produce no diagnostics, got %+v", diags)
	}
}

func TestLintRequiresPaletteWhenSimilarityEnabled(t *testing.T) {
	tiles := [][]byte{solidTile(10), solidTile(11)}
	tilemap := []uint16{0, 1, 0, 1}
	heights := make([]uint8, 16)
	m := buildSyntheticMap(tiles, tilemap, heights)

	if _, err := m.Lint(LintOptions{SimilarityPercent: 1.0}); err == nil {
		t.Fatalf("Lint(similarity>0, no palette) should fail")
	}
}

func findDiag(diags []LintDiagnostic, rule string) *LintDiagnostic {
	for i := range diags {
		if diags[i].Rule == rule {
			return &diags[i]
		}
	}
	return nil
}
