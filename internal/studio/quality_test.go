package studio

import (
	"testing"

	"github.com/coreprime/kbot/formats/tnt"
)

// TestCheckDuplicateTilesDetectsRepeat seeds a tile pool with two
// byte-identical entries and confirms the dedup check flags them as a
// warning with the compressTiles fix id.
func TestCheckDuplicateTilesDetectsRepeat(t *testing.T) {
	tile := make([]byte, 1024)
	for i := range tile {
		tile[i] = 7
	}
	dup := make([]byte, 1024)
	copy(dup, tile)
	other := make([]byte, 1024)
	for i := range other {
		other[i] = 0x40
	}
	m := &tnt.Map{Tiles: [][]byte{tile, dup, other}}

	issue := checkDuplicateTiles(m, nil)
	if issue.Severity != "warning" {
		t.Fatalf("expected warning severity, got %q (%s)", issue.Severity, issue.Message)
	}
	if !issue.CanAutoFix || issue.Fix != "compressTiles" {
		t.Errorf("expected auto-fix compressTiles, got canAutoFix=%v fix=%q", issue.CanAutoFix, issue.Fix)
	}
}

// TestCheckDuplicateTilesUniqueIsOK confirms a unique-tile pool returns
// the green ok severity.
func TestCheckDuplicateTilesUniqueIsOK(t *testing.T) {
	a := make([]byte, 1024)
	b := make([]byte, 1024)
	for i := range b {
		b[i] = 1
	}
	m := &tnt.Map{Tiles: [][]byte{a, b}}
	issue := checkDuplicateTiles(m, nil)
	if issue.Severity != "ok" {
		t.Fatalf("expected ok severity, got %q (%s)", issue.Severity, issue.Message)
	}
}

// TestCheckDuplicateTilesAfterFixIsOK confirms a re-run after the fix
// has been applied short-circuits to ok regardless of pool contents
// (the build with compressTiles fix can't produce duplicates anyway).
func TestCheckDuplicateTilesAfterFixIsOK(t *testing.T) {
	tile := make([]byte, 1024)
	m := &tnt.Map{Tiles: [][]byte{tile, tile}}
	issue := checkDuplicateTiles(m, []string{"compressTiles"})
	if issue.Severity != "ok" {
		t.Fatalf("expected ok after compressTiles applied, got %q", issue.Severity)
	}
}

// minimalMap builds a 4×4-tile (8×8-attr) test map with every cell
// passable at height 80.  Tests then mutate specific cells to set up
// scenarios.  Helper avoids 60 lines of boilerplate per test.
func minimalMap() *tnt.Map {
	attrW, attrH := 8, 8
	attrs := make([]tnt.TileAttr, attrW*attrH)
	for i := range attrs {
		attrs[i] = tnt.TileAttr{Height: 80, Feature: 0xFFFF}
	}
	return &tnt.Map{
		AttrW: attrW, AttrH: attrH,
		TileW: 4, TileH: 4,
		TileAttr: attrs,
	}
}

// TestStartPositionsInBoundsDetectsVoid plants a start on top of a
// void cell and confirms the check flags it.
func TestStartPositionsInBoundsDetectsVoid(t *testing.T) {
	m := minimalMap()
	// Mark attr (4,4) as void.
	m.TileAttr[4*m.AttrW+4].Feature = voidFeatureLow
	req := saveRequest{
		OTA: &otaState{
			Schemas: []otaSchema{{
				StartPos: []saveStartPos{{Number: 1, X: 64, Z: 64}}, // ax=4, ay=4 — the void cell
			}},
		},
	}
	issue := checkStartPositionsInBounds(m, req)
	if issue.Severity != "warning" {
		t.Fatalf("expected warning when start sits on void, got %q (%s)", issue.Severity, issue.Message)
	}
}

// TestStartPositionsInBoundsOOB confirms out-of-bounds starts are flagged.
func TestStartPositionsInBoundsOOB(t *testing.T) {
	m := minimalMap()
	req := saveRequest{
		OTA: &otaState{
			Schemas: []otaSchema{{
				StartPos: []saveStartPos{{Number: 1, X: 9999, Z: 9999}},
			}},
		},
	}
	issue := checkStartPositionsInBounds(m, req)
	if issue.Severity != "warning" {
		t.Fatalf("expected warning for out-of-bounds start, got %q", issue.Severity)
	}
}

// TestHeightDiscontinuities seeds a tall cliff and confirms detection.
func TestHeightDiscontinuities(t *testing.T) {
	m := minimalMap()
	// Set one cell super high — both neighbours create a discontinuity.
	m.TileAttr[3*m.AttrW+3].Height = 240
	issue := checkHeightDiscontinuities(m)
	if issue.Severity != "warning" {
		t.Fatalf("expected warning, got %q (%s)", issue.Severity, issue.Message)
	}
}

// TestHeightDiscontinuitiesSmooth — flat map should pass.
func TestHeightDiscontinuitiesSmooth(t *testing.T) {
	issue := checkHeightDiscontinuities(minimalMap())
	if issue.Severity != "ok" {
		t.Fatalf("flat map should pass, got %q", issue.Severity)
	}
}

// TestMissingOTAFields confirms blank required fields are flagged.
func TestMissingOTAFields(t *testing.T) {
	req := saveRequest{OTA: &otaState{
		MissionName: "",
		Planet:      "",
		NumPlayers:  "2, 3, 4",
		Size:        "8x8",
		Schemas:     []otaSchema{{Name: "Default", StartPos: []saveStartPos{{Number: 1, X: 64, Z: 64}}}},
	}}
	issue := checkMissingOTAFields(req)
	if issue.Severity != "warning" {
		t.Fatalf("expected warning when MissionName + Planet blank, got %q", issue.Severity)
	}
}

// TestSchemaSlotsVsPlayers verifies max-player parsing + the "not
// enough starts" branch.
func TestSchemaSlotsVsPlayers(t *testing.T) {
	req := saveRequest{OTA: &otaState{
		NumPlayers: "2, 3, 4",
		Schemas: []otaSchema{{
			Name:     "Default",
			StartPos: []saveStartPos{{Number: 1, X: 0, Z: 0}, {Number: 2, X: 64, Z: 64}},
		}},
	}}
	issue := checkSchemaSlotsVsPlayers(req)
	if issue.Severity != "warning" {
		t.Fatalf("expected warning for 2 starts vs max-4 players, got %q", issue.Severity)
	}
}

// TestVoidIslands carves an isolated land patch and confirms the
// flood-fill labels it stranded.
func TestVoidIslands(t *testing.T) {
	m := minimalMap()
	// Wall off the right two columns with a continuous void strip — the
	// cells beyond are passable but unreachable from a start on the left.
	for y := 0; y < m.AttrH; y++ {
		m.TileAttr[y*m.AttrW+5].Feature = voidFeatureLow
	}
	req := saveRequest{OTA: &otaState{
		Schemas: []otaSchema{{StartPos: []saveStartPos{{Number: 1, X: 16, Z: 16}}}},
	}}
	issue := checkVoidIslands(m, req)
	if issue.Severity != "warning" {
		t.Fatalf("expected warning for stranded cells, got %q (%s)", issue.Severity, issue.Message)
	}
}

func TestParseMaxPlayers(t *testing.T) {
	for _, c := range []struct {
		in   string
		want int
	}{
		{"2, 3, 4", 4},
		{"  8  ", 8},
		{"", 0},
		{"foo", 0},
		{"2; 4; 6", 6},
	} {
		got := parseMaxPlayers(c.in)
		if got != c.want {
			t.Errorf("parseMaxPlayers(%q): got %d want %d", c.in, got, c.want)
		}
	}
}
