package objects3d

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

func TestLoad3DO(t *testing.T) {
	path := testutil.UnpackedFile(t, "objects3d", "corvp.3do")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	m, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader failed: %v", err)
	}

	t.Logf("Root: %s, Objects: %d, Vertices: %d, Primitives: %d, Textures: %d",
		m.Root.Name, len(m.AllObjects), m.TotalVertices(), m.TotalPrimitives(), len(m.Textures()))

	for _, o := range m.AllObjects {
		t.Logf("  %s: %d verts, %d prims", o.Name, len(o.Vertices), len(o.Primitives))
	}
}

func TestLoadAll3DO(t *testing.T) {
	root := testutil.UnpackedDir(t, "objects3d")

	entries, _ := os.ReadDir(root)
	total, passed, failed := 0, 0, 0
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".3do" {
			continue
		}
		total++
		data, err := os.ReadFile(filepath.Join(root, e.Name()))
		if err != nil {
			failed++
			continue
		}
		_, err = LoadFromReader(bytes.NewReader(data))
		if err != nil {
			failed++
			t.Errorf("FAIL %s: %v", e.Name(), err)
			continue
		}
		passed++
	}
	t.Logf("3DO corpus: %d total, %d passed, %d failed", total, passed, failed)
}
