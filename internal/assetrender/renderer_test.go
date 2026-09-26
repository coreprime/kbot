package assetrender

import (
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/gaf"
)

// newTestRenderer builds a Renderer over an empty temp directory. With no
// archives mounted the VFS resolves nothing, which exercises the fallback
// paths (embedded palette, hash-of-data cache key).
func newTestRenderer(t *testing.T) *Renderer {
	t.Helper()
	vfs, err := filesystem.NewVirtualFileSystem(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("NewVirtualFileSystem: %v", err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	return New(vfs, Options{CacheDir: t.TempDir()})
}

func TestRawContentType(t *testing.T) {
	cases := []struct {
		ext      string
		wantType string
		wantOK   bool
	}{
		{".gaf", "application/octet-stream", false},
		{".PNG", "image/png", true},
		{".jpg", "image/jpeg", true},
		{".ota", "text/plain; charset=utf-8", true},
		{".bos", "text/plain; charset=utf-8", true},
		{".wav", "audio/wav", true},
		{".mp4", "video/mp4", true},
	}
	for _, c := range cases {
		gotType, gotOK := RawContentType(c.ext)
		if gotType != c.wantType || gotOK != c.wantOK {
			t.Errorf("RawContentType(%q) = (%q,%v), want (%q,%v)", c.ext, gotType, gotOK, c.wantType, c.wantOK)
		}
	}
}

func TestTransparencyFromQuery(t *testing.T) {
	cases := []struct {
		q        string
		wantMode gaf.TransparencyMode
		wantTag  string
	}{
		{"", gaf.TransparencyModeMetadata, "t-game"},
		{"game", gaf.TransparencyModeMetadata, "t-game"},
		{"auto", gaf.TransparencyModeMetadata, "t-game"},
		{"metadata", gaf.TransparencyModeMetadata, "t-game"},
		{"heuristic", gaf.TransparencyModeHeuristic, "t-heur"},
		{"none", gaf.TransparencyModeNone, "t-opq"},
		{"7", gaf.TransparencyModeIndex, "t-x007"},
		{"255", gaf.TransparencyModeIndex, "t-x255"},
		{"banana", gaf.TransparencyModeMetadata, "t-game"},
		{"999", gaf.TransparencyModeMetadata, "t-game"},
	}
	for _, c := range cases {
		opts, tag := TransparencyFromQuery(c.q)
		if opts.Mode != c.wantMode || tag != c.wantTag {
			t.Errorf("TransparencyFromQuery(%q) = (mode %d, %q), want (mode %d, %q)", c.q, opts.Mode, tag, c.wantMode, c.wantTag)
		}
	}
	if opts, _ := TransparencyFromQuery("42"); opts.Index != 42 {
		t.Errorf("index transparency stored %d, want 42", opts.Index)
	}
}

func TestPaletteCacheSuffixStable(t *testing.T) {
	a := paletteCacheSuffix("global:palettes/palette.pal")
	b := paletteCacheSuffix("global:palettes/palette.pal")
	c := paletteCacheSuffix("embedded")
	if a != b {
		t.Errorf("suffix not stable: %q vs %q", a, b)
	}
	if a == c {
		t.Errorf("distinct tags collided: %q", a)
	}
	if len(a) != 9 || a[0] != 'p' {
		t.Errorf("suffix format unexpected: %q", a)
	}
}

func TestCacheKeyFallsBackToHash(t *testing.T) {
	r := newTestRenderer(t)
	data := []byte("hello world")
	k1 := r.CacheKey("anims/none.gaf", data)
	k2 := r.CacheKey("anims/none.gaf", data)
	if k1 != k2 {
		t.Errorf("cache key not stable: %q vs %q", k1, k2)
	}
	if k1 == r.CacheKey("anims/none.gaf", []byte("different")) {
		t.Errorf("distinct content produced identical cache key")
	}
}

func TestCacheLifecycle(t *testing.T) {
	r := newTestRenderer(t)
	c := r.Cache("gaf-png")
	if c == nil {
		t.Fatal("expected a cache when CacheDir is set")
	}
	// Second call returns the same instance (path is identical).
	if got := r.Cache("gaf-png").GetPath("abc", ".png"); got != c.GetPath("abc", ".png") {
		t.Errorf("repeated Cache(name) returned a different cache")
	}
	// A Renderer without a cache dir caches nothing.
	vfs := r.VFS()
	nc := New(vfs, Options{})
	if nc.Cache("gaf-png") != nil {
		t.Errorf("expected nil cache when CacheDir is empty")
	}
}

func TestResolvePaletteFallsBackToEmbedded(t *testing.T) {
	r := newTestRenderer(t)
	pal, tag := r.ResolvePalette("anims/cursor.gaf", "")
	if pal == nil {
		t.Fatal("expected embedded palette fallback, got nil")
	}
	if tag != "embedded" {
		t.Errorf("tag = %q, want embedded", tag)
	}
}

// TestGlobalPaletteFallback checks the embedded fallback: terrain and
// minimaps draw palette index 0 as opaque black, as the game does.
func TestGlobalPaletteFallback(t *testing.T) {
	r := newTestRenderer(t)
	pal := r.GlobalPalette()
	if len(pal) != 256 {
		t.Fatalf("global palette has %d entries, want 256", len(pal))
	}
	for i, c := range pal {
		if _, _, _, a := c.RGBA(); a != 0xffff {
			t.Fatalf("palette index %d has alpha %d; terrain is drawn opaque", i, a)
		}
	}
}

// rendererOver mounts files as a loose tree for a Renderer.
func rendererOver(t *testing.T, files map[string][]byte) *Renderer {
	t.Helper()
	root := t.TempDir()
	for rel, data := range files {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	vfs, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	return New(vfs, Options{CacheDir: t.TempDir()})
}

// TestGlobalPaletteLoadsLikeTheGame checks palettes/palette.pal handling: a
// longer file gives its first 1,024 bytes and an empty one falls back to
// palettes/palette.pcx.
func TestGlobalPaletteLoadsLikeTheGame(t *testing.T) {
	long := make([]byte, 1100)
	long[4], long[5], long[6] = 10, 20, 30
	r := rendererOver(t, map[string][]byte{"palettes/palette.pal": long})
	if got := r.GlobalPalette()[1]; got != (color.RGBA{10, 20, 30, 255}) {
		t.Errorf("long palette.pal: index 1 = %v, want {10 20 30 255}", got)
	}

	pcxData := make([]byte, 128)
	pcxData[0], pcxData[1], pcxData[2], pcxData[3] = 0x0A, 5, 1, 8
	pcxData[65], pcxData[66] = 1, 1
	pcxData = append(pcxData, 0xC1, 0x00, 0x0C)
	for i := 0; i < 256; i++ {
		pcxData = append(pcxData, byte(i), 7, 9)
	}
	r = rendererOver(t, map[string][]byte{"palettes/palette.pal": {}, "palettes/palette.pcx": pcxData})
	if got := r.GlobalPalette()[3]; got != (color.RGBA{3, 7, 9, 255}) {
		t.Errorf("empty palette.pal: index 3 = %v, want the PCX colour {3 7 9 255}", got)
	}
}

// TestRenderCacheCarriesRevision checks that on-disk render caches are
// separated by render revision, so renders drawn under older rules (index
// 0 transparent, corner-guessed GAF keys) are not served.
func TestRenderCacheCarriesRevision(t *testing.T) {
	r := newTestRenderer(t)
	if !strings.Contains(r.Cache("tnt-png").GetPath("k", ".png"), "tnt-png-"+renderRevision) {
		t.Error("render cache directories do not carry the render revision")
	}
}
