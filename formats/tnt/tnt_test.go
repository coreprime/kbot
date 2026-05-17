package tnt

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/testutil"
)

func TestLoadTNT(t *testing.T) {
	path := testutil.UnpackedFile(t, "maps", "cc02.tnt")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	m, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader failed: %v", err)
	}

	t.Logf("TNT: %dx%d tiles (%dx%d units), %d unique tiles, sea=%d, minimap=%dx%d, anims=%d",
		m.TileW, m.TileH, m.Header.Width, m.Header.Height,
		len(m.Tiles), m.Header.SeaLevel,
		m.MinimapW, m.MinimapH, m.Header.TileAnims)
}

func TestLoadAllTNT(t *testing.T) {
	root := testutil.UnpackedDir(t, "maps")

	var total, passed, failed int

	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".tnt" {
			continue
		}
		total++
		data, err := os.ReadFile(filepath.Join(root, e.Name()))
		if err != nil {
			failed++
			t.Errorf("FAIL read %s: %v", e.Name(), err)
			continue
		}

		m, err := LoadFromReader(bytes.NewReader(data))
		if err != nil {
			failed++
			t.Errorf("FAIL parse %s: %v", e.Name(), err)
			continue
		}

		if m.TileW*m.TileH != len(m.TileMap) {
			failed++
			t.Errorf("FAIL %s: tile map size mismatch", e.Name())
			continue
		}

		passed++
	}

	t.Logf("TNT corpus: %d total, %d passed, %d failed", total, passed, failed)
}
