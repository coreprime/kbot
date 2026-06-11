// Package games is the seam between kbot's shared TA-format machinery and the
// behaviour that genuinely differs per game. The formats packages stay
// data-driven — a TNT or COB announces its own dialect through version words,
// and parsing dispatches on what the bytes say. Everything that instead
// depends on which GAME an install is — palette resolution rules, sound-event
// wiring, terrain groups, branding — lives behind the Game/Adapter interfaces
// here, with one implementation per game under games/totala and
// games/takingdoms.
//
// A custom game built on the TA formats extends this cleanly: implement Game
// (usually by embedding one of the shipped games and overriding the parts
// that differ), Register it, and point a kbot context's `game` id at it.
package games

import (
	"image/color"
	"sort"

	"github.com/coreprime/kbot/formats/gaf"
)

// VFS is the read surface an Adapter resolves game data against — the mounted
// install (or workspace overlay) a session owns. filesystem.VirtualFileSystem
// satisfies it.
type VFS interface {
	ReadFile(path string) ([]byte, error)
	Exists(path string) bool
	List() []string
}

// Game identifies one supported game and builds per-session adapters for it.
// Implementations are stateless singletons; all per-install caching lives on
// the Adapter.
type Game interface {
	// ID is the kbot context identifier ("totala", "takingdoms").
	ID() string
	// Name is the human-readable title.
	Name() string
	// NewAdapter binds the game's rules to one mounted install. Adapters
	// cache parsed game data (sidedata, sound tables) for their lifetime,
	// so sessions should hold one adapter, not re-create them per request.
	NewAdapter(fs VFS) Adapter
}

// Adapter is a Game bound to a mounted install: every per-game decision the
// shared studio/server code needs, answered against that install's data.
type Adapter interface {
	Game() Game

	PaletteResolver

	// CursorPalette returns the palette for the cursors GAF, or nil when the
	// game uses the global palette (the caller then falls back to it).
	CursorPalette() *gaf.Palette

	// UnitSounds resolves a unit's sound-event map for its FBI sound
	// category: TA-style event keys (select1, ok1, arrived1, …) to .wav
	// stems. Returns nil when the category resolves to nothing.
	UnitSounds(category string) map[string]string

	// Tilesets lists the map editor's terrain groups: TA's fixed world list,
	// TA:K's kingdoms from sidedata.
	Tilesets() []Tileset

	// MapTerrainGroup names the terrain group a map belongs to when the
	// game tracks it outside the map file itself — TA:K reads the kingdom=
	// affinity from the sibling .ota. "" when the game has no such notion
	// (TA's planet lives in the .ota planet= the caller already parses).
	MapTerrainGroup(mapPath string) string
}

// PaletteResolver decides which palette applies to each kind of game asset.
// Rendering code consults the resolver and never special-cases the game.
//
// Total Annihilation keys everything off one global palette. TA:Kingdoms has
// no global palette — gamedata/sidedata.tdf assigns each side a `nameprefix`,
// a texture `palette` and a `buildpalette`, and terrain uses a per-kingdom
// table; its resolver maps an asset's name prefix to its palette.
type PaletteResolver interface {
	// TexturePalette returns the palette for a 3DO model texture GAF (by VFS path).
	TexturePalette(gafPath string) *gaf.Palette
	// ModelColorPalette returns the palette for a 3DO model's colour-keyed
	// primitives (by object/model name).
	ModelColorPalette(object string) color.Palette
	// FeaturePalette returns the palette for a feature / anim sprite GAF.
	FeaturePalette(gafName string) *gaf.Palette
	// TerrainPalette returns the palette for a map's terrain + baked minimap
	// (by map VFS path).
	TerrainPalette(mapPath string) color.Palette
	// TextureRenderOptions returns how 3DO model textures resolve
	// transparency, given the resolved palette. TA renders unit textures
	// fully opaque (palette[TI] is a real colour); TA:Kingdoms texture
	// atlases reserve a transparent key colour which must be punched out.
	TextureRenderOptions(pal *gaf.Palette) gaf.RenderOptions
	// TextureSidePrefix returns the side name-prefix (lowercase, e.g. "ara")
	// for a 3DO model name, or "" when sides don't apply.
	TextureSidePrefix(object string) string
	// TexturePaletteForSide returns the texture palette for an explicit side
	// prefix (the ?side= a client passes with a texture fetch), or nil when
	// the side is unknown / sides don't apply.
	TexturePaletteForSide(side string) *gaf.Palette
}

// Tileset is one terrain set selectable when creating a new map. JSON tags
// match the studio's /api/studio/tilesets response shape so adapters'
// results serialize directly.
type Tileset struct {
	Slug           string `json:"slug"`
	Label          string `json:"label"`
	DefaultTileset string `json:"defaultTileset"`
}

// GlobalPalette loads the install's global palette (palettes/palette.pal)
// with the embedded TA palette as fallback, never returning nil. Shared by
// both games: TA uses it for everything, TA:K as the last-resort fallback
// when a side palette is missing.
func GlobalPalette(fs VFS, embedded []byte) *gaf.Palette {
	if data, err := fs.ReadFile("palettes/palette.pal"); err == nil && len(data) >= 1024 {
		if pal, err := gaf.LoadPaletteFromBytes(data); err == nil {
			return pal
		}
	}
	if pal, err := gaf.LoadPaletteFromBytes(embedded); err == nil {
		return pal
	}
	return gaf.FallbackPalette()
}

// registry holds the known games by context id.
var registry = map[string]Game{}

// Register adds a game to the registry. The shipped games register themselves
// from their package init; a custom game does the same from its own package.
func Register(g Game) { registry[g.ID()] = g }

// Resolve returns the Game for a kbot context id. Unknown ids — including
// "custom" contexts that haven't registered their own Game — resolve to the
// registered "totala" implementation, the baseline TA-format behaviour a
// custom game is assumed to start from.
func Resolve(id string) Game {
	if g, ok := registry[id]; ok {
		return g
	}
	return registry["totala"]
}

// Lookup returns the Game registered under an exact id, with ok=false for
// unknown ids — for callers that must reject rather than fall back (CLI
// argument validation, config checks).
func Lookup(id string) (Game, bool) {
	g, ok := registry[id]
	return g, ok
}

// IDs lists the registered game ids in sorted order, for help text and
// error messages.
func IDs() []string {
	out := make([]string, 0, len(registry))
	for id := range registry {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
