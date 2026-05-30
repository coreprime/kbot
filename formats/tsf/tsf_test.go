package tsf

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/testutil"
)

// TestTSFTextRoundTrip parses every retail .tsf file and confirms re-emitting
// the document reproduces the original bytes exactly.
func TestTSFTextRoundTrip(t *testing.T) {
	dir := testutil.TAKUnpackedDir(t, "anims")
	files := collectFiles(t, dir, ".tsf")
	if len(files) == 0 {
		t.Skip("no .tsf files found")
	}
	for _, path := range files {
		path := path
		t.Run(filepath.Base(path), func(t *testing.T) {
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			doc, err := ParseTSF(string(original))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			got := doc.String()
			if got != string(original) {
				t.Fatalf("round-trip differs.\n--- got (%d bytes) ---\n%q\n--- want (%d bytes) ---\n%q",
					len(got), got, len(original), string(original))
			}
		})
	}
	t.Logf("round-tripped %d TSF files", len(files))
}

// TestTSFStructure checks the parsed structure of a known GUI document.
func TestTSFStructure(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "anims", "titlescreen.tsf")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("sample not available: %v", err)
	}
	doc, err := ParseTSF(string(data))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc.Sections) != 1 {
		t.Fatalf("section count: got %d want 1", len(doc.Sections))
	}
	anim := doc.Sections[0]
	if anim.Name != "JPGTest" {
		t.Errorf("animation name: got %q want JPGTest", anim.Name)
	}
	if v, ok := anim.Get("Looping"); !ok || v != "0" {
		t.Errorf("Looping: got %q (present=%v) want 0", v, ok)
	}
	frames := anim.Subsections()
	if len(frames) != 2 {
		t.Fatalf("frame count: got %d want 2", len(frames))
	}
	layers := frames[0].Subsections()
	if len(layers) != 1 {
		t.Fatalf("layer count: got %d want 1", len(layers))
	}
	if fn, ok := layers[0].Get("Filename"); !ok || fn != "TitleScreen.jpg" {
		t.Errorf("Filename: got %q want TitleScreen.jpg", fn)
	}
}
