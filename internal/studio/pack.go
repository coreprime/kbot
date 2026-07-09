package studio

// pack.go — the static asset-pack extractor behind `kbot pack`.
//
// A pack is the studio's on-demand asset API materialised as plain files:
// the same JSON/PNG payloads the /api/studio/* endpoints serve, written
// once into a directory that any static file host can serve.  The
// browser-side @coreprime/kbot-game3d HttpPackProvider implements the AssetProvider
// contract over a pack URL, so the renderer runs with no studio server.
//
// Layout (all filenames lower-case, sanitised by packStem):
//
//	manifest.json                    game id, sides, unit list, content hash
//	unitdb.json                      per-unit definition database (see packUnitJSON)
//	weapons.json                     weapon id → render fields catalogue (see pack_weapons.go)
//	palette.json                     {"palette": [[r,g,b] × 256]}
//	README.md                        this layout, for humans unpacking a pack
//	unitpics/<name>.png              unit build pictures (PCX decoded at native size)
//	models/<name>.json               ModelLoader geometry (authored faces)
//	models-enhanced/<name>.json      ModelLoader geometry with reconstructed faces
//	textures/<name>.png              3DO texture (name--<side>.png for per-side variants; --t<N>.png per-player team pages)
//	cob/<name>.json                  disassembled COB animation script
//	cob/<name>.cob                   raw COB bytecode (the engine's runnable form)
//	sounds/<stem>.wav                unit/weapon sound effects
//	weaponbitmaps/<weapon>.json      rendertype=4 projectile sprite strips
//	cursors/<sequence>.png           cursor glyphs (APNG when animated)
//	groundtiles/<tileset>.png        seamless flat-terrain tiles
//	featuresprites/<id>.png          flat ground features' real GAF art (alpha)
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
	// UnitPic is the pack-relative path of the unit's build picture
	// (unitpics/<name>.png); empty when the install ships none.
	UnitPic string `json:"unitPic,omitempty"`
	// Weapons lists the unit's weapon ids (lower-case weapons.json keys) in
	// SLOT order — index 0 is primary, 1 secondary, 2 tertiary — so a
	// replayer can map a WeaponFire slot number straight onto the catalogue.
	// Interior empty slots stay as "" to preserve slot positions; trailing
	// empties are trimmed, and a weaponless unit omits the field entirely.
	Weapons []string `json:"weapons,omitempty"`
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
	// Weapons names the weapon catalogue file ("weapons.json"); empty when
	// the install defines no weapons (nothing is written in that case).
	Weapons string `json:"weapons,omitempty"`
	// Features names the map-feature catalogue file ("features.json",
	// format v5); empty when the install defines no features.
	Features string `json:"features,omitempty"`
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
		// Team-page sequences additionally pack every per-player colour
		// frame as <rel>--tN.png so a renderer that knows the owning
		// player can bind the right page (the base file stays the first
		// frame — packs and clients that predate team pages keep working).
		if isTeamPage(src) {
			for f := 0; f < src.Frames; f++ {
				fb, ferr := sess.renderTexturePNGFrame(src, side, f)
				if ferr != nil {
					warnf("texture %s frame %d: %v", name, f, ferr)
					continue
				}
				if werr := pw.write(fmt.Sprintf("%s--t%d.png", rel, f), fb); werr != nil {
					warnf("write texture %s frame %d: %v", name, f, werr)
				}
			}
		}
	}
	writeModel := func(entry modelEntry) (string, bool) {
		if entry.Path == "" {
			return "", false
		}
		// Base geometry (models/) is the authored 3DO faces; the enhanced
		// variant (models-enhanced/, format v4) additionally reconstructs
		// the faces TA's artists deleted as a fill-rate optimisation.  Both
		// are written so a static pack can serve the studio's Enhanced Mesh
		// toggle: HttpPackProvider.model(name, {enhanceMesh:true}) fetches
		// the enhanced file and falls back to base when a pack predates v4.
		mj, err := sess.buildModelJSON(entry, false)
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
		if emj, eerr := sess.buildModelJSON(entry, true); eerr == nil {
			if edata, jerr := packJSON(emj); jerr == nil {
				if werr := pw.write("models-enhanced/"+packStem(entry.Name)+".json", edata); werr != nil {
					warnf("write enhanced model %s: %v", entry.Name, werr)
				}
			}
		} else {
			warnf("enhanced model %s: %v", entry.Name, eerr)
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
	// Build pictures are indexed once (stem → VFS path) rather than probed
	// per unit: the VFS list walk is the expensive part and the filenames
	// are mixed-case in real installs, so a straight ReadFile can't be
	// trusted.  Lower rank wins so TA's unitpics/<unit>.pcx beats the
	// TA:Kingdoms anims/buildpic/ layouts when both somehow exist.
	buildPicPath := map[string]string{}
	buildPicRank := map[string]int{}
	for _, p := range sess.vfs.List() {
		lower := strings.ToLower(p)
		var rank int
		switch {
		case strings.HasPrefix(lower, "unitpics/") && strings.HasSuffix(lower, ".pcx"):
			rank = 0
		case strings.HasPrefix(lower, "anims/buildpic/") && strings.HasSuffix(lower, ".jpg"):
			rank = 1
		case strings.HasPrefix(lower, "anims/buildpic/") && strings.HasSuffix(lower, ".jpeg"):
			rank = 2
		case strings.HasPrefix(lower, "anims/buildpic/") && strings.HasSuffix(lower, ".pcx"):
			rank = 3
		default:
			continue
		}
		base := path.Base(lower)
		stem := base[:len(base)-len(path.Ext(base))]
		if prev, ok := buildPicRank[stem]; ok && prev <= rank {
			continue // keep the earlier/better find
		}
		buildPicPath[stem] = p
		buildPicRank[stem] = rank
	}
	writeBuildPic := func(name string) (string, bool) {
		src, ok := buildPicPath[name]
		if !ok {
			return "", false
		}
		data, err := sess.vfs.ReadFile(src)
		if err != nil {
			warnf("build pic %s: %v", name, err)
			return "", false
		}
		img, err := decodeBuildPic(src, data)
		if err != nil {
			warnf("build pic %s: %v", name, err)
			return "", false
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			warnf("build pic %s: encode: %v", name, err)
			return "", false
		}
		rel := "unitpics/" + packStem(name) + ".png"
		if err := pw.write(rel, buf.Bytes()); err != nil {
			warnf("write build pic %s: %v", name, err)
			return "", false
		}
		return rel, true
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
		// Slot-ordered weapon ids (weapons.json keys).  Interior gaps stay
		// as "" so slot 3 keeps index 2 (armcom: laser, -, disintegrator);
		// only trailing empties are dropped.
		slots := make([]string, 0, len(meta.Weapons))
		for _, w := range meta.Weapons {
			slots = append(slots, strings.ToLower(w.Name))
		}
		for len(slots) > 0 && slots[len(slots)-1] == "" {
			slots = slots[:len(slots)-1]
		}
		if len(slots) > 0 {
			u.Weapons = slots
		}
		if rel, ok := writeBuildPic(name); ok {
			u.UnitPic = rel
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
	// weapons.json — the full install catalogue, not just the selected
	// units' weapons: a subset pack must still resolve any weapon id a
	// recording mentions.  Skipped entirely when the install defines no
	// weapon TDFs (TA:Kingdoms inlines weapons in the FBIs instead).
	weaponsFile := ""
	if catalog := sess.buildPackWeaponCatalog(); len(catalog) > 0 {
		body, err := packJSONIndent(packWeaponsFileJSON{Weapons: catalog})
		if err != nil {
			return nil, fmt.Errorf("encode weapons: %w", err)
		}
		if err := pw.write("weapons.json", body); err != nil {
			return nil, err
		}
		weaponsFile = "weapons.json"
		// Catalogue-referenced presentation assets (format v4).  A replay can
		// name ANY weapon id, not just the selected units' slots, so the
		// projectile 3DO meshes (missiles, bombs, the dgun ball), fire/impact
		// sounds, and rendertype=4 sprite strips are packed for the whole
		// catalogue.  Sorted ids keep the walk deterministic.
		ids := make([]string, 0, len(catalog))
		for id := range catalog {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			w := catalog[id]
			if w.Model != "" {
				if ce, ok := sess.resolveModelEntry(w.Model); ok {
					writeModel(ce)
				}
			}
			writeSound(w.SoundStart)
			writeSound(w.SoundHit)
			if w.RenderType == 4 {
				if body, err := sess.buildWeaponBitmapJSON(w.ID); err == nil {
					if werr := pw.write("weaponbitmaps/"+packStem(w.ID)+".json", body); werr != nil {
						warnf("write weapon bitmap %s: %v", w.ID, werr)
					}
				}
			}
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

	// features.json — the full install feature catalogue (format v5): map
	// placements name features by id, so the catalogue must resolve any of
	// them regardless of which maps this pack carries.  Skipped when the
	// install defines none.
	featuresFile := ""
	featureCatalog, featureGafRefs := sess.buildPackFeatureCatalog()
	if len(featureCatalog) > 0 {
		// Extract flat ground features' real sprite art (metal deposits,
		// steam vents, scars…) to featuresprites/<id>.png so the renderer
		// paints the authored art onto the terrain rather than faking it;
		// stamps each entry's Sprite path before features.json is written.
		sess.packFeatureSprites(featureCatalog, featureGafRefs, pw, warnf)
		body, err := packJSONIndent(packFeaturesFileJSON{Features: featureCatalog})
		if err != nil {
			return nil, fmt.Errorf("encode features: %w", err)
		}
		if err := pw.write("features.json", body); err != nil {
			return nil, err
		}
		featuresFile = "features.json"
	}

	// ── Maps ──
	mapsPacked, mapFeatureNames, err := buildPackMaps(sess, pw, opts.Maps, warnf)
	if err != nil {
		return nil, err
	}
	res.Maps = mapsPacked
	// Feature 3DO models referenced by the packed maps (wrecks, dragon
	// teeth, other object= features) so a map's real-model features render
	// from the pack alone.  Sorted for a deterministic walk.
	sort.Strings(mapFeatureNames)
	for _, fname := range mapFeatureNames {
		f, ok := featureCatalog[fname]
		if !ok || f.Object == "" {
			continue
		}
		if ce, ok := sess.resolveModelEntry(f.Object); ok {
			writeModel(ce)
		}
	}

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
		// the unitdb cobBin field).  FormatVersion 3 added unitpics/<name>.png
		// build pictures (unitdb unitPic field), the weapons.json render
		// catalogue (manifest weapons field) and the unitdb per-unit
		// slot-ordered weapons array.  FormatVersion 4 split model geometry
		// into base (models/) + enhanced (models-enhanced/) variants,
		// extended weapons.json with the trajectory/muzzle/impact fields a
		// renderer needs (ballistic, smokeTrail, startSmoke, commandFire,
		// areaOfEffectWU, rangeWU, raw colour indices, sound stems), and
		// packed the whole weapon catalogue's projectile meshes, sounds and
		// bitmap sprite strips.  FormatVersion 5 added the features.json map-
		// feature catalogue (manifest features field), packed the 3DO models
		// of map-referenced object features, and extended weapons.json with
		// the guided-flight fields (turnRate, waterWeapon, accelerationWU,
		// flightTimeSec).  FormatVersion 6 packs the real first-frame GAF
		// sprite (with alpha) of every FLAT ground feature — metal deposits,
		// steam vents, scars, tracks, craters, holes — to
		// featuresprites/<id>.png (features.json sprite field) so the
		// renderer paints the authored art onto the terrain as a decal
		// instead of a procedural placeholder.  FormatVersion 7 adds
		// per-player texture pages: model JSON gains teamTextures[] and each
		// team-page texture packs its colour frames as
		// textures/<name>[--side]--tN.png alongside the frame-0 base.
		// FormatVersion 8 adds the per-weapon effectClass (+ TA:K takType)
		// to weapons.json and, for TA:K installs, builds the catalogue from
		// the inline FBI [WEAPONn] sections — TA:K packs finally ship a
		// weapons.json (and the arrow/bolt projectile meshes it names).
		// Older readers ignore all of them.
		FormatVersion: 8,
		Game:          db.Game,
		Sides:         sides,
		Palette:       "palette.json",
		UnitDB:        "unitdb.json",
		UnitCount:     len(dbUnits),
		GameUnitCount: len(allUnits),
		Units:         selected,
		Maps:          mapsPacked,
		Weapons:       weaponsFile,
		Features:      featuresFile,
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

// buildPackMaps extracts the requested maps ("all" = every maps/*.tnt).  The
// second return lists every feature id the packed maps place (lower-case,
// de-duplicated, unsorted) so the caller can pack object-feature models.
func buildPackMaps(sess *Session, pw *packWriter, requested []string, warnf func(string, ...any)) ([]string, []string, error) {
	if len(requested) == 0 {
		return nil, nil, nil
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
				return nil, nil, fmt.Errorf("unknown map %q (no maps/%s.tnt in this install)", n, n)
			}
			names = append(names, n)
		}
	}
	sort.Strings(names)

	var packed []string
	featureSeen := map[string]bool{}
	var featureNames []string
	for _, name := range names {
		mapPath := tntByName[name]
		placed, err := writePackMap(sess, pw, name, mapPath)
		if err != nil {
			warnf("map %s: %v", name, err)
			continue
		}
		packed = append(packed, name)
		for _, fname := range placed {
			if !featureSeen[fname] {
				featureSeen[fname] = true
				featureNames = append(featureNames, fname)
			}
		}
	}
	return packed, featureNames, nil
}

// writePackMap emits maps/<name>.json plus its tile-pool atlas + minimap
// PNGs — the same data /api/studio/load and /api/studio/tile-pool serve.
// Returns the lower-case feature ids the map places (with duplicates) so the
// caller can pack their object models.
func writePackMap(sess *Session, pw *packWriter, name, mapPath string) ([]string, error) {
	data, err := sess.vfs.ReadFile(mapPath)
	if err != nil {
		return nil, err
	}
	reader := bytes.NewReader(data)
	m, err := tnt.LoadFromReader(reader)
	if err != nil {
		return nil, fmt.Errorf("parse TNT: %w", err)
	}
	if m.IsTAK {
		return writeTAKPackMap(sess, pw, name, mapPath, m, reader)
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
	placedNames := make([]string, 0, len(placements))
	for _, p := range placements {
		if p.FeatureIdx < 0 || p.FeatureIdx >= len(features) {
			continue
		}
		fname := strings.TrimSpace(features[p.FeatureIdx].Name)
		if fname == "" {
			continue
		}
		outFeatures = append(outFeatures, loadedFeature{Name: fname, AX: p.AttrX, AY: p.AttrY})
		placedNames = append(placedNames, strings.ToLower(fname))
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
		return nil, fmt.Errorf("encode tile pool: %w", err)
	}
	if err := pw.write(out.TilePool, atlasBuf.Bytes()); err != nil {
		return nil, err
	}

	if m.Minimap != nil {
		if img := m.RenderMinimap(sess.palettes().TerrainPalette(mapPath)); img != nil {
			var buf bytes.Buffer
			if err := png.Encode(&buf, img); err == nil {
				out.Minimap = "maps/" + stem + ".minimap.png"
				if err := pw.write(out.Minimap, buf.Bytes()); err != nil {
					return nil, err
				}
			}
		}
	}

	body, err := packJSON(out)
	if err != nil {
		return nil, fmt.Errorf("encode map json: %w", err)
	}
	if err := pw.write("maps/"+stem+".json", body); err != nil {
		return nil, err
	}
	return placedNames, nil
}

// writeTAKPackMap emits a TA:Kingdoms texture-mapped map in the same pack
// shape as a TA map (maps/<name>.json + .tiles.png + .minimap.png) so the
// browser's loadMapTerrain re-composites its ground identically.
//
// TA:K terrain is not a stamped tile mosaic: each 32px Graphic Unit indexes a
// terrain JPG at a (u,v) offset. buildTAKPackTerrain deduplicates those into a
// tile atlas + per-cell tile map, giving TileW=GUW, TileH=GUH and the same
// {sx,sy}-into-atlas placements the TA path produces. Heights and voids are the
// DataUnit-resolution grid (TAKW×TAKH = 2·GUW × 2·GUH), which the loader reads
// as tileW*2 × tileH*2 — exactly what a TA map reports. Returns the lower-case
// feature ids the map places so the caller can pack their object models.
func writeTAKPackMap(sess *Session, pw *packWriter, name, mapPath string, m *tnt.Map, reader *bytes.Reader) ([]string, error) {
	if m.TAKTerrainNames == nil || m.TAKGUW == 0 {
		return nil, fmt.Errorf("TA:K map has no terrain-name table")
	}
	features, _ := m.LoadFeatures(reader)
	placements := m.GetFeaturePlacements()

	terrain := buildTAKPackTerrain(m, sess.takTerrainProvider())

	// Heights + voids at DataUnit resolution (TAKW×TAKH). TA:K carries no TA
	// void sentinel, so voids stay zero — impassable water is derived from the
	// heightmap + sea level by the renderer, as in the studio load path.
	heights := make([]int, len(m.TAKHeight))
	for i, h := range m.TAKHeight {
		heights[i] = int(h)
	}
	voids := make([]int, len(m.TAKHeight))

	outFeatures := make([]loadedFeature, 0, len(placements))
	placedNames := make([]string, 0, len(placements))
	for _, p := range placements {
		if p.FeatureIdx < 0 || p.FeatureIdx >= len(features) {
			continue
		}
		fname := strings.TrimSpace(features[p.FeatureIdx].Name)
		if fname == "" {
			continue
		}
		outFeatures = append(outFeatures, loadedFeature{Name: fname, AX: p.AttrX, AY: p.AttrY})
		placedNames = append(placedNames, strings.ToLower(fname))
	}

	stem := packStem(name)
	// The TA:K TNT header's SeaLevel word is a repurposed pointer, not a
	// usable sea level (real maps read ~900000). The OTA carries the real
	// value; leave sea level at 0 (surface) until the OTA supplies one.
	out := packMapJSON{
		Name:     name,
		TileW:    m.TAKGUW,
		TileH:    m.TAKGUH,
		SeaLevel: 0,
		Heights:  heights,
		Voids:    voids,
		Tiles:    terrain.TileMap,
		Features: outFeatures,
		TilePool: "maps/" + stem + ".tiles.png",
	}
	if otaData, err := sess.vfs.ReadFile(strings.TrimSuffix(mapPath, path.Ext(mapPath)) + ".ota"); err == nil {
		out.OTA = parseOTA(string(otaData), m.TAKGUW, m.TAKGUH)
		if out.OTA != nil && out.OTA.SeaLevel > 0 {
			out.SeaLevel = out.OTA.SeaLevel
		}
	}

	var atlasBuf bytes.Buffer
	if err := png.Encode(&atlasBuf, terrain.Atlas); err != nil {
		return nil, fmt.Errorf("encode TA:K tile pool: %w", err)
	}
	if err := pw.write(out.TilePool, atlasBuf.Bytes()); err != nil {
		return nil, err
	}

	if m.Minimap != nil {
		if img := m.RenderMinimap(sess.palettes().TerrainPalette(mapPath)); img != nil {
			var buf bytes.Buffer
			if err := png.Encode(&buf, img); err == nil {
				out.Minimap = "maps/" + stem + ".minimap.png"
				if err := pw.write(out.Minimap, buf.Bytes()); err != nil {
					return nil, err
				}
			}
		}
	}

	body, err := packJSON(out)
	if err != nil {
		return nil, fmt.Errorf("encode TA:K map json: %w", err)
	}
	if err := pw.write("maps/"+stem+".json", body); err != nil {
		return nil, err
	}
	return placedNames, nil
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
@coreprime/kbot-game3d's HttpPackProvider at its base URL; the renderer needs no
other server.

Files:

- manifest.json — game id, sides, unit list and the pack contentHash
  (sha256 over every other file in sorted path order; the pack identity).
- unitdb.json — per-unit definitions: pack ordinal id, movement class +
  motion domain, build picture + slot-ordered weapon ids, and full
  FBI/TDF-derived stats (buildTime, maxDamage, weapons, economy,
  footprint, sounds, corpse chain).
- weapons.json — every weapon definition in the install keyed by
  lower-case id: render type, palette-resolved beam colours (plus the
  raw colour indices), projectile model, velocity, beam duration,
  trajectory flags (ballistic, smokeTrail, startSmoke, commandFire),
  blast diameter, range and fire/impact sound stems.  Each unitdb
  entry's "weapons" array maps its fire slots onto these keys; every
  catalogue-referenced projectile mesh, sound and bitmap sprite strip
  is packed alongside.
- features.json — every map-feature definition in the install keyed by
  lower-case id: category, footprint, height, the 3DO object name for
  model features (wrecks, dragon teeth — the maps' referenced objects
  are packed under models/), and the GAF sprite's first-frame pixel
  size + hotspot for sprite features, and the "sprite" path to the packed
  real GAF art for flat ground features.  Map placements resolve here.
- palette.json — {"palette": [[r,g,b] x 256]}.
- unitpics/<name>.png — unit build pictures, decoded from the install's
  PCX/JPEG originals at native size.
- models/<name>.json — preprocessed model geometry (authored faces) in
  the @coreprime/kbot-game3d ModelLoader shape.
- models-enhanced/<name>.json — the same geometry with the faces TA's
  artists deleted reconstructed (the studio's Enhanced Mesh toggle);
  clients request it via model(name, {enhanceMesh:true}).
- textures/<name>.png — model textures ("<name>--<side>.png" for
  per-side variants; team-page textures add "--t<N>.png" per player
  colour, frame 0 staying the base file).
- cob/<name>.json — disassembled COB animation scripts (debug/viewer form).
- cob/<name>.cob — raw COB bytecode, byte-identical to the install's
  scripts/<name>.cob; the runnable form the engine's script VM loads so
  units animate (walk cycles, turrets, build poses).
- sounds/<stem>.wav — unit + weapon sound effects.
- weaponbitmaps/<weapon>.json — sprite-strip metadata for bitmap
  (rendertype=4) projectiles.
- cursors/<sequence>.png — cursor glyphs (APNG when animated).
- groundtiles/<tileset>.png — seamless 32x32 flat-terrain tiles.
- featuresprites/<id>.png — the first-frame GAF art (with alpha) of flat
  ground features (metal deposits, steam vents, scars, tracks, craters,
  holes); the renderer paints it onto the terrain as a decal.
- maps/<name>.json (+ .tiles.png / .minimap.png) — map heights, voids,
  tile placements, features and rendered atlases.

All filenames are lower-case with characters outside [a-z0-9._-]
replaced by "_"; clients apply the same mapping before fetching.
`
