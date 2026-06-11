package totala

import (
	"os"
	"testing"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/games"
)

// adapterForTest mounts the real TA install (TA_UNPACKED_PATH) and binds the
// game's adapter to it. Skips when no install is mounted — these tests verify
// agreement with the stock data, which CI doesn't carry.
func adapterForTest(t *testing.T) games.Adapter {
	t.Helper()
	path := os.Getenv("TA_UNPACKED_PATH")
	if path == "" {
		t.Skip("no TA install found — set TA_UNPACKED_PATH to enable")
	}
	v, err := filesystem.NewVirtualFileSystem(path, &filesystem.Config{})
	if err != nil {
		t.Fatalf("mount VFS at %s: %v", path, err)
	}
	t.Cleanup(func() { _ = v.Close() })
	return games.Resolve("totala").NewAdapter(v)
}

func TestRegistryResolvesTotalA(t *testing.T) {
	g := games.Resolve("totala")
	if g == nil || g.ID() != "totala" {
		t.Fatalf("Resolve(totala) = %v", g)
	}
	// Unknown / custom ids fall back to the TA baseline.
	if got := games.Resolve("my-custom-game"); got.ID() != "totala" {
		t.Fatalf("Resolve(custom) fell back to %q, want totala", got.ID())
	}
}

func TestTilesetsAreTheFixedWorldList(t *testing.T) {
	a := adapterForTest(t)
	ts := a.Tilesets()
	if len(ts) != 8 {
		t.Fatalf("want 8 worlds, got %d", len(ts))
	}
	if ts[0].Slug != "greenworld" || ts[0].DefaultTileset != "Green" {
		t.Fatalf("first world = %+v, want greenworld/Green", ts[0])
	}
}

func TestUnitSoundsFromSoundTDF(t *testing.T) {
	a := adapterForTest(t)
	// ARMPW (the Peewee) is its own class in gamedata/sound.tdf.
	events := a.UnitSounds("ARMPW")
	if events["select1"] != "servtny2" {
		t.Fatalf("ARMPW select1 = %q, want servtny2", events["select1"])
	}
	if events["underattack"] != "warning1" {
		t.Fatalf("ARMPW underattack = %q, want warning1", events["underattack"])
	}
	if got := a.UnitSounds("NO-SUCH-CLASS"); len(got) != 0 {
		t.Fatalf("unknown class resolved to %v", got)
	}
}

func TestPalettesAreGlobal(t *testing.T) {
	a := adapterForTest(t)
	pal := a.TexturePalette("textures/armor.gaf")
	if pal == nil {
		t.Fatal("TexturePalette returned nil")
	}
	if a.ModelColorPalette("armpw") == nil {
		t.Fatal("ModelColorPalette returned nil")
	}
	// TA has no per-side palettes and no transparent texture key.
	if a.TextureSidePrefix("armpw") != "" {
		t.Fatal("TA should not report side prefixes")
	}
	if a.TexturePaletteForSide("arm") != nil {
		t.Fatal("TA should not resolve side palettes")
	}
	opts := a.TextureRenderOptions(pal)
	if opts.Mode != gaf.TransparencyModeNone {
		t.Fatalf("TA textures render opaque, got mode %v", opts.Mode)
	}
	if a.CursorPalette() != nil {
		t.Fatal("TA ships no cursor palette sidecar")
	}
	if a.MapTerrainGroup("maps/anywhere.ota") != "" {
		t.Fatal("TA has no out-of-band terrain group")
	}
}
