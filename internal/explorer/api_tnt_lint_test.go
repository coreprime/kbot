package explorer

import (
	"encoding/json"
	"testing"

	"github.com/coreprime/kbot/formats/tnt"
)

// TestLintTNT_PopulatesResult walks a synthetic map with one duplicate
// tile and one unreferenced tile through the explorer's lint wiring
// and asserts the JSON-shaped fields the Lint tab reads from end up
// in the result map.
func TestLintTNT_PopulatesResult(t *testing.T) {
	tile := func(v byte) []byte {
		b := make([]byte, 1024)
		for i := range b {
			b[i] = v
		}
		return b
	}
	attrs := make([]tnt.TileAttr, 16)
	for i := range attrs {
		attrs[i] = tnt.TileAttr{Feature: 0xFFFF}
	}
	m := &tnt.Map{
		Header:   tnt.Header{IDVersion: 8192},
		TileW:    2,
		TileH:    2,
		AttrW:    4,
		AttrH:    4,
		TileMap:  []uint16{0, 1, 2, 0},
		TileAttr: attrs,
		Tiles: [][]byte{
			tile(10),
			tile(10), // exact duplicate of tile 0
			tile(20),
			tile(99), // unreferenced
		},
	}

	result := map[string]any{}
	lintTNT(m, result)

	if errStr, ok := result["lintError"]; ok {
		t.Fatalf("unexpected lintError: %v", errStr)
	}

	summary, ok := result["lintSummary"].(map[string]int)
	if !ok {
		t.Fatalf("lintSummary missing or wrong type: %T", result["lintSummary"])
	}
	if summary["duplicate-tiles"] != 1 {
		t.Errorf("duplicate-tiles summary = %d, want 1", summary["duplicate-tiles"])
	}
	if summary["unused-tiles"] != 1 {
		t.Errorf("unused-tiles summary = %d, want 1", summary["unused-tiles"])
	}

	// lintResults is the per-rule list the Lint tab iterates over.
	// Use the JSON round-trip the explorer would do over the wire,
	// since the in-memory slice element is an anonymous struct private
	// to lintTNT and not directly type-assertable here.
	raw, err := json.Marshal(result["lintResults"])
	if err != nil {
		t.Fatalf("marshal lintResults: %v", err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("unmarshal lintResults: %v\nraw=%s", err, raw)
	}
	if len(rows) < 2 {
		t.Fatalf("expected at least 2 lint rows (duplicate + unused), got %d: %s", len(rows), raw)
	}
	for _, r := range rows {
		if _, ok := r["rule"].(string); !ok {
			t.Errorf("row missing rule string: %+v", r)
		}
		if _, ok := r["message"].(string); !ok {
			t.Errorf("row missing message string: %+v", r)
		}
		if _, ok := r["count"]; !ok {
			t.Errorf("row missing count: %+v", r)
		}
	}
}
