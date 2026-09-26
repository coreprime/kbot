package assetrender

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot/internal/aiprofile"
)

func newRendererWithUnits(t *testing.T, fbis map[string]string) *Renderer {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "units"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range fbis {
		if err := os.WriteFile(filepath.Join(root, "units", name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	vfs, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	return New(vfs, Options{})
}

func TestDescribeAIShowsPreambleCategoriesAndDisabledLimits(t *testing.T) {
	r := newRendererWithUnits(t, map[string]string{
		"armrad.fbi":  "[UNITINFO]\n{\n\tUnitName=ARMRAD;\n\tCategory=ARM LEVEL1 SPECIAL;\n}\n",
		"corfort.fbi": "[UNITINFO]\n{\n\tUnitName=CORFORT;\n\tCategory=CORE LEVEL1;\n}\n",
	})
	profile := "weight cormakr 0.2\n\nplan easy\nWeight ARM 0.2\nWeight ARMRAD 0.25\nLimit CORFORT O\nLimit ARMRAD -2\n"
	out, ok := r.Describe("ai/test.ai", []byte(profile))
	if !ok || out["format"] != "AI Profile" {
		t.Fatalf("Describe: ok=%v format=%v", ok, out["format"])
	}
	pre, _ := out["aiPreamble"].(*aiprofile.Plan)
	if pre == nil || len(pre.Weights) != 1 || pre.Weights[0].Target != "CORMAKR" {
		t.Fatalf("aiPreamble = %+v, want the line before the first plan", out["aiPreamble"])
	}
	plans, _ := out["aiPlans"].([]aiprofile.Plan)
	if len(plans) != 1 || plans[0].Name != "easy" {
		t.Fatalf("aiPlans = %+v, want only the easy plan", out["aiPlans"])
	}
	kinds := map[string]string{}
	for _, w := range plans[0].Weights {
		kinds[w.Target] = w.Kind
	}
	if kinds["ARM"] != aiprofile.KindCategory || kinds["ARMRAD"] != aiprofile.KindUnit {
		t.Errorf("kinds = %v", kinds)
	}
	for _, l := range plans[0].Limits {
		if !l.Forbids {
			t.Errorf("limit %s %d is not shown as disabled", l.Target, l.Maximum)
		}
	}
	if diags, _ := out["aiDiagnostics"].([]aiprofile.Diagnostic); len(diags) == 0 {
		t.Error("no diagnostic for Limit CORFORT O")
	}
	if out["aiEffective"] == nil {
		t.Error("no effective settings")
	}
}

// A .txt is an AI profile when a line's first word is a directive; text that
// merely mentions "weight" or "limit" is not.
func TestDescribeDetectsAIProfilesByFirstWord(t *testing.T) {
	r := newTestRenderer(t)
	if out, ok := r.Describe("ai/tabs.txt", []byte("plan\teasy\nweight\tarmsolar\t4\nlimit\tcorfort\t0\n")); !ok || out["format"] != "AI Profile" {
		t.Errorf("tab-separated profile: ok=%v format=%v", ok, out["format"])
	}
	if _, ok := r.Describe("docs/readme.txt", []byte("The weight limit of a hovercraft is 3.\nNo weight lines here.\n")); ok {
		t.Error("prose mentioning weight/limit was described as an AI profile")
	}
}
