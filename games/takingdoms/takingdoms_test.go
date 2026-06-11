package takingdoms

import (
	"os"
	"testing"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/games"
)

// adapterForTest mounts the real TA:K install (TAK_UNPACKED_PATH) and binds
// the game's adapter to it. Skips when no install is mounted — these tests
// verify agreement with the stock data, which CI doesn't carry.
func adapterForTest(t *testing.T) games.Adapter {
	t.Helper()
	path := os.Getenv("TAK_UNPACKED_PATH")
	if path == "" {
		t.Skip("no TA:K install found — set TAK_UNPACKED_PATH to enable")
	}
	v, err := filesystem.NewVirtualFileSystem(path, &filesystem.Config{})
	if err != nil {
		t.Fatalf("mount VFS at %s: %v", path, err)
	}
	t.Cleanup(func() { _ = v.Close() })
	return games.Resolve("takingdoms").NewAdapter(v)
}

func TestTilesetsAreKingdoms(t *testing.T) {
	a := adapterForTest(t)
	ts := a.Tilesets()
	slugs := map[string]bool{}
	for _, o := range ts {
		slugs[o.Slug] = true
		if o.DefaultTileset != o.Slug {
			t.Fatalf("kingdom %q tileset = %q, want the kingdom itself", o.Slug, o.DefaultTileset)
		}
	}
	for _, want := range []string{"aramon", "taros", "veruna", "zhon"} {
		if !slugs[want] {
			t.Fatalf("kingdom %q missing from tilesets %v", want, ts)
		}
	}
	if slugs["lifeforms"] || slugs["npc"] {
		t.Fatalf("pseudo-sides leaked into tilesets: %v", ts)
	}
}

func TestSidePalettesByPrefix(t *testing.T) {
	a := adapterForTest(t)
	// Aramon units carry the "ara" nameprefix from sidedata.
	if got := a.TextureSidePrefix("arabow"); got != "ara" {
		t.Fatalf("TextureSidePrefix(arabow) = %q, want ara", got)
	}
	pal := a.TexturePaletteForSide("ara")
	if pal == nil {
		t.Fatal("no texture palette for side ara")
	}
	// TA:K atlases reserve a transparent key colour that must be punched out.
	opts := a.TextureRenderOptions(pal)
	if opts.Mode == gaf.TransparencyModeNone {
		t.Fatal("TA:K textures need a transparency mode, got none")
	}
}

func TestCursorPaletteSidecar(t *testing.T) {
	a := adapterForTest(t)
	if a.CursorPalette() == nil {
		t.Fatal("TA:K ships anims/cursors.pcx — expected a cursor palette")
	}
}

func TestUnitSoundsFromSoundClasses(t *testing.T) {
	a := adapterForTest(t)
	// ARABOW (Aramon archer) has its own soundclass file with an [attack]
	// pool; the adapter maps pools onto TA-style numbered keys.
	events := a.UnitSounds("ARABOW")
	if len(events) == 0 {
		t.Fatal("ARABOW resolved to no sound events")
	}
	for k, v := range events {
		if v == "" {
			t.Fatalf("event %q resolved empty", k)
		}
	}
	if got := a.UnitSounds("NO-SUCH-CLASS"); len(got) != 0 {
		t.Fatalf("unknown class resolved to %v", got)
	}
}

func TestMapTerrainGroupReadsKingdomAffinity(t *testing.T) {
	a := adapterForTest(t)
	if got := a.MapTerrainGroup("maps/abnar's terrace.tnt"); got != "veruna" {
		t.Fatalf("MapTerrainGroup(abnar's terrace) = %q, want veruna", got)
	}
}

func TestBuildOptionsFromCanbuildDir(t *testing.T) {
	a := adapterForTest(t)
	// The Aramon Mage Builder gets its grants from canbuild/arabuild/.
	opts := a.BuildOptions("arabuild")
	if len(opts) == 0 {
		t.Fatal("arabuild has no build options")
	}
	has := func(n string) bool {
		for _, o := range opts {
			if o == n {
				return true
			}
		}
		return false
	}
	if !has("aralode") || !has("araat") {
		t.Fatalf("arabuild options missing lodestone/tower: %v", opts)
	}
	// King Elsin builds too (canbuild/araking/ exists in retail data).
	if king := a.BuildOptions("ARAKING"); len(king) == 0 || !func() bool {
		for _, o := range king {
			if o == "aralode" {
				return true
			}
		}
		return false
	}() {
		t.Fatalf("araking should build aralode, got %v", king)
	}
	if got := a.BuildOptions("arapal"); len(got) != 0 {
		t.Fatalf("knight should build nothing, got %v", got)
	}
}
