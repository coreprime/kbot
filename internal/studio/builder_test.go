package studio

import (
	"bytes"
	"strings"
	"testing"

	"github.com/coreprime/kbot/formats/tnt"
)

// TestBuildMapMinimal verifies an empty map (no section stamps) produces a
// valid TNT round-trip: the writer accepts the structure and a fresh parse
// reads back the same dimensions, height defaults, and tile-pool placeholder.
func TestBuildMapMinimal(t *testing.T) {
	// buildMap reads section files through the package-global vfs; for an
	// empty stamp list we never touch it, so leaving it nil is fine.
	prev := vfs
	vfs = nil
	defer func() { vfs = prev }()

	req := saveRequest{
		MapName:  "smoke",
		TileW:    16,
		TileH:    16,
		DefaultH: 90,
	}
	m, features, err := buildMap(req)
	if err != nil {
		t.Fatalf("buildMap: %v", err)
	}
	if m.TileW != 16 || m.TileH != 16 {
		t.Fatalf("dims: got %dx%d want 16x16", m.TileW, m.TileH)
	}
	if m.AttrW != 32 || m.AttrH != 32 {
		t.Fatalf("attr dims: got %dx%d want 32x32", m.AttrW, m.AttrH)
	}
	if len(features) != 0 {
		t.Fatalf("features: got %d want 0", len(features))
	}
	if len(m.Tiles) == 0 {
		t.Fatalf("tile pool is empty — expected the blank placeholder tile")
	}
	if m.TileAttr[0].Height != 90 {
		t.Fatalf("default height not applied: got %d want 90", m.TileAttr[0].Height)
	}

	var buf bytes.Buffer
	if err := m.Save(&buf, features); err != nil {
		t.Fatalf("Save: %v", err)
	}

	parsed, err := tnt.LoadFromReader(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("parse round-trip: %v", err)
	}
	if parsed.TileW != 16 || parsed.TileH != 16 {
		t.Fatalf("round-trip dims: got %dx%d want 16x16", parsed.TileW, parsed.TileH)
	}
	if parsed.MinimapW != 252 || parsed.MinimapH != 252 {
		t.Fatalf("round-trip minimap: got %dx%d want 252x252", parsed.MinimapW, parsed.MinimapH)
	}
}

// TestBuildOTAContents checks the .ota text carries the required GlobalHeader
// keys and at least one StartPos so the game will load it.
func TestBuildOTAContents(t *testing.T) {
	ota := buildOTA(saveRequest{
		MapName:     "smoke",
		DisplayName: "Smoke Test",
		TileW:       32,
		TileH:       32,
		Planet:      "Green",
	})
	for _, want := range []string{
		"[GlobalHeader]",
		"missionname=Smoke Test;",
		"planet=Green;",
		"SCHEMACOUNT=1;",
		"[Schema 0]",
		"[specials]",
		"specialwhat=StartPos1;",
	} {
		if !strings.Contains(ota, want) {
			t.Errorf("OTA missing %q\nfull:\n%s", want, ota)
		}
	}
}

// TestRotateTile32 checks rotateTile32 against a small marker pattern.
// We mark the corner pixel at (0,0) with value 1 and verify it migrates
// to the expected new corner after each quarter-turn.
func TestRotateTile32(t *testing.T) {
	tile := make([]byte, 1024)
	tile[0] = 1   // top-left
	tile[31] = 2  // top-right
	tile[992] = 3 // bottom-left (row 31, col 0)
	tile[1023] = 4 // bottom-right

	r1 := rotateTile32(tile, 1) // 90° CW: TL→TR, TR→BR, BR→BL, BL→TL
	if r1[31] != 1 {
		t.Errorf("90° CW: corner (0,0)=1 should be at (0,31); got tile[31]=%d", r1[31])
	}
	if r1[1023] != 2 {
		t.Errorf("90° CW: corner (0,31)=2 should be at (31,31)")
	}
	if r1[0] != 3 {
		t.Errorf("90° CW: corner (31,0)=3 should be at (0,0)")
	}
	if r1[992] != 4 {
		t.Errorf("90° CW: corner (31,31)=4 should be at (31,0)")
	}

	r2 := rotateTile32(tile, 2)
	if r2[1023] != 1 || r2[992] != 2 || r2[31] != 3 || r2[0] != 4 {
		t.Errorf("180° rotation didn't swap diagonal corners as expected")
	}

	// Round-trip — rotating 4 times returns the original.
	rRoundtrip := rotateTile32(rotateTile32(rotateTile32(rotateTile32(tile, 1), 1), 1), 1)
	for i, v := range tile {
		if rRoundtrip[i] != v {
			t.Fatalf("4× 90° rotation didn't restore the original at index %d (%d vs %d)", i, rRoundtrip[i], v)
		}
	}
}

// TestFlipTile32 checks corner migration for horizontal, vertical, and
// combined flips.  Combined flip equals 180° rotation.
func TestFlipTile32(t *testing.T) {
	tile := make([]byte, 1024)
	tile[0] = 1    // top-left
	tile[31] = 2   // top-right
	tile[992] = 3  // bottom-left
	tile[1023] = 4 // bottom-right

	h := flipTile32(tile, true, false)
	if h[31] != 1 || h[0] != 2 || h[1023] != 3 || h[992] != 4 {
		t.Errorf("horizontal flip: corners didn't mirror left↔right")
	}

	v := flipTile32(tile, false, true)
	if v[992] != 1 || v[1023] != 2 || v[0] != 3 || v[31] != 4 {
		t.Errorf("vertical flip: corners didn't mirror top↔bottom")
	}

	hv := flipTile32(tile, true, true)
	if hv[1023] != 1 || hv[992] != 2 || hv[31] != 3 || hv[0] != 4 {
		t.Errorf("H+V flip didn't swap diagonals like a 180° rotation")
	}

	// Double-flip returns the original (involution on each axis).
	round := flipTile32(flipTile32(tile, true, false), true, false)
	for i, want := range tile {
		if round[i] != want {
			t.Fatalf("double H-flip didn't restore index %d", i)
		}
	}
}

// TestBuildHPIEndToEnd builds an HPI from a stamp-free save request and
// checks the resulting bytes have the HAPI marker.  buildHPI / buildMap
// don't touch the VFS when no sections are referenced, so we can run it
// with vfs = nil.
func TestBuildHPIEndToEnd(t *testing.T) {
	prev := vfs
	vfs = nil
	defer func() { vfs = prev }()

	req := saveRequest{
		MapName:     "smoke",
		DisplayName: "Smoke",
		TileW:       32,
		TileH:       32,
	}
	hpi, err := buildHPI(req)
	if err != nil {
		t.Fatalf("buildHPI: %v", err)
	}
	if len(hpi) < 64 {
		t.Fatalf("hpi too small: %d bytes", len(hpi))
	}
	if string(hpi[:4]) != "HAPI" {
		t.Fatalf("hpi magic: got %q want HAPI", string(hpi[:4]))
	}
}
