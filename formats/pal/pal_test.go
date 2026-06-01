package pal

import (
	"bytes"
	"image/color"
	"strings"
	"testing"

	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/internal/testutil"
)

func TestLoadEmbeddedPalette(t *testing.T) {
	p, err := LoadFromBytes(assets.DefaultPalette)
	if err != nil {
		t.Fatalf("LoadFromBytes failed: %v", err)
	}
	if p.Colors[0].A != 0 {
		t.Errorf("index 0 should have alpha 0, got %d", p.Colors[0].A)
	}
	for i := 1; i < EntryCount; i++ {
		if p.Colors[i].A != 255 {
			t.Errorf("index %d should be opaque, got alpha %d", i, p.Colors[i].A)
		}
	}
	if !p.IsLikelyTAPalette() {
		t.Error("embedded palette should be flagged as TA palette")
	}
}

func TestRoundTripBytes(t *testing.T) {
	p, err := LoadFromBytes(assets.DefaultPalette)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	var buf bytes.Buffer
	if err := p.Write(&buf); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !bytes.Equal(buf.Bytes(), assets.DefaultPalette) {
		t.Error("round-trip changed bytes")
	}
}

func TestWriteJASC(t *testing.T) {
	p, _ := LoadFromBytes(assets.DefaultPalette)
	var buf bytes.Buffer
	if err := p.WriteJASC(&buf); err != nil {
		t.Fatalf("jasc: %v", err)
	}
	text := buf.String()
	if !strings.HasPrefix(text, "JASC-PAL\n0100\n256\n") {
		t.Errorf("missing JASC header: %q", text[:32])
	}
	if got := strings.Count(text, "\n"); got != 256+3 {
		t.Errorf("expected 259 newlines (header + 256 rows), got %d", got)
	}
}

func TestWriteGPL(t *testing.T) {
	p, _ := LoadFromBytes(assets.DefaultPalette)
	var buf bytes.Buffer
	if err := p.WriteGPL(&buf, "Test"); err != nil {
		t.Fatalf("gpl: %v", err)
	}
	text := buf.String()
	if !strings.Contains(text, "GIMP Palette") || !strings.Contains(text, "Name: Test") {
		t.Errorf("missing GPL preamble: %q", text[:60])
	}
}

func TestRenderSwatch(t *testing.T) {
	p, _ := LoadFromBytes(assets.DefaultPalette)
	img := p.RenderSwatch(8)
	if img.Bounds().Dx() != 128 || img.Bounds().Dy() != 128 {
		t.Errorf("expected 128x128, got %dx%d", img.Bounds().Dx(), img.Bounds().Dy())
	}
	// Last entry should match the palette's RGB exactly.
	gotR, gotG, gotB, _ := img.At(127, 127).RGBA()
	want := p.Colors[255]
	if uint8(gotR>>8) != want.R || uint8(gotG>>8) != want.G || uint8(gotB>>8) != want.B {
		t.Errorf("last cell mismatch: got %d/%d/%d want %d/%d/%d",
			gotR>>8, gotG>>8, gotB>>8, want.R, want.G, want.B)
	}
}

func TestRejectsWrongSize(t *testing.T) {
	if _, err := LoadFromBytes(make([]byte, 100)); err == nil {
		t.Error("expected error for short palette")
	}
}

func TestColorModel(t *testing.T) {
	p, _ := LoadFromBytes(assets.DefaultPalette)
	cm := p.ColorModel()
	if len(cm) != EntryCount {
		t.Errorf("ColorModel size = %d, want %d", len(cm), EntryCount)
	}
	if _, ok := cm[5].(color.RGBA); !ok {
		t.Errorf("ColorModel entries should be color.RGBA")
	}
}

func TestEquals(t *testing.T) {
	a, _ := LoadFromBytes(assets.DefaultPalette)
	b, _ := LoadFromBytes(assets.DefaultPalette)
	if !a.Equals(b) {
		t.Error("identical palettes should compare equal")
	}
	b.Colors[10] = color.RGBA{99, 99, 99, 255}
	if a.Equals(b) {
		t.Error("differing palettes should not compare equal")
	}
}

func TestLoadFromUnpackedPalette(t *testing.T) {
	path := testutil.UnpackedFile(t, "palettes", "palette.pal")
	p, err := LoadFromFile(path)
	if err != nil {
		t.Fatalf("LoadFromFile %s: %v", path, err)
	}
	if len(p.Raw) != FileSize {
		t.Errorf("raw size = %d, want %d", len(p.Raw), FileSize)
	}
	unique, _ := p.Histogram()
	if unique < 100 {
		t.Errorf("expected at least 100 unique colors, got %d", unique)
	}
}

func TestLoadLookup(t *testing.T) {
	path := testutil.UnpackedFile(t, "palettes", "palette.alp")
	table, err := LoadLookupFromFile(path)
	if err != nil {
		t.Fatalf("LoadLookupFromFile: %v", err)
	}
	if len(table) != FileSize {
		t.Errorf("lookup size = %d, want %d", len(table), FileSize)
	}

	pal, _ := LoadFromBytes(assets.DefaultPalette)
	img, err := RenderLookupSwatch(table, pal, 2)
	if err != nil {
		t.Fatalf("RenderLookupSwatch: %v", err)
	}
	if img.Bounds().Dx() != 512 || img.Bounds().Dy() != 8 {
		t.Errorf("expected 512x8, got %dx%d", img.Bounds().Dx(), img.Bounds().Dy())
	}
}
