package tak

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// loadRetailMap decodes a retail TA:K map from the mounted install, skipping
// when none is available (CI carries no game data).
func loadRetailMap(t *testing.T) *Map {
	t.Helper()
	root := os.Getenv("TAK_UNPACKED_PATH")
	if root == "" {
		t.Skip("no TA:K install found — set TAK_UNPACKED_PATH to enable")
	}
	data, err := os.ReadFile(filepath.Join(root, "maps", "abnar's terrace.tnt"))
	if err != nil {
		t.Fatalf("read retail map: %v", err)
	}
	m, err := Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode retail map: %v", err)
	}
	return m
}

func TestFeatureNamesParseRetailTable(t *testing.T) {
	m := loadRetailMap(t)
	names := m.FeatureNames()
	if len(names) != int(m.Header.FeatureCount) {
		t.Fatalf("parsed %d names, header says %d", len(names), m.Header.FeatureCount)
	}
	for i, n := range names {
		if n == "" {
			t.Fatalf("feature %d has empty name", i)
		}
	}
	// Every placed grid index must resolve into the table.
	for i, v := range m.FeatureGrid {
		if v < NoFeatureThreshold && int(v) >= len(names) {
			t.Fatalf("grid cell %d holds index %d beyond table size %d", i, v, len(names))
		}
	}
}

func TestSetFeaturePlacementsRoundTrip(t *testing.T) {
	m := loadRetailMap(t)
	names := m.FeatureNames()
	if len(names) == 0 {
		t.Skip("retail map has no features")
	}

	// Re-anchor an existing feature plus a brand-new name; everything else
	// cleared. Coordinates picked inside the grid.
	existing := names[0]
	anchors := []FeatureAnchor{
		{X: 3, Y: 4, Name: existing},
		{X: 10, Y: 12, Name: "kbot_test_bush"},
		{X: -1, Y: 0, Name: existing}, // out of bounds — skipped
	}
	if skipped := m.SetFeaturePlacements(anchors); skipped != 1 {
		t.Fatalf("skipped = %d, want 1 (the out-of-bounds anchor)", skipped)
	}

	terrainBefore := append([]uint32(nil), m.TerrainNames...)
	heightBefore := append([]byte(nil), m.Height...)

	var buf bytes.Buffer
	if err := Encode(&buf, m); err != nil {
		t.Fatalf("encode: %v", err)
	}
	rt, err := Decode(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("re-decode: %v", err)
	}

	rtNames := rt.FeatureNames()
	if got := rtNames[rt.FeatureGrid[4*rt.W+3]]; got != existing {
		t.Fatalf("cell (3,4) = %q, want %q", got, existing)
	}
	if got := rtNames[rt.FeatureGrid[12*rt.W+10]]; got != "kbot_test_bush" {
		t.Fatalf("cell (10,12) = %q, want the appended feature", got)
	}
	placed := 0
	for _, v := range rt.FeatureGrid {
		if v < NoFeatureThreshold {
			placed++
		}
	}
	if placed != 2 {
		t.Fatalf("placed cells = %d, want exactly the 2 anchors", placed)
	}
	// Terrain + heights ride along untouched.
	if !bytes.Equal(rt.Height, heightBefore) {
		t.Fatal("heightmap changed across the feature round-trip")
	}
	for i := range terrainBefore {
		if rt.TerrainNames[i] != terrainBefore[i] {
			t.Fatalf("terrain name %d changed across the feature round-trip", i)
		}
	}
}
