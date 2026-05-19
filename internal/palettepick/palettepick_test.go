package palettepick

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// fakeVFS is a tiny VFS backed by an in-memory map.
type fakeVFS map[string][]byte

func (f fakeVFS) ReadFile(p string) ([]byte, error) {
	if b, ok := f[p]; ok {
		return b, nil
	}
	return nil, errors.New("not found: " + p)
}

func makePAL(seed byte) []byte {
	b := make([]byte, 1024)
	for i := 0; i < 1024; i += 4 {
		b[i] = seed
		b[i+1] = seed + 1
		b[i+2] = seed + 2
	}
	return b
}

// makePCX builds a minimal 1x1 8-bit PCX with a trailing 768-byte palette.
// The PCX header is small enough to encode by hand.
func makePCX(seed byte) []byte {
	out := make([]byte, 128) // header
	out[0] = 0x0A             // manufacturer
	out[1] = 0x05             // version
	out[2] = 0x01             // RLE
	out[3] = 0x08             // bits per pixel
	// XMax = 0, YMax = 0 (so width = height = 1)
	out[65] = 1 // planes
	out[66] = 1 // bytes per line
	out = append(out, 0xC1)   // 1 byte of RLE: single literal value (we won't decode it)
	out = append(out, 0x00)   // pixel value
	out = append(out, 0x0C)   // embedded palette marker
	for i := 0; i < 256; i++ {
		out = append(out, seed, seed+1, seed+2)
	}
	return out
}

func TestResolveSidecarPCXWins(t *testing.T) {
	vfs := fakeVFS{
		"anims/foo.gaf":             []byte("gaf"),
		"anims/foo.pcx":             makePCX(0x10),
		"palettes/palette.pal":      makePAL(0x99),
	}
	r, err := Resolve(vfs, "anims/foo.gaf", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if r.Source != SourceSidecarPCX {
		t.Fatalf("source = %s, want %s", r.Source, SourceSidecarPCX)
	}
	if r.Path != "anims/foo.pcx" {
		t.Fatalf("path = %s, want anims/foo.pcx", r.Path)
	}
	if r.Palette.Colors[1].R != 0x10 {
		t.Fatalf("palette did not come from sidecar PCX: got R=%X", r.Palette.Colors[1].R)
	}
}

func TestResolveSidePrefix(t *testing.T) {
	vfs := fakeVFS{
		"units/araat.gaf":      []byte("gaf"),
		"palettes/aramon.pcx":  makePCX(0x44),
		"palettes/palette.pal": makePAL(0x99),
	}
	r, err := Resolve(vfs, "units/araat.gaf", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if r.Source != SourceSidePalette {
		t.Fatalf("source = %s, want %s", r.Source, SourceSidePalette)
	}
	if r.Path != "palettes/aramon.pcx" || r.Label != "aramon" {
		t.Fatalf("unexpected pick: path=%s label=%s", r.Path, r.Label)
	}
	if r.Palette.Colors[1].R != 0x44 {
		t.Fatalf("palette did not come from aramon.pcx: got R=%X", r.Palette.Colors[1].R)
	}
}

func TestResolveFallsBackToGlobalThenEmbedded(t *testing.T) {
	// No sidecar, no side prefix match: should pick palettes/palette.pal.
	vfs := fakeVFS{
		"anims/random.gaf":     []byte("gaf"),
		"palettes/palette.pal": makePAL(0x55),
	}
	r, err := Resolve(vfs, "anims/random.gaf", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if r.Source != SourceGlobal {
		t.Fatalf("source = %s, want %s", r.Source, SourceGlobal)
	}
	if r.Palette.Colors[1].R != 0x55 {
		t.Fatalf("palette did not come from global palette.pal: got R=%X", r.Palette.Colors[1].R)
	}

	// Strip everything: should fall through to embedded.
	r2, err := Resolve(fakeVFS{}, "anims/random.gaf", "")
	if err != nil {
		t.Fatalf("Resolve(empty vfs): %v", err)
	}
	if r2.Source != SourceEmbedded {
		t.Fatalf("source = %s, want %s", r2.Source, SourceEmbedded)
	}
}

func TestResolveOverrideHonored(t *testing.T) {
	vfs := fakeVFS{
		"anims/foo.gaf":           []byte("gaf"),
		"anims/foo.pcx":           makePCX(0x10),
		"palettes/taros.pcx":      makePCX(0x77),
	}
	r, err := Resolve(vfs, "anims/foo.gaf", "palettes/taros.pcx")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if r.Source != SourceOverride {
		t.Fatalf("source = %s, want %s", r.Source, SourceOverride)
	}
	if r.Path != "palettes/taros.pcx" {
		t.Fatalf("path = %s, want palettes/taros.pcx", r.Path)
	}
}

// TestResolveAgainstRealTAK is a smoke test against the flattened TAK install.
// It picks one GAF that has a same-name PCX and one that doesn't to exercise
// the sidecar and side-prefix code paths against real data.
func TestResolveAgainstRealTAK(t *testing.T) {
	root := os.Getenv("TAK_UNPACKED_PATH")
	if root == "" {
		t.Skip("TAK_UNPACKED_PATH not set — skipping real-asset test")
	}
	if _, err := os.Stat(root); err != nil {
		t.Skipf("TAK_UNPACKED_PATH=%s not found: %v", root, err)
	}

	vfs := diskVFS(root)
	if _, err := vfs.ReadFile("anims/actionbuttons.gaf"); err != nil {
		t.Skipf("missing expected TAK asset anims/actionbuttons.gaf: %v", err)
	}

	r, err := Resolve(vfs, "anims/actionbuttons.gaf", "")
	if err != nil {
		t.Fatalf("Resolve(actionbuttons.gaf): %v", err)
	}
	if r.Source != SourceSidecarPCX {
		t.Fatalf("actionbuttons palette source = %s, want sidecar-pcx", r.Source)
	}

	// araat is an Aramon unit — side prefix path should pick aramon.pcx.
	if _, err := vfs.ReadFile("units/araat.fbi"); err == nil {
		r, err := Resolve(vfs, "units/araat.gaf", "")
		if err != nil {
			t.Fatalf("Resolve(araat.gaf): %v", err)
		}
		// araat.gaf may not exist as a standalone file in TAK, but if any
		// resolution succeeded we expect either side-palette or fallback;
		// what we really care about is that the side-prefix path is picked
		// when palettes/aramon.pcx exists.
		if _, perr := vfs.ReadFile("palettes/aramon.pcx"); perr == nil && r.Source != SourceSidePalette {
			t.Fatalf("araat side palette source = %s, want side", r.Source)
		}
	}
}

// diskVFS adapts a real directory to the VFS interface for the smoke test.
type diskVFS string

func (d diskVFS) ReadFile(p string) ([]byte, error) {
	return os.ReadFile(filepath.Join(string(d), filepath.FromSlash(p)))
}
