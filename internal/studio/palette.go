package studio

import (
	"bytes"
	"image/color"
	"path"
	"sort"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/gamedata/tak"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// paletteResolver decides which palette applies to each kind of game asset.
// Rendering code consults the resolver and never special-cases the game; the
// concrete implementation is chosen once per session from its game id.
//
// Total Annihilation keys everything off one global palette. TA:Kingdoms has no
// global palette — gamedata/sidedata.tdf assigns each side a `nameprefix`, a
// texture `palette` and a `buildpalette`, and terrain uses a per-kingdom table.
// The TA:K resolver reads sidedata to map an asset's name prefix to its palette.
type paletteResolver interface {
	// texturePalette returns the palette for a 3DO model texture GAF (by VFS path).
	texturePalette(gafPath string) *gaf.Palette
	// modelColorPalette returns the palette for a 3DO model's colour-keyed
	// primitives (by object/model name).
	modelColorPalette(object string) color.Palette
	// featurePalette returns the palette for a feature / anim sprite GAF.
	featurePalette(gafName string) *gaf.Palette
	// terrainPalette returns the palette for a map's terrain + baked minimap
	// (by map VFS path).
	terrainPalette(mapPath string) color.Palette
	// textureRenderOptions returns how 3DO model textures resolve transparency,
	// given the resolved palette. TA renders unit textures fully opaque
	// (palette[TI] is a real colour); TA:Kingdoms texture atlases reserve a
	// transparent key colour (the (128,0,128) "purple" the artists paint behind
	// dragon wings, glass, etc.) which must be punched out.
	textureRenderOptions(pal *gaf.Palette) gaf.RenderOptions
	// textureSidePrefix returns the side name-prefix (lowercase, e.g. "ara")
	// for a 3DO model name, or "" when sides don't apply. TA:K ships
	// same-named logo/team textures in every side's GAF, so texture lookups
	// for a unit must prefer GAFs from its own side.
	textureSidePrefix(object string) string
	// texturePaletteForSide returns the texture palette for an explicit side
	// prefix (the ?side= a client passes with a texture fetch), or nil when
	// the side is unknown / sides don't apply. TA:K logo art is painted in
	// shared palette indices that take their team colours from the viewing
	// unit's side palette, so the requester's side wins over the GAF's name.
	texturePaletteForSide(side string) *gaf.Palette
}

// takTransparentKey is the colour TA:Kingdoms texture palettes reserve as the
// transparent key (palette index 5 in the shipped side palettes).
var takTransparentKey = color.RGBA{R: 128, G: 0, B: 128, A: 255}

// palettes returns the session's palette resolver, constructed once from the
// game id. This is the single place the game is consulted; everything else
// talks to the interface.
func (sess *Session) palettes() paletteResolver {
	sess.paletteOnce.Do(func() {
		if sess.game == kbotctx.GameTAKingdoms {
			sess.paletteResolver = newTAKPaletteResolver(sess)
		} else {
			sess.paletteResolver = &taPaletteResolver{sess: sess}
		}
	})
	return sess.paletteResolver
}

// globalGAFPalette is the VFS (or embedded TA) palette as a *gaf.Palette, with a
// greyscale fallback so callers never get nil.
func (sess *Session) globalGAFPalette() *gaf.Palette {
	if pal, err := gaf.LoadPaletteFromBytes(sess.loadPaletteBytes()); err == nil {
		return pal
	}
	return gaf.FallbackPalette()
}

// ── Total Annihilation: one global palette for everything ───────────────────

type taPaletteResolver struct{ sess *Session }

func (r *taPaletteResolver) texturePalette(string) *gaf.Palette     { return r.sess.globalGAFPalette() }
func (r *taPaletteResolver) modelColorPalette(string) color.Palette { return r.sess.loadVFSPalette() }
func (r *taPaletteResolver) featurePalette(string) *gaf.Palette     { return r.sess.globalGAFPalette() }
func (r *taPaletteResolver) terrainPalette(string) color.Palette    { return r.sess.loadVFSPalette() }
func (r *taPaletteResolver) textureRenderOptions(*gaf.Palette) gaf.RenderOptions {
	return gaf.RenderOptions{Mode: gaf.TransparencyModeNone}
}
func (r *taPaletteResolver) textureSidePrefix(string) string          { return "" }
func (r *taPaletteResolver) texturePaletteForSide(string) *gaf.Palette { return nil }

// ── TA:Kingdoms: sidedata-driven, per-side / per-kingdom palettes ────────────

// takSide is one playable side's palette identity, distilled from sidedata.tdf.
type takSide struct {
	prefix       string // nameprefix, upper-case (ARA, TAR, VER, ZON, …)
	name         string // side name, lower-case (aramon, taros, …)
	texPalStem   string // texture palette file stem (ara_textures)
	buildPalStem string // build-picture palette file stem (arabipal)
}

type takPaletteResolver struct {
	sess  *Session
	sides []takSide // sorted by prefix length desc for longest-match

	mu      sync.Mutex
	palFile map[string]*gaf.Palette // palette-file stem -> palette (nil cached = absent)

	kingMu  sync.Mutex
	kingdom map[string]string // map path -> kingdom from sibling .ota
}

func newTAKPaletteResolver(sess *Session) *takPaletteResolver {
	r := &takPaletteResolver{
		sess:    sess,
		palFile: map[string]*gaf.Palette{},
		kingdom: map[string]string{},
	}
	r.loadSides()
	return r
}

// loadSides parses gamedata/sidedata.tdf into the prefix→palette table.
func (r *takPaletteResolver) loadSides() {
	data, err := r.sess.vfs.ReadFile("gamedata/sidedata.tdf")
	if err != nil {
		return
	}
	var sides []tak.Side
	if err := tdf.Unmarshal(data, &sides); err != nil {
		return
	}
	for _, s := range sides {
		prefix := strings.ToUpper(strings.TrimSpace(s.NamePrefix))
		if prefix == "" {
			continue
		}
		r.sides = append(r.sides, takSide{
			prefix:       prefix,
			name:         strings.ToLower(strings.TrimSpace(s.Name)),
			texPalStem:   palStem(s.Palette),
			buildPalStem: palStem(s.BuildPalette),
		})
	}
	sort.Slice(r.sides, func(i, j int) bool {
		return len(r.sides[i].prefix) > len(r.sides[j].prefix)
	})
}

// palStem strips a palette file's directory + extension, leaving the stem used
// to probe palettes/<stem>.{pcx,pal} (sidedata names .pal files that ship as
// .pcx in the GOG build, so the extension can't be trusted).
func palStem(name string) string {
	base := strings.ToLower(path.Base(strings.TrimSpace(name)))
	return strings.TrimSuffix(base, path.Ext(base))
}

// sideForName returns the side whose nameprefix begins the asset's base name.
func (r *takPaletteResolver) sideForName(name string) *takSide {
	base := strings.ToUpper(path.Base(name))
	base = strings.TrimSuffix(base, strings.ToUpper(path.Ext(base)))
	for i := range r.sides {
		if strings.HasPrefix(base, r.sides[i].prefix) {
			return &r.sides[i]
		}
	}
	return nil
}

// paletteFromStem loads (and caches) palettes/<stem>.{pcx,pal}; nil if absent.
func (r *takPaletteResolver) paletteFromStem(stem string) *gaf.Palette {
	if stem == "" {
		return nil
	}
	r.mu.Lock()
	if p, ok := r.palFile[stem]; ok {
		r.mu.Unlock()
		return p
	}
	r.mu.Unlock()

	var pal *gaf.Palette
	if data, err := r.sess.vfs.ReadFile("palettes/" + stem + ".pcx"); err == nil {
		if reader, err := pcx.LoadFromReader(bytes.NewReader(data)); err == nil {
			pal = reader.EmbeddedPalette()
		}
	}
	if pal == nil {
		if data, err := r.sess.vfs.ReadFile("palettes/" + stem + ".pal"); err == nil {
			if p, err := gaf.LoadPaletteFromBytes(data); err == nil {
				pal = p
			}
		}
	}
	r.mu.Lock()
	r.palFile[stem] = pal
	r.mu.Unlock()
	return pal
}

func (r *takPaletteResolver) texturePalette(gafPath string) *gaf.Palette {
	if s := r.sideForName(path.Base(gafPath)); s != nil {
		if pal := r.paletteFromStem(s.texPalStem); pal != nil {
			return pal
		}
	}
	return r.sess.globalGAFPalette()
}

func (r *takPaletteResolver) texturePaletteForSide(side string) *gaf.Palette {
	side = strings.ToUpper(strings.TrimSpace(side))
	if side == "" {
		return nil
	}
	for i := range r.sides {
		if r.sides[i].prefix == side {
			return r.paletteFromStem(r.sides[i].texPalStem)
		}
	}
	return nil
}

func (r *takPaletteResolver) textureSidePrefix(object string) string {
	if s := r.sideForName(object); s != nil {
		return strings.ToLower(s.prefix)
	}
	return ""
}

func (r *takPaletteResolver) modelColorPalette(object string) color.Palette {
	if s := r.sideForName(object); s != nil {
		if pal := r.paletteFromStem(s.texPalStem); pal != nil {
			return pal.ColorModel()
		}
	}
	return r.sess.loadVFSPalette()
}

func (r *takPaletteResolver) featurePalette(gafName string) *gaf.Palette {
	if s := r.sideForName(path.Base(gafName)); s != nil && s.name != "" {
		if pal := r.paletteFromStem(s.name + "_features"); pal != nil {
			return pal
		}
	}
	return r.sess.globalGAFPalette()
}

func (r *takPaletteResolver) textureRenderOptions(pal *gaf.Palette) gaf.RenderOptions {
	// TA:K texture atlases paint the transparent regions (dragon wings, glass)
	// with a fixed key colour rather than honouring the GAF's stored
	// transparency index, so punch out whichever palette entry holds that key.
	if pal != nil {
		for i, c := range pal.Colors {
			if c.R == takTransparentKey.R && c.G == takTransparentKey.G && c.B == takTransparentKey.B {
				return gaf.RenderOptions{Mode: gaf.TransparencyModeIndex, Index: uint8(i)}
			}
		}
	}
	return gaf.RenderOptions{Mode: gaf.TransparencyModeNone}
}

func (r *takPaletteResolver) terrainPalette(mapPath string) color.Palette {
	if pal := r.takKingdomPalette(r.kingdomForMap(mapPath)); pal != nil {
		return pal
	}
	return r.sess.loadVFSPalette()
}

func (r *takPaletteResolver) takKingdomPalette(kingdom string) color.Palette {
	raw, ok := assets.TAKPalettes[kingdom]
	if !ok {
		return nil
	}
	pal, err := gaf.LoadPaletteFromBytes(raw)
	if err != nil {
		return nil
	}
	return pal.ColorModel()
}

// kingdomForMap reads the `kingdom=` affinity from a map's sibling .ota.
func (r *takPaletteResolver) kingdomForMap(mapPath string) string {
	key := strings.ToLower(mapPath)
	r.kingMu.Lock()
	if k, ok := r.kingdom[key]; ok {
		r.kingMu.Unlock()
		return k
	}
	r.kingMu.Unlock()

	kingdom := ""
	otaPath := strings.TrimSuffix(mapPath, path.Ext(mapPath)) + ".ota"
	if data, err := r.sess.vfs.ReadFile(otaPath); err == nil {
		if doc, err := tdf.Parse(bytes.NewReader(data)); err == nil {
			if gh := doc.Section("GlobalHeader"); gh != nil {
				kingdom = strings.ToLower(strings.TrimSpace(gh.String("kingdom")))
			}
		}
	}
	r.kingMu.Lock()
	r.kingdom[key] = kingdom
	r.kingMu.Unlock()
	return kingdom
}
