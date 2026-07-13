package studio

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestEnrichFeatureDefsStandins(t *testing.T) {
	catalog := map[string]packFeatureJSON{
		"tree1":  {ID: "tree1", HeightWU: 40},
		"rock1":  {ID: "rock1", HeightWU: 8},
		"palm1":  {ID: "palm1", HeightWU: 80},
		"wreck1": {ID: "wreck1", Object: "armcom_dead"}, // real 3DO — never re-tiered
	}
	index := map[string]featureAssetEntry{
		"tree1":  {Tier: "model3d", Model: "trees_gaf_tree1"},
		"rock1":  {Tier: "decal"},
		"palm1":  {Tier: "billboard"},
		"wreck1": {Tier: "model3d", Model: "should_be_ignored"},
	}
	enrichFeatureDefsStandins(catalog, index)

	if got := catalog["tree1"]; got.Tier != "model3d" || got.Model3D != "trees_gaf_tree1" {
		t.Errorf("tree1: tier=%q model3d=%q", got.Tier, got.Model3D)
	}
	if got := catalog["rock1"]; got.Tier != "decal" || got.Sprite != "rock1" {
		t.Errorf("rock1: tier=%q sprite=%q", got.Tier, got.Sprite)
	}
	if got := catalog["palm1"]; got.Tier != "billboard" || got.Sprite != "palm1" {
		t.Errorf("palm1: tier=%q sprite=%q", got.Tier, got.Sprite)
	}
	if got := catalog["wreck1"]; got.Tier != "" || got.Model3D != "" {
		t.Errorf("object feature must not be re-tiered: tier=%q model3d=%q", got.Tier, got.Model3D)
	}
}

func TestHandleFeatureModel(t *testing.T) {
	dir := t.TempDir()
	modelsDir := filepath.Join(dir, "totala", "models")
	if err := os.MkdirAll(modelsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	geom := `{"h":60,"tris":2,"v":[0,0,0,0,0,1,1,0,0]}`
	if err := os.WriteFile(filepath.Join(modelsDir, "spire.json"), []byte(geom), 0o644); err != nil {
		t.Fatal(err)
	}
	sess := &Session{game: "totala", standinsDir: dir}

	// hit → the baked geometry
	req := httptest.NewRequest(http.MethodGet, "/api/studio/feature-model/spire", nil)
	rec := httptest.NewRecorder()
	sess.handleFeatureModel(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("model fetch: status %d", rec.Code)
	}
	var g map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &g); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}
	if g["h"].(float64) != 60 {
		t.Errorf("wrong geometry served: %v", g)
	}

	// miss → 404, and a traversal key can never escape the models dir
	for _, key := range []string{"nope", "..%2f..%2fsecret"} {
		rec := httptest.NewRecorder()
		sess.handleFeatureModel(rec, httptest.NewRequest(http.MethodGet, "/api/studio/feature-model/"+key, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("key %q: expected 404, got %d", key, rec.Code)
		}
	}

	// no bundle configured → 404
	empty := &Session{game: "totala"}
	rec = httptest.NewRecorder()
	empty.handleFeatureModel(rec, httptest.NewRequest(http.MethodGet, "/api/studio/feature-model/spire", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("no standins: expected 404, got %d", rec.Code)
	}
}
