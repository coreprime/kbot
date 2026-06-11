// Package totala implements games.Game for Total Annihilation: one global
// palette for every asset class, sound events from gamedata/sound.tdf, and
// the classic fixed world list for the map editor.
package totala

import (
	"image/color"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/games"
	"github.com/coreprime/kbot/internal/assets"
)

func init() { games.Register(Game) }

// Game is the Total Annihilation singleton.
var Game games.Game = game{}

type game struct{}

func (game) ID() string   { return "totala" }
func (game) Name() string { return "Total Annihilation" }

func (g game) NewAdapter(fs games.VFS) games.Adapter {
	return &adapter{fs: fs}
}

type adapter struct {
	fs games.VFS

	palOnce sync.Once
	pal     *gaf.Palette

	soundOnce    sync.Once
	soundClasses []ta.SoundClass

	buildOnce sync.Once
	buildOpts map[string][]string
}

func (a *adapter) Game() games.Game { return Game }

// global returns the install's single palette, loaded once.
func (a *adapter) global() *gaf.Palette {
	a.palOnce.Do(func() {
		a.pal = games.GlobalPalette(a.fs, assets.DefaultPalette)
	})
	return a.pal
}

// ── games.PaletteResolver ────────────────────────────────────────────────────
//
// TA keys everything off the one global palette; sides and kingdoms don't
// exist, so the side-aware queries answer "not applicable".

func (a *adapter) TexturePalette(string) *gaf.Palette        { return a.global() }
func (a *adapter) ModelColorPalette(string) color.Palette    { return a.global().ColorModel() }
func (a *adapter) FeaturePalette(string) *gaf.Palette        { return a.global() }
func (a *adapter) TerrainPalette(string) color.Palette       { return a.global().ColorModel() }
func (a *adapter) TextureSidePrefix(string) string           { return "" }
func (a *adapter) TexturePaletteForSide(string) *gaf.Palette { return nil }

func (a *adapter) TextureRenderOptions(*gaf.Palette) gaf.RenderOptions {
	// Unit textures render fully opaque: palette[TI] is a real colour (the
	// asphalt / panel base on runway tiles), and punching it out lets the
	// ground plane bleed through.
	return gaf.RenderOptions{Mode: gaf.TransparencyModeNone}
}

// BuildOptions resolves a builder's constructible units from sidedata's
// [CANBUILD] table plus download/*.tdf menu add-ons (the AFark.ufo
// mechanism), cached per adapter.
func (a *adapter) BuildOptions(unit string) []string {
	a.buildOnce.Do(func() {
		a.buildOpts = map[string][]string{}
		base := games.SidedataBuildOptions(a.fs)
		extra := games.DownloadMenuOptions(a.fs)
		for b, list := range base {
			a.buildOpts[b] = games.MergeBuildOptions(list, extra[b])
		}
		for b, list := range extra {
			if _, ok := a.buildOpts[b]; !ok {
				a.buildOpts[b] = list
			}
		}
	})
	return a.buildOpts[strings.ToUpper(strings.TrimSpace(unit))]
}

// MapTerrainGroup: TA tracks a map's world through the .ota planet= field,
// which the caller already parses — no extra grouping here.
func (a *adapter) MapTerrainGroup(string) string { return "" }

// CursorPalette: TA cursors use the global palette — no sidecar.
func (a *adapter) CursorPalette() *gaf.Palette { return nil }

// UnitSounds resolves a SoundCategory against gamedata/sound.tdf's class
// table (event name → wav stem), parsed once per adapter.
func (a *adapter) UnitSounds(category string) map[string]string {
	category = strings.TrimSpace(category)
	if category == "" {
		return nil
	}
	a.soundOnce.Do(func() {
		// gamedata/sound.tdf is the canonical location; probe the casing
		// variants so mods that ship the file renamed still resolve.
		for _, p := range []string{"gamedata/sound.tdf", "gamedata/SOUND.tdf", "GameData/sound.tdf"} {
			if data, err := a.fs.ReadFile(p); err == nil {
				var classes []ta.SoundClass
				if derr := tdf.Unmarshal(data, &classes); derr == nil {
					a.soundClasses = classes
					return
				}
			}
		}
	})
	for i := range a.soundClasses {
		if !strings.EqualFold(a.soundClasses[i].Key, category) {
			continue
		}
		events := make(map[string]string, len(a.soundClasses[i].Events))
		for k, v := range a.soundClasses[i].Events {
			events[strings.ToLower(k)] = strings.ToLower(strings.TrimSpace(v))
		}
		return events
	}
	return nil
}

// Tilesets is TA's canonical world list (slug → label → .ota planet value).
// TA has no per-install tileset registry, so this is the authoritative set.
func (a *adapter) Tilesets() []games.Tileset {
	return []games.Tileset{
		{Slug: "greenworld", Label: "Green", DefaultTileset: "Green"},
		{Slug: "metal", Label: "Metal", DefaultTileset: "Metal"},
		{Slug: "mars", Label: "Mars", DefaultTileset: "Desert"},
		{Slug: "moon", Label: "Moon", DefaultTileset: "Lunar"},
		{Slug: "archipelago", Label: "Archipelago", DefaultTileset: "Water"},
		{Slug: "lava", Label: "Lava", DefaultTileset: "Lava"},
		{Slug: "acid", Label: "Acid", DefaultTileset: "Acid"},
		{Slug: "slate", Label: "Slate", DefaultTileset: "Slate"},
	}
}
