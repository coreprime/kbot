package studio

import (
	"image/color"
	"sync"

	"github.com/coreprime/kbot-engine/games"
	"github.com/coreprime/kbot-io/formats/gaf"

	"github.com/coreprime/kbot/internal/palettepick"

	// The shipped games register themselves with the games registry from
	// their package inits; the blank imports make sure both are linked into
	// the studio regardless of what else references them.
	_ "github.com/coreprime/kbot-game-takingdoms/takingdoms"
	_ "github.com/coreprime/kbot-game-totala/totala"
)

// totalaID is the games-registry id of Total Annihilation.
const totalaID = "totala"

// palettes returns the session's game adapter, constructed once from the
// context's game id. This is the single place game identity is consulted;
// everything else — palette resolution, cursor palettes, unit sounds,
// tilesets — talks to the games.Adapter interface.
//
// For Total Annihilation the adapter's palettes are replaced by the
// install's palette loaded as the game loads it (see taPalettes), so the
// minimaps, sandbox terrain, features and textures use the same colours
// as the editor's tile pool and the asset explorer.
func (sess *Session) palettes() games.Adapter {
	sess.paletteOnce.Do(func() {
		a := games.Resolve(sess.game).NewAdapter(sess.vfs)
		if a.Game().ID() == totalaID {
			ta := &taPalettes{Adapter: a}
			if sess.vfs != nil {
				ta.vfs = sess.vfs
			}
			a = ta
		}
		sess.adapter = a
	})
	return sess.adapter
}

// taPalettes is a Total Annihilation adapter whose palette lookups all give
// the install's one palette as the game loads it (palettepick.GamePalette):
// the first 1,024 bytes of a longer palettes/palette.pal, and
// palettes/palette.pcx when the .pal is empty or missing. Every entry is
// opaque; sprite transparency comes from the render options.
type taPalettes struct {
	games.Adapter
	vfs palettepick.VFS // nil when the session has no VFS

	once sync.Once
	pal  *gaf.Palette
}

// global loads the install's palette once.
func (a *taPalettes) global() *gaf.Palette {
	a.once.Do(func() {
		a.pal = palettepick.GamePalette(a.vfs).Palette
	})
	return a.pal
}

func (a *taPalettes) TexturePalette(string) *gaf.Palette     { return a.global() }
func (a *taPalettes) ModelColorPalette(string) color.Palette { return a.global().ColorModel() }
func (a *taPalettes) FeaturePalette(string) *gaf.Palette     { return a.global() }
func (a *taPalettes) TerrainPalette(string) color.Palette    { return a.global().ColorModel() }
