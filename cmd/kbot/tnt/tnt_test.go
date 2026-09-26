package tnt

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/tnt"
	"github.com/coreprime/kbot-io/palettes"
	"github.com/coreprime/kbot-io/testutil"
)

// testMap returns a blank 4×4-tile TA map with two identical tiles, and a
// minimap built the game's way when minimap is set.
func testMap(t *testing.T, minimap bool) *tnt.Map {
	t.Helper()
	m := &tnt.Map{
		Header: tnt.Header{IDVersion: tnt.VersionTA},
		TileW:  4, TileH: 4, AttrW: 8, AttrH: 8,
		TileMap:  make([]uint16, 16),
		TileAttr: make([]tnt.TileAttr, 64),
		Tiles:    [][]byte{make([]byte, tnt.TileGfxSize), make([]byte, tnt.TileGfxSize)},
	}
	for i := range m.TileAttr {
		m.TileAttr[i].Feature = tnt.FeatureNone
	}
	if minimap {
		pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
		if err != nil {
			t.Fatal(err)
		}
		if err := m.BuildMinimap(pal.ColorModel()); err != nil {
			t.Fatal(err)
		}
	}
	return m
}

// writeMap saves m (keeping any out-of-range indices) to a temp .tnt.
func writeMap(t *testing.T, m *tnt.Map) string {
	t.Helper()
	var buf bytes.Buffer
	if err := m.SaveWithOptions(&buf, nil, tnt.SaveOptions{AllowUnresolvedIndices: true}); err != nil {
		t.Fatalf("save: %v", err)
	}
	p := filepath.Join(t.TempDir(), "test.tnt")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// run executes a tnt subcommand and returns its stdout, stderr and error.
func run(t *testing.T, cmd *cobra.Command, args ...string) (string, string, error) {
	t.Helper()
	var out, errOut bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errOut)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), errOut.String(), err
}

// legacyMapBytes returns a minimal 0x1020 TA map: 2×2 tiles, one tile
// graphic, 8-byte attribute records and no minimap.
func legacyMapBytes() []byte {
	const w, h = 4, 4 // attribute cells
	var buf bytes.Buffer
	hdr := tnt.Header{
		IDVersion:  tnt.VersionLegacy,
		Width:      w,
		Height:     h,
		PTRMapData: tnt.HeaderSize,
		PTRMapAttr: tnt.HeaderSize + (w/2)*(h/2)*2,
		Tiles:      1,
	}
	hdr.PTRTileGfx = hdr.PTRMapAttr + w*h*8
	hdr.PTRTileAnim = hdr.PTRTileGfx + tnt.TileGfxSize
	_ = binary.Write(&buf, binary.LittleEndian, &hdr)
	buf.Write(make([]byte, (w/2)*(h/2)*2))
	for i := 0; i < w*h; i++ {
		rec := [8]byte{40, 0, 0xFF}
		buf.Write(rec[:])
	}
	buf.Write(make([]byte, tnt.TileGfxSize))
	return buf.Bytes()
}

// TestDescribeNamesFormatAndMinimapFlags checks 'kbot tnt describe' says
// which game reads the map and whether the game reads its minimap.
func TestDescribeNamesFormatAndMinimapFlags(t *testing.T) {
	out, _, err := run(t, newTNTDescribeCommand(), writeMap(t, testMap(t, true)))
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	for _, want := range []string{"IDVersion:   0x2000 (Total Annihilation)", "MinimapFlags: 1 (bit 0 set"} {
		if !strings.Contains(out, want) {
			t.Errorf("describe output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Unknown1") {
		t.Errorf("describe still labels the minimap flags Unknown1:\n%s", out)
	}

	out, _, err = run(t, newTNTDescribeCommand(), writeMap(t, testMap(t, false)))
	if err != nil || !strings.Contains(out, "MinimapFlags: 0 (not read") {
		t.Errorf("no-minimap describe: %v\n%s", err, out)
	}

	legacy := filepath.Join(t.TempDir(), "old.tnt")
	if err := os.WriteFile(legacy, legacyMapBytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	out, _, err = run(t, newTNTDescribeCommand(), legacy)
	if err != nil || !strings.Contains(out, "0x1020 (older TA layout") {
		t.Errorf("0x1020 describe: %v\n%s", err, out)
	}
}

// TestDescribeLabelsKingdomsMaps checks a TA: Kingdoms map is labelled as
// one TA cannot load.
func TestDescribeLabelsKingdomsMaps(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "maps", "abnar's terrace.tnt")
	out, _, err := run(t, newTNTDescribeCommand(), path)
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	if !strings.Contains(out, "TA: Kingdoms only; Total Annihilation cannot load it") {
		t.Errorf("TA: Kingdoms describe lacks the label:\n%s", out)
	}
}

// TestLintReportsBadTileIndices checks 'kbot tnt lint' on a map with a tile
// index past its tile set and a duplicate tile reports the bad index (in
// the human output and SARIF) instead of crashing.
func TestLintReportsBadTileIndices(t *testing.T) {
	m := testMap(t, true)
	m.TileMap[5] = 9 // only tiles 0 and 1 exist
	path := writeMap(t, m)
	vfsRoot := t.TempDir()

	_, errOut, err := run(t, newTNTLintCommand(), path, "--vfs", vfsRoot, "--no-quality", "--similarity", "0")
	if err == nil {
		t.Fatalf("lint passed a map with a bad tile index:\n%s", errOut)
	}
	for _, want := range []string{"Map data:", "bad-tile-index", "duplicate-tiles"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("lint output lacks %q:\n%s", want, errOut)
		}
	}

	out, _, _ := run(t, newTNTLintCommand(), path, "--vfs", vfsRoot, "--no-quality", "--similarity", "0", "--ci")
	if !strings.Contains(out, `"tnt.bad-tile-index"`) {
		t.Errorf("SARIF lacks tnt.bad-tile-index:\n%s", out)
	}
}

// TestOptimizeKeepsBadTileIndices checks 'kbot tnt optimize' rewrites a map
// holding a tile index past its tile set without crashing or refusing, and
// keeps the index.
func TestOptimizeKeepsBadTileIndices(t *testing.T) {
	m := testMap(t, true)
	m.TileMap[5] = 9
	path := writeMap(t, m)
	target := filepath.Join(t.TempDir(), "out.tnt")
	_, errOut, err := run(t, newTNTOptimizeCommand(), path, "--target", target, "--similarity", "0")
	if err != nil {
		t.Fatalf("optimize: %v\n%s", err, errOut)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	got, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(got.Tiles) != 1 || got.TileMap[5] != 9 {
		t.Errorf("optimized map: %d tiles, cell 5 = %d; want the duplicate merged and index 9 kept", len(got.Tiles), got.TileMap[5])
	}
}

// TestPackRefusesBadIndices checks 'kbot tnt pack' refuses tilemap.csv
// values that are not tile indices of the map (-1, or 70000, which would
// wrap to 4464) instead of writing them.
func TestPackRefusesBadIndices(t *testing.T) {
	pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"1", "-1", "70000", "2"} {
		dir := t.TempDir()
		if err := tnt.Unpack(testMap(t, true), nil, pal.ColorModel(), dir); err != nil {
			t.Fatalf("unpack: %v", err)
		}
		csvPath := filepath.Join(dir, "tilemap.csv")
		csv, err := os.ReadFile(csvPath)
		if err != nil {
			t.Fatal(err)
		}
		edited := strings.Replace(string(csv), "0", bad, 1)
		if err := os.WriteFile(csvPath, []byte(edited), 0o644); err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(t.TempDir(), "packed.tnt")
		_, _, err = run(t, newTNTPackCommand(), dir, "--target", target)
		if bad == "1" { // a real tile index: packs fine
			if err != nil {
				t.Errorf("pack refused valid tile index 1: %v", err)
			}
			continue
		}
		if err == nil {
			t.Errorf("pack accepted tile index %s", bad)
		}
	}
}

// TestPlacementsOnlyWhereTheGamePlaces checks describe and features count
// only the cells the game places a feature on: a word naming a table entry,
// not a word past the table, void (0xFFFC) or another sentinel.
func TestPlacementsOnlyWhereTheGamePlaces(t *testing.T) {
	m := testMap(t, true)
	m.TileAttr[0].Feature = 0 // Rock1
	m.TileAttr[1].Feature = 5 // past the one-entry table
	m.TileAttr[2].Feature = tnt.FeatureVoid
	m.TileAttr[3].Feature = 0xFFFD
	var buf bytes.Buffer
	features := []tnt.Feature{{Index: 0, Name: "Rock1"}}
	if err := m.SaveWithOptions(&buf, features, tnt.SaveOptions{AllowUnresolvedIndices: true}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "feats.tnt")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	out, _, err := run(t, newTNTDescribeCommand(), path)
	if err != nil || !strings.Contains(out, "Features:    1 in table, 1 placements") {
		t.Errorf("describe: %v\n%s", err, out)
	}
	out, _, err = run(t, newTNTFeaturesCommand(), path)
	if err != nil {
		t.Fatalf("features: %v", err)
	}
	var doc featuresDoc
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("decode: %v\n%s", err, out)
	}
	if len(doc.Placements) != 1 || doc.Placements[0].Name != "Rock1" {
		t.Errorf("placements = %+v, want only Rock1", doc.Placements)
	}
}
