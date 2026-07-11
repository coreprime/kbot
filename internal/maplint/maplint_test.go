package maplint

import (
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/formats/tnt"
)

// TestCheckDuplicateTilesDetectsRepeat seeds a tile pool with two
// byte-identical entries and confirms the dedup check flags them as
// a warning.
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
	d := CheckDuplicateTiles(Input{Map: m})
	if d.Severity != SeverityWarning {
		t.Fatalf("expected warning, got %q (%s)", d.Severity, d.Message)
	}
}

func TestCheckDuplicateTilesUniqueIsOK(t *testing.T) {
	a := make([]byte, 1024)
	b := make([]byte, 1024)
	for i := range b {
		b[i] = 1
	}
	m := &tnt.Map{Tiles: [][]byte{a, b}}
	d := CheckDuplicateTiles(Input{Map: m})
	if d.Severity != SeverityOK {
		t.Fatalf("expected ok, got %q (%s)", d.Severity, d.Message)
	}
}

func TestCheckDuplicateTilesAfterFixIsOK(t *testing.T) {
	tile := make([]byte, 1024)
	m := &tnt.Map{Tiles: [][]byte{tile, tile}}
	d := CheckDuplicateTiles(Input{Map: m, AppliedFixes: []string{"compressTiles"}})
	if d.Severity != SeverityOK {
		t.Fatalf("expected ok after compressTiles applied, got %q", d.Severity)
	}
}

// minimalMap builds a 4×4-tile (8×8-attr) test map with every cell
// passable at height 80.
func minimalMap() *tnt.Map {
	attrW, attrH := 8, 8
	attrs := make([]tnt.TileAttr, attrW*attrH)
	for i := range attrs {
		attrs[i] = tnt.TileAttr{Height: 80, Feature: 0xFFFF}
	}
	return &tnt.Map{AttrW: attrW, AttrH: attrH, TileW: 4, TileH: 4, TileAttr: attrs}
}

func TestStartPositionsInBoundsDetectsVoid(t *testing.T) {
	m := minimalMap()
	m.TileAttr[4*m.AttrW+4].Feature = VoidFeature
	ota := &OTAInfo{Schemas: []SchemaInfo{{StartPos: []StartPos{{Number: 1, X: 64, Z: 64}}}}}
	d := CheckStartPositionsInBounds(Input{Map: m, OTA: ota})
	if d.Severity != SeverityWarning {
		t.Fatalf("expected warning, got %q (%s)", d.Severity, d.Message)
	}
}

func TestStartPositionsInBoundsOOB(t *testing.T) {
	m := minimalMap()
	ota := &OTAInfo{Schemas: []SchemaInfo{{StartPos: []StartPos{{Number: 1, X: 9999, Z: 9999}}}}}
	d := CheckStartPositionsInBounds(Input{Map: m, OTA: ota})
	if d.Severity != SeverityWarning {
		t.Fatalf("expected warning, got %q", d.Severity)
	}
}

func TestHeightDiscontinuities(t *testing.T) {
	m := minimalMap()
	m.TileAttr[3*m.AttrW+3].Height = 240
	d := CheckHeightDiscontinuities(Input{Map: m})
	if d.Severity != SeverityWarning {
		t.Fatalf("expected warning, got %q (%s)", d.Severity, d.Message)
	}
}

func TestHeightDiscontinuitiesSmooth(t *testing.T) {
	d := CheckHeightDiscontinuities(Input{Map: minimalMap()})
	if d.Severity != SeverityOK {
		t.Fatalf("flat map should pass, got %q", d.Severity)
	}
}

func TestMissingOTAFields(t *testing.T) {
	ota := &OTAInfo{
		MissionName: "", Planet: "",
		NumPlayers: "2, 3, 4", Size: "8x8",
		Schemas: []SchemaInfo{{Name: "Default", StartPos: []StartPos{{Number: 1, X: 64, Z: 64}}}},
	}
	d := CheckMissingOTAFields(Input{OTA: ota})
	if d.Severity != SeverityWarning {
		t.Fatalf("expected warning, got %q", d.Severity)
	}
}

func TestSchemaSlotsGapInCoverage(t *testing.T) {
	ota := &OTAInfo{
		NumPlayers: "2, 4, 8",
		Schemas: []SchemaInfo{
			{Name: "Net2", StartPos: makeStarts(2)},
			{Name: "Net4", StartPos: makeStarts(4)},
		},
	}
	d := CheckSchemaSlotsVsPlayers(Input{OTA: ota})
	if d.Severity != SeverityWarning {
		t.Fatalf("expected warning, got %q", d.Severity)
	}
	if !strings.Contains(d.Message, "8") {
		t.Errorf("expected message to mention 8, got %q", d.Message)
	}
}

func TestSchemaSlotsFullCoverage(t *testing.T) {
	ota := &OTAInfo{
		NumPlayers: "2, 4, 8",
		Schemas: []SchemaInfo{
			{Name: "Net2", StartPos: makeStarts(2)},
			{Name: "Net4", StartPos: makeStarts(4)},
			{Name: "Net8", StartPos: makeStarts(8)},
		},
	}
	d := CheckSchemaSlotsVsPlayers(Input{OTA: ota})
	if d.Severity != SeverityOK {
		t.Fatalf("expected ok, got %q (%s)", d.Severity, d.Message)
	}
}

func TestSchemaSlotsThinSchemaFailsHighCount(t *testing.T) {
	ota := &OTAInfo{
		NumPlayers: "8",
		Schemas:    []SchemaInfo{{Name: "Thin", StartPos: makeStarts(4)}},
	}
	d := CheckSchemaSlotsVsPlayers(Input{OTA: ota})
	if d.Severity != SeverityWarning {
		t.Fatalf("expected warning, got %q", d.Severity)
	}
}

func TestSchemaSlotsMetalHeckCoverage(t *testing.T) {
	ota := &OTAInfo{
		NumPlayers: "2, 3, 4, 5, 7, 8",
		Schemas: []SchemaInfo{
			{Name: "S1", Type: "Network 1", StartPos: makeStarts(10)},
			{Name: "S2", Type: "Network 2", StartPos: makeStarts(3)},
			{Name: "S3", Type: "Network 3", StartPos: makeStarts(5)},
			{Name: "S4", Type: "Network 4", StartPos: makeStarts(7)},
		},
	}
	d := CheckSchemaSlotsVsPlayers(Input{OTA: ota})
	if d.Severity != SeverityOK {
		t.Fatalf("expected ok for Metal Heck coverage, got %q (%s)", d.Severity, d.Message)
	}
}

func TestCheckMetalProximityMetalRichSkips(t *testing.T) {
	ota := &OTAInfo{Schemas: []SchemaInfo{{
		Name: "Metal", SurfaceMetal: 255,
		StartPos: []StartPos{{Number: 1, X: 64, Z: 64}},
	}}}
	d := CheckMetalProximity(Input{OTA: ota})
	if d.Severity != SeverityOK {
		t.Fatalf("expected ok for metal-rich map, got %q (%s)", d.Severity, d.Message)
	}
}

func TestVoidIslandsTolerance(t *testing.T) {
	m := minimalMap()
	for _, off := range [][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}} {
		m.TileAttr[(6+off[1])*m.AttrW+(6+off[0])].Feature = VoidFeature
	}
	ota := &OTAInfo{Schemas: []SchemaInfo{{StartPos: []StartPos{{Number: 1, X: 16, Z: 16}}}}}
	d := CheckVoidIslands(Input{Map: m, OTA: ota})
	if d.Severity != SeverityOK {
		t.Fatalf("expected ok under tolerance, got %q (%s)", d.Severity, d.Message)
	}
}

func TestVoidIslandsAboveTolerance(t *testing.T) {
	attrW, attrH := 16, 16
	attrs := make([]tnt.TileAttr, attrW*attrH)
	for i := range attrs {
		attrs[i] = tnt.TileAttr{Height: 80, Feature: 0xFFFF}
	}
	m := &tnt.Map{AttrW: attrW, AttrH: attrH, TileW: 8, TileH: 8, TileAttr: attrs}
	for y := 0; y < attrH; y++ {
		m.TileAttr[y*attrW+5].Feature = VoidFeature
	}
	ota := &OTAInfo{Schemas: []SchemaInfo{{StartPos: []StartPos{{Number: 1, X: 16, Z: 16}}}}}
	d := CheckVoidIslands(Input{Map: m, OTA: ota})
	if d.Severity != SeverityWarning {
		t.Fatalf("expected warning for stranded cells, got %q (%s)", d.Severity, d.Message)
	}
}

func TestParsePlayerCounts(t *testing.T) {
	for _, c := range []struct {
		in   string
		want []int
	}{
		{"2, 3, 4", []int{2, 3, 4}},
		{"  8  ", []int{8}},
		{"", nil},
		{"foo", nil},
		{"2; 4; 6", []int{2, 4, 6}},
	} {
		got := ParsePlayerCounts(c.in)
		if len(got) != len(c.want) {
			t.Errorf("ParsePlayerCounts(%q): got %v want %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("ParsePlayerCounts(%q)[%d]: got %d want %d", c.in, i, got[i], c.want[i])
			}
		}
	}
}

func makeStarts(n int) []StartPos {
	out := make([]StartPos, n)
	for i := range out {
		out[i] = StartPos{Number: i + 1, X: (i + 1) * 32, Z: (i + 1) * 32}
	}
	return out
}
