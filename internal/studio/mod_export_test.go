package studio

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/formats/hpi"
	"github.com/coreprime/kbot/internal/workspace"
)

func writeWork(t *testing.T, dir, rel, content string) {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", rel, err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

func listHPIEntries(t *testing.T, data []byte) map[string]bool {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "*.hpi")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(data); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	r, err := hpi.OpenReader(f.Name())
	if err != nil {
		t.Fatalf("open hpi: %v", err)
	}
	defer func() { _ = r.Close() }()
	out := map[string]bool{}
	_ = r.Walk(func(e *hpi.Entry) error {
		if !e.IsDir {
			out[strings.ToLower(filepath.ToSlash(e.FullPath()))] = true
		}
		return nil
	})
	return out
}

func TestPackModHPIv1(t *testing.T) {
	dir := t.TempDir()
	writeWork(t, dir, workspace.ManifestName, "name: X\nbase: ta\n")
	writeWork(t, dir, "maps/foo.tnt", "tnt-bytes")
	writeWork(t, dir, "units/bar.fbi", "fbi-bytes")
	writeWork(t, dir, ".git/config", "should-skip")

	data, err := packModHPI(dir, workspace.ExportHPIv1)
	if err != nil {
		t.Fatalf("packModHPI: %v", err)
	}
	if len(data) < 4 || string(data[:4]) != "HAPI" {
		t.Fatalf("not an HPI archive (len=%d)", len(data))
	}
	entries := listHPIEntries(t, data)
	if !entries["maps/foo.tnt"] || !entries["units/bar.fbi"] {
		t.Errorf("mod files missing: %v", entries)
	}
	if entries["workspace.yaml"] {
		t.Errorf("manifest should be excluded from the mod")
	}
	if entries[".git/config"] {
		t.Errorf("dot-paths should be excluded")
	}
}

func TestPackModHPIv2(t *testing.T) {
	dir := t.TempDir()
	writeWork(t, dir, "graphics/x.tga", "img")
	data, err := packModHPI(dir, workspace.ExportHPIv2)
	if err != nil {
		t.Fatalf("packModHPI v2: %v", err)
	}
	if entries := listHPIEntries(t, data); !entries["graphics/x.tga"] {
		t.Errorf("v2 archive missing file: %v", entries)
	}
}
