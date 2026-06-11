// Package takingdoms implements games.Game for Total Annihilation: Kingdoms.
//
// TA:K has no global palette: gamedata/sidedata.tdf assigns each playable
// side a name prefix and palette files, terrain uses a per-kingdom table, and
// sound events live in per-class files under gamedata/soundclasses/. Every
// resolver here is driven from that shipped data, so expansion sides (Iron
// Plague's Creon) appear automatically.
package takingdoms

import (
	"bytes"
	"image/color"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/gamedata/tak"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/games"
	"github.com/coreprime/kbot/internal/assets"
)

func init() { games.Register(Game) }

// Game is the TA: Kingdoms singleton.
var Game games.Game = game{}

type game struct{}

func (game) ID() string   { return "takingdoms" }
func (game) Name() string { return "TA: Kingdoms" }

func (g game) NewAdapter(fs games.VFS) games.Adapter {
	a := &adapter{
		fs:           fs,
		palFile:      map[string]*gaf.Palette{},
		kingdom:      map[string]string{},
		soundClasses: map[string]*tdf.Section{},
	}
	a.loadSides()
	return a
}

// transparentKey is the colour TA:K texture palettes reserve as the
// transparent key (palette index 5 in the shipped side palettes).
var transparentKey = color.RGBA{R: 128, G: 0, B: 128, A: 255}

// side is one playable side's palette identity, distilled from sidedata.tdf.
type side struct {
	prefix       string // nameprefix, upper-case (ARA, TAR, VER, ZON, …)
	name         string // side name, lower-case (aramon, taros, …)
	texPalStem   string // texture palette file stem (ara_textures)
	buildPalStem string // build-picture palette file stem (arabipal)
}

type adapter struct {
	fs    games.VFS
	sides []side // sorted by prefix length desc for longest-match
	// sideOrder preserves sidedata.tdf's file order, which is the order the
	// game presents kingdoms in (Tilesets keeps it; the sorted slice above
	// exists only for longest-prefix matching).
	sideOrder []side

	palOnce sync.Once
	pal     *gaf.Palette

	mu      sync.Mutex
	palFile map[string]*gaf.Palette // palette-file stem -> palette (nil cached = absent)

	kingMu  sync.Mutex
	kingdom map[string]string // map path -> kingdom from sibling .ota

	soundMu      sync.Mutex
	soundClasses map[string]*tdf.Section // class name -> section (nil cached = absent)
}

func (a *adapter) Game() games.Game { return Game }

// global is the last-resort palette when a side palette is missing.
func (a *adapter) global() *gaf.Palette {
	a.palOnce.Do(func() {
		a.pal = games.GlobalPalette(a.fs, assets.DefaultPalette)
	})
	return a.pal
}

// loadSides parses gamedata/sidedata.tdf into the prefix→palette table.
func (a *adapter) loadSides() {
	data, err := a.fs.ReadFile("gamedata/sidedata.tdf")
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
		a.sides = append(a.sides, side{
			prefix:       prefix,
			name:         strings.ToLower(strings.TrimSpace(s.Name)),
			texPalStem:   palStem(s.Palette),
			buildPalStem: palStem(s.BuildPalette),
		})
	}
	a.sideOrder = append([]side(nil), a.sides...)
	sort.Slice(a.sides, func(i, j int) bool {
		return len(a.sides[i].prefix) > len(a.sides[j].prefix)
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
func (a *adapter) sideForName(name string) *side {
	base := strings.ToUpper(path.Base(name))
	base = strings.TrimSuffix(base, strings.ToUpper(path.Ext(base)))
	for i := range a.sides {
		if strings.HasPrefix(base, a.sides[i].prefix) {
			return &a.sides[i]
		}
	}
	return nil
}

// paletteFromStem loads (and caches) palettes/<stem>.{pcx,pal}; nil if absent.
func (a *adapter) paletteFromStem(stem string) *gaf.Palette {
	if stem == "" {
		return nil
	}
	a.mu.Lock()
	if p, ok := a.palFile[stem]; ok {
		a.mu.Unlock()
		return p
	}
	a.mu.Unlock()

	var pal *gaf.Palette
	if data, err := a.fs.ReadFile("palettes/" + stem + ".pcx"); err == nil {
		if reader, err := pcx.LoadFromReader(bytes.NewReader(data)); err == nil {
			pal = reader.EmbeddedPalette()
		}
	}
	if pal == nil {
		if data, err := a.fs.ReadFile("palettes/" + stem + ".pal"); err == nil {
			if p, err := gaf.LoadPaletteFromBytes(data); err == nil {
				pal = p
			}
		}
	}
	a.mu.Lock()
	a.palFile[stem] = pal
	a.mu.Unlock()
	return pal
}

// ── games.PaletteResolver ────────────────────────────────────────────────────

func (a *adapter) TexturePalette(gafPath string) *gaf.Palette {
	if s := a.sideForName(path.Base(gafPath)); s != nil {
		if pal := a.paletteFromStem(s.texPalStem); pal != nil {
			return pal
		}
	}
	return a.global()
}

func (a *adapter) TexturePaletteForSide(prefix string) *gaf.Palette {
	prefix = strings.ToUpper(strings.TrimSpace(prefix))
	if prefix == "" {
		return nil
	}
	for i := range a.sides {
		if a.sides[i].prefix == prefix {
			return a.paletteFromStem(a.sides[i].texPalStem)
		}
	}
	return nil
}

func (a *adapter) TextureSidePrefix(object string) string {
	if s := a.sideForName(object); s != nil {
		return strings.ToLower(s.prefix)
	}
	return ""
}

func (a *adapter) ModelColorPalette(object string) color.Palette {
	if s := a.sideForName(object); s != nil {
		if pal := a.paletteFromStem(s.texPalStem); pal != nil {
			return pal.ColorModel()
		}
	}
	return a.global().ColorModel()
}

func (a *adapter) FeaturePalette(gafName string) *gaf.Palette {
	if s := a.sideForName(path.Base(gafName)); s != nil && s.name != "" {
		if pal := a.paletteFromStem(s.name + "_features"); pal != nil {
			return pal
		}
	}
	return a.global()
}

func (a *adapter) TextureRenderOptions(pal *gaf.Palette) gaf.RenderOptions {
	// TA:K texture atlases paint the transparent regions (dragon wings,
	// glass) with a fixed key colour rather than honouring the GAF's stored
	// transparency index, so punch out whichever palette entry holds the key.
	if pal != nil {
		for i, c := range pal.Colors {
			if c.R == transparentKey.R && c.G == transparentKey.G && c.B == transparentKey.B {
				return gaf.RenderOptions{Mode: gaf.TransparencyModeIndex, Index: uint8(i)}
			}
		}
	}
	return gaf.RenderOptions{Mode: gaf.TransparencyModeNone}
}

func (a *adapter) TerrainPalette(mapPath string) color.Palette {
	if pal := kingdomPalette(a.kingdomForMap(mapPath)); pal != nil {
		return pal
	}
	return a.global().ColorModel()
}

func kingdomPalette(kingdom string) color.Palette {
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
func (a *adapter) kingdomForMap(mapPath string) string {
	key := strings.ToLower(mapPath)
	a.kingMu.Lock()
	if k, ok := a.kingdom[key]; ok {
		a.kingMu.Unlock()
		return k
	}
	a.kingMu.Unlock()

	kingdom := ""
	otaPath := strings.TrimSuffix(mapPath, path.Ext(mapPath)) + ".ota"
	if data, err := a.fs.ReadFile(otaPath); err == nil {
		if doc, err := tdf.Parse(bytes.NewReader(data)); err == nil {
			if gh := doc.Section("GlobalHeader"); gh != nil {
				kingdom = strings.ToLower(strings.TrimSpace(gh.String("kingdom")))
			}
		}
	}
	a.kingMu.Lock()
	a.kingdom[key] = kingdom
	a.kingMu.Unlock()
	return kingdom
}

// MapTerrainGroup reports the map's kingdom so the editor can activate the
// matching kingdom's section group (TA:K sections are grouped by kingdom).
func (a *adapter) MapTerrainGroup(mapPath string) string {
	return a.kingdomForMap(mapPath)
}

// CursorPalette: TA:K ships the cursor palette in a sibling anims/cursors.pcx
// (its GAFs carry per-asset palettes).
func (a *adapter) CursorPalette() *gaf.Palette {
	for _, p := range []string{"anims/cursors.pcx", "Anims/cursors.pcx"} {
		data, err := a.fs.ReadFile(p)
		if err != nil {
			continue
		}
		reader, err := pcx.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			continue
		}
		if pal := reader.EmbeddedPalette(); pal != nil {
			return pal
		}
	}
	return nil
}

// UnitSounds maps a TA:K sound class onto the TA-style numbered keys the
// studio client plays. TA:K has no gamedata/sound.tdf — each class is its own
// file under gamedata/soundclasses/ with per-event weighted pools: [select]
// entries become select1..N and [move] + [attack] acknowledgements become
// ok1..N (heaviest first; every variant stays available to the random picker).
func (a *adapter) UnitSounds(category string) map[string]string {
	sec := a.findSoundClass(strings.ToUpper(strings.TrimSpace(category)))
	if sec == nil {
		return nil
	}
	out := make(map[string]string)
	emit := func(sub *tdf.Section, keyBase string, n int) int {
		if sub == nil {
			return n
		}
		type entry struct {
			stem   string
			weight float64
		}
		var pool []entry
		for _, f := range sub.Fields() {
			stem := strings.ToLower(strings.TrimSpace(f.Key()))
			if stem == "" {
				continue
			}
			w, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(f.Value()), ";"), 64)
			pool = append(pool, entry{stem, w})
		}
		sort.SliceStable(pool, func(i, j int) bool { return pool[i].weight > pool[j].weight })
		for _, e := range pool {
			n++
			out[keyBase+strconv.Itoa(n)] = e.stem
		}
		return n
	}
	subs := map[string]*tdf.Section{}
	for _, sub := range sec.Sections() {
		subs[strings.ToLower(sub.Name())] = sub
	}
	emit(subs["select"], "select", 0)
	n := emit(subs["move"], "ok", 0)
	emit(subs["attack"], "ok", n)
	if len(out) == 0 {
		return nil
	}
	return out
}

// findSoundClass scans gamedata/soundclasses/*.tdf for the named class
// section, caching results (nil for known-missing) per adapter.
func (a *adapter) findSoundClass(name string) *tdf.Section {
	if name == "" {
		return nil
	}
	a.soundMu.Lock()
	if sec, ok := a.soundClasses[name]; ok {
		a.soundMu.Unlock()
		return sec
	}
	a.soundMu.Unlock()

	var found *tdf.Section
	for _, p := range a.fs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "gamedata/soundclasses/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		data, err := a.fs.ReadFile(p)
		if err != nil {
			continue
		}
		doc, err := tdf.Parse(bytes.NewReader(data))
		if err != nil {
			continue
		}
		for _, sec := range doc.Sections() {
			if strings.EqualFold(sec.Name(), name) {
				found = sec
				break
			}
		}
		if found != nil {
			break
		}
	}
	a.soundMu.Lock()
	a.soundClasses[name] = found
	a.soundMu.Unlock()
	return found
}

// Tilesets lists the playable kingdoms from sidedata — a TA:K map's terrain
// set is its kingdom. Only sides with a terrain palette qualify
// (Aramon/Taros/Veruna/Zhon/Creon — not the Lifeforms/NPC pseudo-sides).
func (a *adapter) Tilesets() []games.Tileset {
	var out []games.Tileset
	for _, s := range a.sideOrder {
		if s.name == "" {
			continue
		}
		if _, ok := assets.TAKPalettes[s.name]; !ok {
			continue
		}
		out = append(out, games.Tileset{
			Slug:           s.name,
			Label:          strings.ToUpper(s.name[:1]) + s.name[1:],
			DefaultTileset: s.name,
		})
	}
	return out
}
