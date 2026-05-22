package studio

import (
	"strings"
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

// TestSchemaSlotsVsPlayersGapInCoverage uses a numplayers list with
// one count that no schema can host and confirms the warning fires.
func TestSchemaSlotsVsPlayersGapInCoverage(t *testing.T) {
	req := saveRequest{OTA: &otaState{
		NumPlayers: "2, 4, 8",
		Schemas: []otaSchema{
			{Name: "Net2", Type: "Network 2", StartPos: starts(2)},
			{Name: "Net4", Type: "Network 4", StartPos: starts(4)},
			// No Network 8 schema — the 8-player count is uncovered.
		},
	}}
	issue := checkSchemaSlotsVsPlayersOK(req, t, false)
	if !strings.Contains(issue.Message, "8") {
		t.Errorf("expected message to call out the uncovered count 8, got %q", issue.Message)
	}
}

// TestSchemaSlotsVsPlayersFullCoverage confirms that as long as some
// schema (not necessarily every schema) can host each declared count,
// the check passes.
func TestSchemaSlotsVsPlayersFullCoverage(t *testing.T) {
	req := saveRequest{OTA: &otaState{
		NumPlayers: "2, 4, 8",
		Schemas: []otaSchema{
			{Name: "Net2", Type: "Network 2", StartPos: starts(2)},
			{Name: "Net4", Type: "Network 4", StartPos: starts(4)},
			{Name: "Net8", Type: "Network 8", StartPos: starts(8)},
		},
	}}
	checkSchemaSlotsVsPlayersOK(req, t, true)
}

// TestSchemaSlotsThinSchemaFailsHighCount confirms a schema with
// only 4 start positions can't host an 8-player game, so an
// 8-player numplayers value should fail regardless of Type label.
func TestSchemaSlotsThinSchemaFailsHighCount(t *testing.T) {
	req := saveRequest{OTA: &otaState{
		NumPlayers: "8",
		Schemas: []otaSchema{
			{Name: "Thin", StartPos: starts(4)},
		},
	}}
	checkSchemaSlotsVsPlayersOK(req, t, false)
}

// TestSchemaSlotsMetalHeckCoverage replicates the stock Metal Heck
// OTA layout (4 schemas with 10/3/5/7 starts, numplayers covering
// 2-8 except 6 and 9-10) and confirms the check passes — the
// 10-start schema covers all declared counts.
func TestSchemaSlotsMetalHeckCoverage(t *testing.T) {
	req := saveRequest{OTA: &otaState{
		NumPlayers: "2, 3, 4, 5, 7, 8",
		Schemas: []otaSchema{
			{Name: "S1", Type: "Network 1", StartPos: starts(10)},
			{Name: "S2", Type: "Network 2", StartPos: starts(3)},
			{Name: "S3", Type: "Network 3", StartPos: starts(5)},
			{Name: "S4", Type: "Network 4", StartPos: starts(7)},
		},
	}}
	checkSchemaSlotsVsPlayersOK(req, t, true)
}

// starts builds a slice of n placeholder StartPos for tests.
func starts(n int) []saveStartPos {
	out := make([]saveStartPos, n)
	for i := range out {
		out[i] = saveStartPos{Number: i + 1, X: (i + 1) * 32, Z: (i + 1) * 32}
	}
	return out
}

// checkSchemaSlotsVsPlayersOK runs the check and asserts the
// severity matches the expectation.  Returns the issue for further
// assertions in the caller.
func checkSchemaSlotsVsPlayersOK(req saveRequest, t *testing.T, wantOK bool) qualityIssue {
	t.Helper()
	issue := checkSchemaSlotsVsPlayers(req)
	got := issue.Severity == "ok"
	if got != wantOK {
		t.Fatalf("severity mismatch: got %q (%s), wantOK=%v", issue.Severity, issue.Message, wantOK)
	}
	return issue
}

// TestCheckMetalProximityMetalRichSkips confirms a schema with a
// surface metal value at or above the threshold skips the proximity
// check entirely.
func TestCheckMetalProximityMetalRichSkips(t *testing.T) {
	req := saveRequest{OTA: &otaState{
		Schemas: []otaSchema{{
			Name:         "Metal",
			SurfaceMetal: 255,
			StartPos:     []saveStartPos{{Number: 1, X: 64, Z: 64}},
		}},
	}}
	issue := checkMetalProximity(req)
	if issue.Severity != "ok" {
		t.Fatalf("expected ok for metal-rich map, got %q (%s)", issue.Severity, issue.Message)
	}
}

// TestVoidIslandsTolerance confirms a single stranded cell stays
// inside the noise floor and reports ok.
func TestVoidIslandsTolerance(t *testing.T) {
	m := minimalMap()
	// Surround (6,6) with voids so it strands as a single cell.
	for _, off := range [][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}} {
		m.TileAttr[(6+off[1])*m.AttrW+(6+off[0])].Feature = voidFeatureLow
	}
	req := saveRequest{OTA: &otaState{
		Schemas: []otaSchema{{StartPos: []saveStartPos{{Number: 1, X: 16, Z: 16}}}},
	}}
	issue := checkVoidIslands(m, req)
	if issue.Severity != "ok" {
		t.Fatalf("expected ok under tolerance, got %q (%s)", issue.Severity, issue.Message)
	}
}

// TestVoidIslands carves an isolated land patch large enough to
// clear the voidIslandsTolerance noise floor and confirms the
// flood-fill labels it stranded.
func TestVoidIslands(t *testing.T) {
	// 16×16 attr grid so the stranded region is 16×10 = 160 cells,
	// well above the 20-cell tolerance.
	attrW, attrH := 16, 16
	attrs := make([]tnt.TileAttr, attrW*attrH)
	for i := range attrs {
		attrs[i] = tnt.TileAttr{Height: 80, Feature: 0xFFFF}
	}
	m := &tnt.Map{AttrW: attrW, AttrH: attrH, TileW: 8, TileH: 8, TileAttr: attrs}
	// Wall off the right 10 columns with a continuous void strip — the
	// cells beyond are passable but unreachable from a start on the left.
	for y := 0; y < attrH; y++ {
		m.TileAttr[y*attrW+5].Feature = voidFeatureLow
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
