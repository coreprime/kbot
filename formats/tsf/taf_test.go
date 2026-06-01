package tsf

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

// collectFiles walks dir and returns every path with the given lowercase
// extension (including the dot).
func collectFiles(t *testing.T, dir, ext string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if strings.EqualFold(filepath.Ext(path), ext) {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", dir, err)
	}
	return out
}

// TestTAFRoundTrip parses every retail .taf file and confirms re-serialization
// reproduces the original bytes exactly.
func TestTAFRoundTrip(t *testing.T) {
	dir := testutil.TAKUnpackedDir(t, "anims")
	files := collectFiles(t, dir, ".taf")
	if len(files) == 0 {
		t.Skip("no .taf files found")
	}

	for _, path := range files {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			taf, err := ParseTAF(original)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			got, err := taf.Bytes()
			if err != nil {
				t.Fatalf("serialize: %v", err)
			}
			if len(got) != len(original) {
				t.Fatalf("length mismatch: got %d, want %d", len(got), len(original))
			}
			for i := range got {
				if got[i] != original[i] {
					t.Fatalf("byte %d (0x%X) differs: got 0x%02X want 0x%02X", i, i, got[i], original[i])
				}
			}
		})
	}
	t.Logf("round-tripped %d TAF files", len(files))
}

// TestTAFFields spot-checks parsed metadata against known values in the
// smallest retail sprite.
func TestTAFFields(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "anims", "cannbsm_1555.taf")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("sample not available: %v", err)
	}
	taf, err := ParseTAF(data)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if taf.Name != "cannbsm" {
		t.Errorf("name: got %q want %q", taf.Name, "cannbsm")
	}
	if len(taf.Frames) != 4 {
		t.Fatalf("frame count: got %d want 4", len(taf.Frames))
	}
	f := taf.Frames[0]
	if f.Width != 6 || f.Height != 6 {
		t.Errorf("dimensions: got %dx%d want 6x6", f.Width, f.Height)
	}
	if f.OriginX != 3 || f.OriginY != 3 {
		t.Errorf("origin: got (%d,%d) want (3,3)", f.OriginX, f.OriginY)
	}
	if f.Format != FormatARGB1555 {
		t.Errorf("format: got %s want ARGB1555", f.Format)
	}
	if len(f.Pixels) != 6*6*2 {
		t.Errorf("pixel bytes: got %d want %d", len(f.Pixels), 6*6*2)
	}
}

// TestFormatDistribution confirms every frame uses one of the two known
// truecolor formats, so the corpus exercises both decoders.
func TestFormatDistribution(t *testing.T) {
	dir := testutil.TAKUnpackedDir(t, "anims")
	files := collectFiles(t, dir, ".taf")
	var n4444, n1555 int
	for _, path := range files {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		taf, err := ParseTAF(data)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		for _, f := range taf.Frames {
			switch f.Format {
			case FormatARGB4444:
				n4444++
			case FormatARGB1555:
				n1555++
			default:
				t.Fatalf("%s: unexpected format %s", path, f.Format)
			}
		}
	}
	if n4444 == 0 || n1555 == 0 {
		t.Fatalf("expected both formats represented: 4444=%d 1555=%d", n4444, n1555)
	}
	t.Logf("frames: ARGB4444=%d ARGB1555=%d", n4444, n1555)
}
