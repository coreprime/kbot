package studio

// pack.go — the static asset-pack extractor behind `kbot pack`.
//
// A pack is the studio's on-demand asset API materialised as plain files:
// the same JSON/PNG payloads the /api/studio/* endpoints serve, written
// once into a directory that any static file host can serve.  The
// browser-side @kbot/game3d HttpPackProvider implements the AssetProvider
// contract over a pack URL, so the renderer runs with no studio server.
//
// Layout (all filenames lower-case, sanitised by packStem):
//
//	manifest.json                    game id, sides, unit list, content hash
//	unitdb.json                      per-unit definition database (see packUnitJSON)
//	palette.json                     {"palette": [[r,g,b] × 256]}
//	README.md                        this layout, for humans unpacking a pack
//	models/<name>.json               ModelLoader geometry (enhanced mesh baked in)
//	textures/<name>.png              3DO texture (name--<side>.png for per-side variants)
//	cob/<name>.json                  disassembled COB animation script
//	cob/<name>.cob                   raw COB bytecode (the engine's runnable form)
//	sounds/<stem>.wav                unit/weapon sound effects
//	weaponbitmaps/<weapon>.json      rendertype=4 projectile sprite strips
//	cursors/<sequence>.png           cursor glyphs (APNG when animated)
//	groundtiles/<tileset>.png        seamless flat-terrain tiles
//	maps/<name>.json                 map data (+ sibling .tiles.png / .minimap.png)
//
// Determinism: the same install + options produce byte-identical packs
// (stable ordering everywhere, no timestamps), so the manifest's
// contentHash doubles as the pack identity the replayer's recording ↔
// pack matching keys on.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/games"
)

// PackOptions configures a BuildPack run.
type PackOptions struct {
	// Game is the games-registry id ("totala", "takingdoms").
	Game string
	// Units selects the units to pack by name (case-insensitive).
	// Empty means every FBI-defined unit in the install.
	Units []string
	// Maps selects maps to pack by base name (no extension). Empty means
	// no maps; the single entry "all" packs every maps/*.tnt.
	Maps []string
	// Force allows writing into an existing non-empty output directory
	// (its previous contents are removed first).
	Force bool
}

// PackResult reports what BuildPack wrote.
type PackResult struct {
	OutDir    string
	Hash      string
	Units     []string
	Maps      []string
	FileCount int
	Warnings  []string
}

// packUnitJSON is one unitdb.json entry.  The top-level fields are the
// inputs a unit-DB context builder (network sync decode) consumes:
// the pack-ordinal id, movementClass + motionDomain, and the meta block's
// buildTime / maxDamage / weapon stats.  Meta carries the full FBI/TDF
// detail in the same shape as /api/studio/unit/{name}.
type packUnitJSON struct {
	// ID is the unit's 1-based ordinal in the FULL game unit list sorted
	// by name — stable across subset packs of the same install.  It is a
	// pack-local identifier, not TA's wire unit-type id.
	ID   int    `json:"id"`
	Name string `json:"name"`
	Side string `json:"side,omitempty"`
	// Title / Description are the FBI's human-readable Name/Description.
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	TEDClass    string `json:"tedClass,omitempty"`
	// Model / Script name the pack files (models/<model>.json,
	// cob/<script>.json) when the unit ships them.
	Model  string `json:"model,omitempty"`
	Script string `json:"script,omitempty"`
	// CobBin is the pack-relative path of the unit's RAW COB bytecode
	// (cob/<name>.cob) — the runnable form the engine's script VM compiles
	// via FromCOB, as opposed to the debug-oriented JSON disassembly named
	// by Script. Empty when the unit ships no script.
	CobBin string `json:"cobBin,omitempty"`
	// MovementClass is the raw FBI movementclass= name (resolves against
	// gamedata/moveinfo.tdf); MotionDomain classifies the unit's motion
	// blob family: "ground", "air", "sea" or "building".
	MovementClass string `json:"movementClass,omitempty"`
	MotionDomain  string `json:"motionDomain"`
	// Meta is the full per-unit detail (movement numbers, buildTime,
	// maxDamage, economy, footprint, weapons, sounds, corpse chain) —
	// identical to the studio's /api/studio/unit/{name} response.
	Meta *unitMetaJSON `json:"meta"`
}

type packUnitDBJSON struct {
	Game string `json:"game"`
	// UnitCount counts the units IN THIS PACK; GameUnitCount counts every
	// FBI-defined unit in the source install.  Derivations that depend on
	// the game's full unit-type table (e.g. type-id bit widths) must use
	// GameUnitCount — a subset pack doesn't change the game's table.
	UnitCount     int            `json:"unitCount"`
	GameUnitCount int            `json:"gameUnitCount"`
	Units         []packUnitJSON `json:"units"`
}

type packManifest struct {
	Format        string   `json:"format"`
	FormatVersion int      `json:"formatVersion"`
	Game          string   `json:"game"`
	Sides         []string `json:"sides"`
	Palette       string   `json:"palette"`
	UnitDB        string   `json:"unitDb"`
	UnitCount     int      `json:"unitCount"`
	GameUnitCount int      `json:"gameUnitCount"`
	Units         []string `json:"units"`
	Maps          []string `json:"maps,omitempty"`
	// ContentHash is sha256 over every pack file except manifest.json
	// (sorted by path; see BuildPack) — the pack's identity.
	ContentHash string `json:"contentHash"`
}

type packMapJSON struct {
	Name     string          `json:"name"`
	TileW    int             `json:"tileW"`
	TileH    int             `json:"tileH"`
	SeaLevel int             `json:"seaLevel"`
	Heights  []int           `json:"heights"`
	Voids    []int           `json:"voids"`
	Tiles    []loadedTile    `json:"tiles"`
	Features []loadedFeature `json:"features"`
	TilePool string          `json:"tilePool"`
	Minimap  string          `json:"minimap,omitempty"`
	OTA      *otaState       `json:"ota,omitempty"`
}

// packStem sanitises an asset name into the pack's filename alphabet
// (lower-case [a-z0-9._-]); the JS HttpPackProvider applies the identical
// mapping before fetching.
func packStem(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

// packWriter tracks every file written under the pack root so the content
// hash can walk them in sorted order afterwards.
type packWriter struct {
	root  string
	files map[string]bool
}

func (pw *packWriter) write(rel string, data []byte) error {
	if pw.files[rel] {
		return nil // first write wins — shared assets are byte-identical anyway
	}
	full := filepath.Join(pw.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(full, data, 0o644); err != nil {
		return err
	}
	pw.files[rel] = true
	return nil
}

func (pw *packWriter) sortedFiles() []string {
	out := make([]string, 0, len(pw.files))
	for rel := range pw.files {
		out = append(out, rel)
	}
	sort.Strings(out)
	return out
}

func packJSON(v any) ([]byte, error) {
	return json.Marshal(v)
}

func packJSONIndent(v any) ([]byte, error) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// BuildPack extracts a game install into a static asset pack under outDir.
func BuildPack(installPath, outDir string, opts PackOptions) (*PackResult, error) {
	if _, err := os.Stat(installPath); err != nil {
		return nil, fmt.Errorf("install path: %w", err)
	}
	if entries, err := os.ReadDir(outDir); err == nil && len(entries) > 0 {
		if !opts.Force {
			return nil, fmt.Errorf("output directory %s is not empty (use --force to replace it)", outDir)
		}
		if err := os.RemoveAll(outDir); err != nil {
			return nil, fmt.Errorf("clear output directory: %w", err)
		}
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, fmt.Errorf("create output directory: %w", err)
	}

	vfs, err := filesystem.NewVirtualFileSystem(installPath, studioFSConfig())
	if err != nil {
		return nil, fmt.Errorf("mount install: %w", err)
	}
	sess := newSession("pack", "pack", vfs, "")
	sess.game = opts.Game
	defer func() { _ = sess.close() }()

	pw := &packWriter{root: outDir, files: map[string]bool{}}
	res := &PackResult{OutDir: outDir}
	warnf := func(format string, args ...any) {
		res.Warnings = append(res.Warnings, fmt.Sprintf(format, args...))
	}

	// ── Unit selection ──
	// The full FBI-defined unit list (sorted by name) assigns the stable
	// pack ordinals; the selection filters which of them get extracted.
	list, byID := sess.ensureModelIndex()
	var allUnits []string
	for _, e := range list {
		if e.HasFBI {
			allUnits = append(allUnits, e.Name)
		}
	}
	sort.Strings(allUnits)
	ordinal := make(map[string]int, len(allUnits))
	for i, n := range allUnits {
		ordinal[n] = i + 1
	}

	selected := allUnits
	if len(opts.Units) > 0 {
		want := map[string]bool{}
		for _, u := range opts.Units {
			u = strings.ToLower(strings.TrimSpace(u))
			if u == "" {
				continue
			}
			if u == "all" {
				want = nil
				break
			}
			want[u] = true
		}
		if want != nil {
			selected = selected[:0:0]
			for u := range want {
				if _, ok := ordinal[u]; !ok {
					return nil, fmt.Errorf("unknown unit %q (not an FBI-defined unit in this install)", u)
				}
				selected = append(selected, u)
			}
			sort.Strings(selected)
		}
	}

	// ── Per-unit extraction ──
	dbUnits := make([]packUnitJSON, 0, len(selected))
	sidesSeen := map[string]bool{}
	// texture requests are de-duplicated on (name, side)
	texDone := map[string]bool{}
	writeTexture := func(name, side string) {
		key := name + "|" + side
		if texDone[key] {
			return
		}
		texDone[key] = true
		src, ok := sess.resolveTextureSource(strings.ToLower(name), side)
		if !ok {
			// Missing texture: the provider falls back to its neutral
			// grey client-side, matching the studio server's behaviour.
			return
		}
		pngBytes, err := sess.renderTexturePNG(src, side)
		if err != nil {
			warnf("texture %s: %v", name, err)
			return
		}
		rel := "textures/" + packStem(name)
		if side != "" {
			rel += "--" + packStem(side)
		}
		if err := pw.write(rel+".png", pngBytes); err != nil {
			warnf("write texture %s: %v", name, err)
		}
	}
	writeModel := func(entry modelEntry) (string, bool) {
		if entry.Path == "" {
			return "", false
		}
		mj, err := sess.buildModelJSON(entry, true)
		if err != nil {
			warnf("model %s: %v", entry.Name, err)
			return "", false
		}
		data, err := packJSON(mj)
		if err != nil {
			warnf("model %s: encode: %v", entry.Name, err)
			return "", false
		}
		if err := pw.write("models/"+packStem(entry.Name)+".json", data); err != nil {
			warnf("write model %s: %v", entry.Name, err)
			return "", false
		}
		side := strings.TrimPrefix(mj.TextureQuery, "side=")
		if side == mj.TextureQuery {
			side = ""
		}
		for _, tex := range mj.Textures {
			writeTexture(tex, side)
		}
		return entry.Name, true
	}
	soundDone := map[string]bool{}
	writeSound := func(stem string) {
		stem = strings.ToLower(strings.TrimSpace(stem))
		if stem == "" || soundDone[stem] {
			return
		}
		soundDone[stem] = true
		data, ok := sess.resolveSoundBytes(stem)
		if !ok {
			warnf("sound %s: not found", stem)
			return
		}
		if err := pw.write("sounds/"+packStem(stem)+".wav", data); err != nil {
			warnf("write sound %s: %v", stem, err)
		}
	}

	for _, name := range selected {
		entry := byID[name]
		meta, err := sess.buildUnitMeta(name, [3]string{})
		if err != nil {
			warnf("unit %s: %v", name, err)
			continue
		}
		u := packUnitJSON{
			ID:          ordinal[name],
			Name:        name,
			Side:        entry.Side,
			Title:       entry.UnitTitle,
			Description: entry.Description,
			TEDClass:    entry.Category,
			Meta:        meta,
		}
		if fbi, err := sess.loadUnitFBI(name); err == nil {
			u.MovementClass = strings.ToUpper(strings.TrimSpace(fbi.Info.MovementClass))
		}
		switch {
		case !meta.CanMove:
			u.MotionDomain = "building"
		case meta.IsAircraft:
			u.MotionDomain = "air"
		case meta.IsShip || meta.IsSub:
			u.MotionDomain = "sea"
		default:
			u.MotionDomain = "ground"
		}
		if entry.Side != "" {
			sidesSeen[strings.ToUpper(entry.Side)] = true
		}

		if model, ok := writeModel(entry); ok {
			u.Model = model
		}
		// Corpse chain models so a replay can swap wrecks in on death.
		for _, obj := range []string{meta.CorpseObject, meta.CorpseHeapObject} {
			if obj == "" {
				continue
			}
			if ce, ok := sess.resolveModelEntry(obj); ok {
				writeModel(ce)
			}
		}

		// COB — keyed by the unit name (what the renderer asks for);
		// skip the slow BOS decompile, the runtime only walks the
		// disassembly.
		if cj, err := sess.buildCobScriptJSON(name, false); err == nil {
			if data, jerr := packJSON(cj); jerr == nil {
				if werr := pw.write("cob/"+packStem(name)+".json", data); werr == nil {
					u.Script = name
				}
			}
		}
		// Raw COB bytecode alongside the disassembly: the runnable form the
		// engine's script VM consumes (a replay attaches it to the unit meta
		// so piece animation runs), served byte-identical to the install's
		// scripts/<name>.cob.
		if raw, ok := sess.resolveCobBytes(name); ok {
			rel := "cob/" + packStem(name) + ".cob"
			if werr := pw.write(rel, raw); werr == nil {
				u.CobBin = rel
			} else {
				warnf("write cob bytes %s: %v", name, werr)
			}
		}

		// Sounds: the FBI sound-category events plus each weapon's
		// fire/hit/water effects.
		for _, stem := range meta.Sounds {
			writeSound(stem)
		}
		for _, w := range meta.Weapons {
			if w.Name == "" {
				continue
			}
			writeSound(w.SoundStart)
			writeSound(w.SoundHit)
			writeSound(w.SoundWater)
			if w.RenderType == 4 {
				if body, err := sess.buildWeaponBitmapJSON(w.Name); err == nil {
					if werr := pw.write("weaponbitmaps/"+packStem(w.Name)+".json", body); werr != nil {
						warnf("write weapon bitmap %s: %v", w.Name, werr)
					}
				}
			}
		}

		dbUnits = append(dbUnits, u)
	}

	// ── Global assets ──
	if data, err := packJSONIndent(map[string]any{"palette": sess.paletteRGB()}); err == nil {
		if werr := pw.write("palette.json", data); werr != nil {
			return nil, werr
		}
	}
	if reader, seqs, err := sess.loadCursorSequences(); err == nil {
		for _, s := range seqs {
			if len(s.Frames) == 0 {
				continue
			}
			pngBytes, cerr := sess.encodeCursorSequencePNG(s)
			if cerr != nil {
				warnf("cursor %s: %v", s.Name, cerr)
				continue
			}
			if werr := pw.write("cursors/"+packStem(s.Name)+".png", pngBytes); werr != nil {
				warnf("write cursor %s: %v", s.Name, werr)
			}
		}
		_ = reader.Close()
	}
	for _, ts := range sess.palettes().Tilesets() {
		pngBytes, err := sess.renderGroundTilePNG(strings.ToLower(ts.Slug))
		if err != nil {
			continue // tilesets without flat sections simply aren't packed
		}
		if werr := pw.write("groundtiles/"+packStem(ts.Slug)+".png", pngBytes); werr != nil {
			warnf("write ground tile %s: %v", ts.Slug, werr)
		}
	}

	// ── Maps ──
	mapsPacked, err := buildPackMaps(sess, pw, opts.Maps, warnf)
	if err != nil {
		return nil, err
	}
	res.Maps = mapsPacked

	// ── unitdb.json + README ──
	db := packUnitDBJSON{
		Game:          games.Resolve(opts.Game).ID(),
		UnitCount:     len(dbUnits),
		GameUnitCount: len(allUnits),
		Units:         dbUnits,
	}
	dbBytes, err := packJSONIndent(db)
	if err != nil {
		return nil, fmt.Errorf("encode unitdb: %w", err)
	}
	if err := pw.write("unitdb.json", dbBytes); err != nil {
		return nil, err
	}
	if err := pw.write("README.md", []byte(packReadme)); err != nil {
		return nil, err
	}

	// ── Content hash + manifest ──
	// Hash every file (sorted paths, path + file digest per line) except
	// manifest.json, which carries the result.
	hash, err := hashPackFiles(outDir, pw.sortedFiles())
	if err != nil {
		return nil, fmt.Errorf("hash pack: %w", err)
	}
	sides := make([]string, 0, len(sidesSeen))
	for s := range sidesSeen {
		sides = append(sides, s)
	}
	sort.Strings(sides)
	manifest := packManifest{
		Format: "kbot-pack",
		// FormatVersion 2 added the raw cob/<name>.cob bytecode files (and
		// the unitdb cobBin field); version-1 readers ignore both.
		FormatVersion: 2,
		Game:          db.Game,
		Sides:         sides,
		Palette:       "palette.json",
		UnitDB:        "unitdb.json",
		UnitCount:     len(dbUnits),
		GameUnitCount: len(allUnits),
		Units:         selected,
		Maps:          mapsPacked,
		ContentHash:   hash,
	}
	manBytes, err := packJSONIndent(manifest)
	if err != nil {
		return nil, fmt.Errorf("encode manifest: %w", err)
	}
	if err := pw.write("manifest.json", manBytes); err != nil {
		return nil, err
	}

	res.Hash = hash
	res.Units = selected
	res.FileCount = len(pw.files)
	return res, nil
}

// buildPackMaps extracts the requested maps ("all" = every maps/*.tnt).
func buildPackMaps(sess *Session, pw *packWriter, requested []string, warnf func(string, ...any)) ([]string, error) {
	if len(requested) == 0 {
		return nil, nil
	}
	// Index the install's TNTs by lower-case base name.
	tntByName := map[string]string{}
	for _, p := range sess.vfs.List() {
		lower := strings.ToLower(p)
		if strings.HasPrefix(lower, "maps/") && strings.HasSuffix(lower, ".tnt") {
			base := strings.TrimSuffix(path.Base(lower), ".tnt")
			if _, dup := tntByName[base]; !dup {
				tntByName[base] = p
			}
		}
	}
	var names []string
	if len(requested) == 1 && strings.EqualFold(requested[0], "all") {
		for n := range tntByName {
			names = append(names, n)
		}
	} else {
		for _, n := range requested {
			n = strings.ToLower(strings.TrimSpace(n))
			if n == "" {
				continue
			}
			if _, ok := tntByName[n]; !ok {
				return nil, fmt.Errorf("unknown map %q (no maps/%s.tnt in this install)", n, n)
			}
			names = append(names, n)
		}
	}
	sort.Strings(names)

	var packed []string
	for _, name := range names {
		mapPath := tntByName[name]
		if err := writePackMap(sess, pw, name, mapPath); err != nil {
			warnf("map %s: %v", name, err)
			continue
		}
		packed = append(packed, name)
	}
	return packed, nil
}

// writePackMap emits maps/<name>.json plus its tile-pool atlas + minimap
// PNGs — the same data /api/studio/load and /api/studio/tile-pool serve.
func writePackMap(sess *Session, pw *packWriter, name, mapPath string) error {
	data, err := sess.vfs.ReadFile(mapPath)
	if err != nil {
		return err
	}
	reader := bytes.NewReader(data)
	m, err := tnt.LoadFromReader(reader)
	if err != nil {
		return fmt.Errorf("parse TNT: %w", err)
	}
	if m.IsTAK {
		return fmt.Errorf("TA:Kingdoms texture-mapped maps are not packed yet")
	}
	features, _ := m.LoadFeatures(reader)
	placements := m.GetFeaturePlacements()

	poolCols := tilePoolCols(len(m.Tiles))
	tiles := make([]loadedTile, len(m.TileMap))
	for i, idx := range m.TileMap {
		tiles[i] = loadedTile{SX: int(idx) % poolCols, SY: int(idx) / poolCols}
	}
	heights := make([]int, len(m.TileAttr))
	voids := make([]int, len(m.TileAttr))
	for i, a := range m.TileAttr {
		heights[i] = int(a.Height)
		if a.Feature == 0xFFFC {
			voids[i] = 1
		}
	}
	outFeatures := make([]loadedFeature, 0, len(placements))
	for _, p := range placements {
		if p.FeatureIdx < 0 || p.FeatureIdx >= len(features) {
			continue
		}
		fname := strings.TrimSpace(features[p.FeatureIdx].Name)
		if fname == "" {
			continue
		}
		outFeatures = append(outFeatures, loadedFeature{Name: fname, AX: p.AttrX, AY: p.AttrY})
	}

	stem := packStem(name)
	out := packMapJSON{
		Name:     name,
		TileW:    m.TileW,
		TileH:    m.TileH,
		SeaLevel: int(m.Header.SeaLevel),
		Heights:  heights,
		Voids:    voids,
		Tiles:    tiles,
		Features: outFeatures,
		TilePool: "maps/" + stem + ".tiles.png",
	}
	if otaData, err := sess.vfs.ReadFile(strings.TrimSuffix(mapPath, path.Ext(mapPath)) + ".ota"); err == nil {
		out.OTA = parseOTA(string(otaData), m.TileW, m.TileH)
	}

	// Tile-pool atlas — each 32×32 tile at (sx*32, sy*32).
	pal := sess.loadVFSPalette()
	rows := (len(m.Tiles) + poolCols - 1) / poolCols
	if rows < 1 {
		rows = 1
	}
	atlas := image.NewRGBA(image.Rect(0, 0, poolCols*32, rows*32))
	for i, tile := range m.Tiles {
		px := (i % poolCols) * 32
		py := (i / poolCols) * 32
		for y := 0; y < 32; y++ {
			for x := 0; x < 32; x++ {
				atlas.Set(px+x, py+y, pal[tile[y*32+x]])
			}
		}
	}
	var atlasBuf bytes.Buffer
	if err := png.Encode(&atlasBuf, atlas); err != nil {
		return fmt.Errorf("encode tile pool: %w", err)
	}
	if err := pw.write(out.TilePool, atlasBuf.Bytes()); err != nil {
		return err
	}

	if m.Minimap != nil {
		if img := m.RenderMinimap(sess.palettes().TerrainPalette(mapPath)); img != nil {
			var buf bytes.Buffer
			if err := png.Encode(&buf, img); err == nil {
				out.Minimap = "maps/" + stem + ".minimap.png"
				if err := pw.write(out.Minimap, buf.Bytes()); err != nil {
					return err
				}
			}
		}
	}

	body, err := packJSON(out)
	if err != nil {
		return fmt.Errorf("encode map json: %w", err)
	}
	return pw.write("maps/"+stem+".json", body)
}

// hashPackFiles computes the pack content hash: sha256 over
// "<path>\x00<sha256(file)>\n" lines in sorted path order.
func hashPackFiles(root string, sortedRel []string) (string, error) {
	h := sha256.New()
	for _, rel := range sortedRel {
		f, err := os.Open(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		fh := sha256.New()
		_, cerr := io.Copy(fh, f)
		_ = f.Close()
		if cerr != nil {
			return "", cerr
		}
		_, _ = fmt.Fprintf(h, "%s\x00%s\n", rel, hex.EncodeToString(fh.Sum(nil)))
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

// packReadme is written into every pack so a directory listing explains
// itself.  Static content — part of the hashed payload.
const packReadme = `# kbot asset pack

A static extraction of a game install, produced by ` + "`kbot pack`" + `.
Serve this directory over any static HTTP host and point
@kbot/game3d's HttpPackProvider at its base URL; the renderer needs no
other server.

Files:

- manifest.json — game id, sides, unit list and the pack contentHash
  (sha256 over every other file in sorted path order; the pack identity).
- unitdb.json — per-unit definitions: pack ordinal id, movement class +
  motion domain, and full FBI/TDF-derived stats (buildTime, maxDamage,
  weapons, economy, footprint, sounds, corpse chain).
- palette.json — {"palette": [[r,g,b] x 256]}.
- models/<name>.json — preprocessed model geometry (enhanced mesh baked
  in) in the @kbot/game3d ModelLoader shape.
- textures/<name>.png — model textures ("<name>--<side>.png" for
  per-side variants).
- cob/<name>.json — disassembled COB animation scripts (debug/viewer form).
- cob/<name>.cob — raw COB bytecode, byte-identical to the install's
  scripts/<name>.cob; the runnable form the engine's script VM loads so
  units animate (walk cycles, turrets, build poses).
- sounds/<stem>.wav — unit + weapon sound effects.
- weaponbitmaps/<weapon>.json — sprite-strip metadata for bitmap
  (rendertype=4) projectiles.
- cursors/<sequence>.png — cursor glyphs (APNG when animated).
- groundtiles/<tileset>.png — seamless 32x32 flat-terrain tiles.
- maps/<name>.json (+ .tiles.png / .minimap.png) — map heights, voids,
  tile placements, features and rendered atlases.

All filenames are lower-case with characters outside [a-z0-9._-]
replaced by "_"; clients apply the same mapping before fetching.
`
