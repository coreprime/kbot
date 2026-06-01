package sct

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

func TestLoadSCT(t *testing.T) {
	path := testutil.UnpackedFile(t, "sections", "metal", "flat", "flat255.sct")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	s, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader failed: %v", err)
	}

	if s.Header.Width == 0 || s.Header.Height == 0 {
		t.Error("section has zero dimensions")
	}
	if len(s.Tiles) == 0 {
		t.Error("no tiles loaded")
	}

	t.Logf("SCT: v%d %dx%d tiles, %d unique tiles, minimap=%v, heightmap=%v",
		s.Header.Version, s.Header.Width, s.Header.Height, len(s.Tiles),
		s.Minimap != nil, s.HeightMap != nil)
}

func TestLoadAllSCT(t *testing.T) {
	root := testutil.UnpackedDir(t, "sections")

	var total, passed, failed int

	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || filepath.Ext(path) != ".sct" {
			return nil
		}
		total++

		data, err := os.ReadFile(path)
		if err != nil {
			failed++
			return nil
		}

		s, err := LoadFromReader(bytes.NewReader(data))
		if err != nil {
			failed++
			rel, _ := filepath.Rel(root, path)
			t.Errorf("FAIL: %s: %s", rel, err)
			return nil
		}

		expectedTiles := int(s.Header.Width * s.Header.Height)
		if len(s.TileMap) != expectedTiles {
			failed++
			rel, _ := filepath.Rel(root, path)
			t.Errorf("FAIL: %s: tile map size mismatch", rel)
			return nil
		}

		for _, idx := range s.TileMap {
			if idx < 0 || int(idx) >= len(s.Tiles) {
				failed++
				rel, _ := filepath.Rel(root, path)
				t.Errorf("FAIL: %s: tile index out of range", rel)
				return nil
			}
		}

		passed++
		return nil
	})

	t.Logf("SCT corpus: %d total, %d passed, %d failed", total, passed, failed)
}

func TestHeightMapNormalization(t *testing.T) {
	path := testutil.UnpackedFile(t, "sections", "metal", "bridges", "bridgeeend.sct")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	s, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader failed: %v", err)
	}

	img := s.RenderHeightMap()
	if img == nil {
		t.Fatal("RenderHeightMap returned nil")
	}

	water := img.GrayAt(30, 10).Y
	bridge := img.GrayAt(10, 16).Y
	t.Logf("Water pixel=%d, Bridge pixel=%d", water, bridge)

	if water != 0 {
		t.Errorf("water pixel should be 0, got %d", water)
	}
	if bridge < 200 {
		t.Errorf("bridge pixel should be bright (>200), got %d", bridge)
	}
}

func TestHeightMapFlat(t *testing.T) {
	path := testutil.UnpackedFile(t, "sections", "greenworld", "flat", "greenflat01.sct")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	s, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader failed: %v", err)
	}

	img := s.RenderHeightMap()
	if img == nil {
		t.Fatal("RenderHeightMap returned nil")
	}

	first := img.GrayAt(0, 0).Y
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			if img.GrayAt(x, y).Y != first {
				t.Fatalf("pixel (%d,%d)=%d differs from (0,0)=%d — expected uniform", x, y, img.GrayAt(x, y).Y, first)
			}
		}
	}
}

func TestHeightMapGreenflat02(t *testing.T) {
	path := testutil.UnpackedFile(t, "sections", "greenworld", "flat", "greenflat02.sct")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	s, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader failed: %v", err)
	}

	img := s.RenderHeightMap()
	if img == nil {
		t.Fatal("RenderHeightMap returned nil")
	}

	first := img.GrayAt(0, 0).Y
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			if img.GrayAt(x, y).Y != first {
				t.Fatalf("greenflat02 should be uniform but pixel (%d,%d)=%d differs", x, y, img.GrayAt(x, y).Y)
			}
		}
	}
}
