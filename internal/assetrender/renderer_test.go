package assetrender

import (
	"testing"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
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
		{"", gaf.TransparencyModeAuto, "t-auto"},
		{"auto", gaf.TransparencyModeAuto, "t-auto"},
		{"metadata", gaf.TransparencyModeMetadata, "t-meta"},
		{"none", gaf.TransparencyModeNone, "t-none"},
		{"7", gaf.TransparencyModeIndex, "t-i007"},
		{"255", gaf.TransparencyModeIndex, "t-i255"},
		{"banana", gaf.TransparencyModeAuto, "t-auto"},
		{"999", gaf.TransparencyModeAuto, "t-auto"},
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

func TestGlobalPaletteFallback(t *testing.T) {
	r := newTestRenderer(t)
	pal := r.GlobalPalette()
	if len(pal) != 256 {
		t.Fatalf("global palette has %d entries, want 256", len(pal))
	}
	if _, _, _, a := pal[0].RGBA(); a != 0 {
		t.Errorf("palette index 0 should be transparent, got alpha %d", a)
	}
}
