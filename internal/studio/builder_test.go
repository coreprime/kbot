package studio

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/formats/tnt"
)

// TestBuildMapMinimal verifies an empty map (no section stamps) produces a
// valid TNT round-trip: the writer accepts the structure and a fresh parse
// reads back the same dimensions, height defaults, and tile-pool placeholder.
func TestBuildMapMinimal(t *testing.T) {
	// buildMap reads section files through the package-global vfs; for an
	// empty stamp list we never touch it, so leaving it nil is fine.
	sess := newSession("test", "test", nil, t.TempDir())

	req := saveRequest{
		MapName:  "smoke",
		TileW:    16,
		TileH:    16,
		DefaultH: 90,
	}
	m, features, err := sess.buildMap(req)
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

// TestBuildOTAContents checks the .ota a new map gets (no source file)
// carries the required GlobalHeader keys and at least one StartPos so the
// game will load it.
func TestBuildOTAContents(t *testing.T) {
	data, warning, err := otaForSave(saveRequest{
		MapName:     "smoke",
		DisplayName: "Smoke Test",
		TileW:       32,
		TileH:       32,
		Planet:      "Green",
	})
	if err != nil || warning != "" {
		t.Fatalf("otaForSave: %v (warning %q)", err, warning)
	}
	ota := string(data)
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

// TestBuildMapMinimapAndHeader checks the TNT the editor saves is laid out
// as the game's own maps: bit 0 of the 0x2c minimap flags set, the minimap's
// map region sized from the map (longer side 252, the other from the
// visible map's aspect) and filled, the rest padding, and the header's
// feature count set on the in-memory map too.
func TestBuildMapMinimapAndHeader(t *testing.T) {
	sess := newSession("test", "test", nil, t.TempDir())
	req := saveRequest{
		MapName: "wide", TileW: 64, TileH: 32,
		Features: []saveFeature{{Name: "Rock1", AX: 3, AY: 4}, {Name: "Tree2", AX: 10, AY: 4}, {Name: "rock1", AX: 20, AY: 20}},
	}
	m, features, err := sess.buildMap(req)
	if err != nil {
		t.Fatalf("buildMap: %v", err)
	}
	if len(features) != 2 || m.Header.TileAnims != 2 {
		t.Fatalf("features = %d, TileAnims = %d; want 2 and 2", len(features), m.Header.TileAnims)
	}
	if m.Header.MinimapFlags()&tnt.MinimapPresent == 0 {
		t.Errorf("in-memory header minimap flags = %#x, want bit 0 set", m.Header.MinimapFlags())
	}
	// Export › Build map renders the in-memory map: the feature cell must
	// read as blocked, not open ground.
	img := m.RenderBuildMap(m.Header.SeaLevel)
	if got, open := img.RGBAAt(3, 4), img.RGBAAt(5, 5); got == open {
		t.Errorf("feature cell renders like open ground (%v)", got)
	}

	var buf bytes.Buffer
	if err := m.Save(&buf, features); err != nil {
		t.Fatalf("Save: %v", err)
	}
	parsed, err := tnt.LoadFromReader(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if parsed.Header.MinimapFlags()&tnt.MinimapPresent == 0 {
		t.Fatalf("saved 0x2c flags = %#x, want bit 0 set", parsed.Header.MinimapFlags())
	}
	cw, ch := tnt.MinimapContentSize(parsed.AttrW, parsed.AttrH)
	if cw != 252 || ch != 112 {
		t.Fatalf("content region %dx%d, want 252x112 for a 64x32-tile map", cw, ch)
	}
	if gw, gh := parsed.MinimapContentBounds(); gw != cw || gh != ch {
		t.Errorf("MinimapContentBounds = %dx%d, want %dx%d", gw, gh, cw, ch)
	}
	at := func(x, y int) byte { return parsed.Minimap[y*parsed.MinimapW+x] }
	for _, p := range [][2]int{{0, 0}, {251, 0}, {0, ch - 1}, {251, ch - 1}, {126, 56}} {
		if at(p[0], p[1]) == tnt.MinimapVoidByte {
			t.Errorf("minimap (%d,%d) is padding; the map region should be filled", p[0], p[1])
		}
	}
	for _, p := range [][2]int{{0, ch}, {251, 251}} {
		if at(p[0], p[1]) != tnt.MinimapVoidByte {
			t.Errorf("minimap (%d,%d) = %#x, want padding %#x", p[0], p[1], at(p[0], p[1]), tnt.MinimapVoidByte)
		}
	}
}

// TestBuildMapRefusesTooManyFeatures checks a map placing 0xFFFB different
// features is refused: its feature words would collide with the sentinels.
func TestBuildMapRefusesTooManyFeatures(t *testing.T) {
	sess := newSession("test", "test", nil, t.TempDir())
	req := saveRequest{MapName: "busy", TileW: 128, TileH: 128}
	for i := 0; i < int(tnt.FeatureSentinelFloor); i++ {
		req.Features = append(req.Features, saveFeature{Name: fmt.Sprintf("f%d", i), AX: i % 256, AY: i / 256})
	}
	if _, _, err := sess.buildMap(req); err == nil || !strings.Contains(err.Error(), "feature") {
		t.Fatalf("buildMap with %d features: err = %v, want a feature-count error", len(req.Features), err)
	}
	req.Features = req.Features[:int(tnt.FeatureSentinelFloor)-1]
	if _, features, err := sess.buildMap(req); err != nil || len(features) != int(tnt.FeatureSentinelFloor)-1 {
		t.Fatalf("buildMap with %d features: %v", len(req.Features), err)
	}
}

// TestBuildMapRefusesTooManyTiles checks a map needing more distinct tiles
// than a TNT can index is refused instead of written with wrapped indices.
func TestBuildMapRefusesTooManyTiles(t *testing.T) {
	sess := newSession("test", "test", nil, t.TempDir())
	src := &tnt.Map{Tiles: [][]byte{make([]byte, 1024), make([]byte, 1024), make([]byte, 1024)}}
	for i, tile := range src.Tiles {
		for j := range tile {
			tile[j] = byte(i + 1)
		}
	}
	sess.cacheTNT("maps/src.tnt", src)
	req := saveRequest{MapName: "tiles", TileW: 2, TileH: 1}
	req.Tiles = []*saveStamp{
		{SectionPath: "tnt:maps/src.tnt", SX: 0, SY: 0},
		{SectionPath: "tnt:maps/src.tnt", SX: 1, SY: 0},
	}
	old := maxEditorTiles
	t.Cleanup(func() { maxEditorTiles = old })
	maxEditorTiles = 3 // the blank tile plus two stamped ones fit
	if _, _, err := sess.buildMap(req); err != nil {
		t.Fatalf("buildMap within the limit: %v", err)
	}
	maxEditorTiles = 2
	if _, _, err := sess.buildMap(req); err == nil || !strings.Contains(err.Error(), "tiles") {
		t.Fatalf("buildMap over the limit: err = %v, want a tile-count error", err)
	}
}

// TestRotateTile32 checks rotateTile32 against a small marker pattern.
// We mark the corner pixel at (0,0) with value 1 and verify it migrates
// to the expected new corner after each quarter-turn.
func TestRotateTile32(t *testing.T) {
	tile := make([]byte, 1024)
	tile[0] = 1    // top-left
	tile[31] = 2   // top-right
	tile[992] = 3  // bottom-left (row 31, col 0)
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
	sess := newSession("test", "test", nil, t.TempDir())

	req := saveRequest{
		MapName:     "smoke",
		DisplayName: "Smoke",
		TileW:       32,
		TileH:       32,
	}
	hpi, _, err := sess.buildHPI(req)
	if err != nil {
		t.Fatalf("buildHPI: %v", err)
	}
	if len(hpi) < 64 {
		t.Fatalf("hpi too small: %d bytes", len(hpi))
	}
	if string(hpi[:4]) != "HAPI" {
		t.Fatalf("hpi magic: got %q want HAPI", string(hpi[:4]))
	}
	assertGameMountable(t, hpi)
}
