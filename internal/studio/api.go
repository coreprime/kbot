package studio

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/assets"
)

func registerAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/studio/heartbeat", handleHeartbeat)
	mux.HandleFunc("/api/studio/feature-origins", handleFeatureOrigins)
	mux.HandleFunc("/api/studio/defaults", handleDefaults)
	mux.HandleFunc("/api/studio/maps", handleMapsList)
	mux.HandleFunc("/api/studio/minimap/", handleMapMinimap)
	mux.HandleFunc("/api/studio/load", handleMapLoad)
	mux.HandleFunc("/api/studio/tile-pool/", handleMapTilePool)
	mux.HandleFunc("/api/studio/sections", handleSections)
	mux.HandleFunc("/api/studio/section-preview/", handleSectionPreview)
	mux.HandleFunc("/api/studio/section-image/", handleSectionImage)
	mux.HandleFunc("/api/studio/section-heights/", handleSectionHeights)
	mux.HandleFunc("/api/studio/features", handleFeatures)
	mux.HandleFunc("/api/studio/feature-preview/", handleFeaturePreview)
	mux.HandleFunc("/api/studio/save", handleSave)
	mux.HandleFunc("/api/studio/save-loose", handleSaveLoose)
}

// ── /api/studio/heartbeat ──────────────────────────────────────────────────

// handleHeartbeat is a cheap liveness probe the browser pings every few
// seconds; a 200 response tells the client the kbot studio CLI is
// still serving.  When the CLI is killed (or crashes) the client gets
// a network error and surfaces the disconnect overlay.
func handleHeartbeat(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true}`))
}

// ── /api/studio/defaults ───────────────────────────────────────────────────

// handleDefaults returns the default map dimensions used when the user opens
// the editor.  Metal Heck is 131×131 tiles; we round to 128×128 — a friendly
// power-of-two that gives the player a similarly-sized canvas.
func handleDefaults(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{
		"defaultTileW": 128,
		"defaultTileH": 128,
		"minTileW":     16,
		"minTileH":     16,
		"maxTileW":     256,
		"maxTileH":     256,
	})
}

// ── /api/studio/maps ───────────────────────────────────────────────────────

type mapEntry struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	TileW       int    `json:"tileW"`
	TileH       int    `json:"tileH"`
	MissionName string `json:"missionName,omitempty"`
	Planet      string `json:"planet,omitempty"`
	NumPlayers  string `json:"numPlayers,omitempty"`
	MinimapURL  string `json:"minimapUrl,omitempty"`
}

// mapCatalog holds the preloaded list of .tnt maps and their rendered
// minimap PNGs.  The studio CLI populates this in a goroutine at server
// start so the Open dialog doesn't need to parse every TNT on first open.
type mapCatalogState struct {
	mu       sync.RWMutex
	ready    bool
	entries  []mapEntry
	minimaps map[string][]byte // path -> PNG bytes
}

var mapCatalog = &mapCatalogState{minimaps: map[string][]byte{}}

// sectionPreviewCache memoises rendered section-preview PNGs so the
// drawer's per-section thumbnails don't re-parse the SCT on every
// request.  Populated lazily and by the startup preload goroutine.
var (
	sectionPreviewMu    sync.RWMutex
	sectionPreviewCache = map[string][]byte{}
)

// preloadProgress is a tiny progress tracker the TTY renderer reads.
// All counters are guarded by mu so the renderer's snapshot stays
// internally consistent (no torn reads across phase/done/total).
type preloadTracker struct {
	mu       sync.Mutex
	phase    string
	done     int
	total    int
	finished bool
}

var preloadProgress = &preloadTracker{}

func (p *preloadTracker) set(phase string, done, total int) {
	p.mu.Lock()
	p.phase = phase
	p.done = done
	p.total = total
	p.mu.Unlock()
}

func (p *preloadTracker) snapshot() (string, int, int, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.phase, p.done, p.total, p.finished
}

func (p *preloadTracker) finish() {
	p.mu.Lock()
	p.finished = true
	p.mu.Unlock()
}

// startAssetPreload walks every map, section, and feature in the VFS
// and pre-renders the PNGs the studio web UI needs.  Runs in a single
// background goroutine after the server boots; the TTY progress bar
// (when stdout is a terminal) follows the preloadProgress counters.
func startAssetPreload() {
	pal := loadVFSPalette()
	paths := vfs.List()

	// ── Maps ──
	var tntPaths []string
	for _, p := range paths {
		lower := strings.ToLower(p)
		if strings.HasPrefix(lower, "maps/") && strings.HasSuffix(lower, ".tnt") {
			tntPaths = append(tntPaths, p)
		}
	}
	preloadProgress.set("maps", 0, len(tntPaths))
	for i, p := range tntPaths {
		entry, mini := summariseMapWithMinimap(p, pal)
		mapCatalog.mu.Lock()
		mapCatalog.entries = append(mapCatalog.entries, entry)
		if mini != nil {
			mapCatalog.minimaps[p] = mini
		}
		mapCatalog.mu.Unlock()
		preloadProgress.set("maps", i+1, len(tntPaths))
	}
	mapCatalog.mu.Lock()
	sort.Slice(mapCatalog.entries, func(i, j int) bool {
		return strings.ToLower(mapCatalog.entries[i].Name) < strings.ToLower(mapCatalog.entries[j].Name)
	})
	mapCatalog.ready = true
	mapCatalog.mu.Unlock()

	// ── Sections ──
	sections := allSectionsFromVFS()
	preloadProgress.set("sections", 0, len(sections))
	for i, s := range sections {
		bytes := renderSectionPreviewPNG(s.Path, pal)
		if bytes != nil {
			sectionPreviewMu.Lock()
			sectionPreviewCache[s.Path] = bytes
			sectionPreviewMu.Unlock()
		}
		preloadProgress.set("sections", i+1, len(sections))
	}

	// ── Feature thumbnails ──
	features, _ := scanFeatures()
	withFile := features[:0:0]
	for _, f := range features {
		if f.Filename != "" && f.Seqname != "" {
			withFile = append(withFile, f)
		}
	}
	preloadProgress.set("features", 0, len(withFile))
	for i, f := range withFile {
		// Static-only PNG ?static=1 — the canvas placement path uses
		// these.  Animated APNGs render on-demand still.
		if data, err := renderFeatureStaticPNG(f.Filename, f.Seqname); err == nil {
			key := strings.ToLower(f.Name) + "|static"
			featureCacheMu.Lock()
			featureCache[key] = data
			featureCacheMu.Unlock()
		}
		preloadProgress.set("features", i+1, len(withFile))
	}

	preloadProgress.finish()
}

// renderSectionPreviewPNG renders the same PNG handleSectionPreview
// would serve, so the preload goroutine and the live handler agree
// on bytes.
func renderSectionPreviewPNG(sectionPath string, pal color.Palette) []byte {
	data, err := vfs.ReadFile(sectionPath)
	if err != nil {
		return nil
	}
	section, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	var img image.Image
	if section.Minimap != nil {
		img = section.RenderMinimap(pal)
	} else {
		img = section.RenderTileMap(pal)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

// allSectionsFromVFS lists all .sct paths under sections/.  Mirrors
// what handleSections does, kept local so the preload doesn't depend
// on the JSON-serialising path.
func allSectionsFromVFS() []sectionEntry {
	var out []sectionEntry
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "sections/") || !strings.HasSuffix(lower, ".sct") {
			continue
		}
		out = append(out, sectionEntry{Path: p})
	}
	return out
}

func handleMapsList(w http.ResponseWriter, _ *http.Request) {
	mapCatalog.mu.RLock()
	ready := mapCatalog.ready
	entries := make([]mapEntry, len(mapCatalog.entries))
	copy(entries, mapCatalog.entries)
	mapCatalog.mu.RUnlock()
	if ready {
		writeJSON(w, map[string]any{"maps": entries, "loading": false})
		return
	}
	// Still preloading — return whatever's been resolved so far plus a
	// loading flag.  The client polls until loading flips to false.
	sort.Slice(entries, func(i, j int) bool {
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	writeJSON(w, map[string]any{"maps": entries, "loading": true})
}

// summariseMapWithMinimap is summariseMap plus the rendered minimap PNG
// so the preload goroutine can populate both caches in one TNT parse.
func summariseMapWithMinimap(p string, pal color.Palette) (mapEntry, []byte) {
	entry := mapEntry{Path: p, Name: strings.TrimSuffix(path.Base(p), path.Ext(p))}
	var pngBytes []byte
	if data, err := vfs.ReadFile(p); err == nil {
		if m, err := tnt.LoadFromReader(bytes.NewReader(data)); err == nil {
			entry.TileW = m.TileW
			entry.TileH = m.TileH
			if m.Minimap != nil {
				entry.MinimapURL = "/api/studio/minimap/" + p
				if img := m.RenderMinimap(pal); img != nil {
					var buf bytes.Buffer
					if err := png.Encode(&buf, img); err == nil {
						pngBytes = buf.Bytes()
					}
				}
			}
		}
	}
	otaPath := strings.TrimSuffix(p, path.Ext(p)) + ".ota"
	if data, err := vfs.ReadFile(otaPath); err == nil {
		if doc, err := tdf.ParseString(string(data)); err == nil {
			if gh := doc.Section("GlobalHeader"); gh != nil {
				entry.MissionName = gh.String("missionname")
				entry.Planet = gh.String("planet")
				entry.NumPlayers = gh.String("numplayers")
			}
		}
	}
	return entry, pngBytes
}

// handleMapMinimap streams the embedded TNT minimap as a PNG so the
// open-map dialog can show a thumbnail per map.  The preload goroutine
// usually has the PNG ready; the live fallback covers requests that
// race ahead of the preload (or maps that weren't picked up by it).
func handleMapMinimap(w http.ResponseWriter, r *http.Request) {
	mapPath := strings.TrimPrefix(r.URL.Path, "/api/studio/minimap/")
	if mapPath == "" {
		http.Error(w, "missing map path", http.StatusBadRequest)
		return
	}
	mapCatalog.mu.RLock()
	cached := mapCatalog.minimaps[mapPath]
	mapCatalog.mu.RUnlock()
	if cached != nil {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	data, err := vfs.ReadFile(mapPath)
	if err != nil {
		http.Error(w, "map not found", http.StatusNotFound)
		return
	}
	m, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil || m.Minimap == nil {
		http.Error(w, "no minimap available", http.StatusNotFound)
		return
	}
	img := m.RenderMinimap(loadVFSPalette())
	if img == nil {
		http.Error(w, "render failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_ = png.Encode(w, img)
}

// ── /api/studio/load + tile-pool ───────────────────────────────────────────
//
// "Open existing map" reuses the editor's draw/save pipeline by treating
// the TNT's flattened tile pool like a synthetic section: each cell of
// the loaded map points to a (sx, sy) inside that pool, and the
// rendering layer fetches the pool image via /tile-pool/<path>.  We
// cache the parsed *tnt.Map in tntCache so the save path can resolve
// the original pixel bytes without re-reading the file.

const tntCacheCap = 16

var (
	tntCacheMu    sync.Mutex
	tntCache      = map[string]*tnt.Map{}
	tntCacheOrder []string // LRU recency, most-recent last
)

func cacheTNT(mapPath string, m *tnt.Map) {
	tntCacheMu.Lock()
	defer tntCacheMu.Unlock()
	if _, ok := tntCache[mapPath]; ok {
		tntCacheTouchLocked(mapPath)
	} else {
		tntCacheOrder = append(tntCacheOrder, mapPath)
	}
	tntCache[mapPath] = m
	for len(tntCacheOrder) > tntCacheCap {
		evict := tntCacheOrder[0]
		tntCacheOrder = tntCacheOrder[1:]
		delete(tntCache, evict)
	}
}

func lookupTNT(mapPath string) *tnt.Map {
	tntCacheMu.Lock()
	defer tntCacheMu.Unlock()
	m, ok := tntCache[mapPath]
	if !ok {
		return nil
	}
	tntCacheTouchLocked(mapPath)
	return m
}

func tntCacheTouchLocked(mapPath string) {
	for i, p := range tntCacheOrder {
		if p == mapPath {
			tntCacheOrder = append(tntCacheOrder[:i], tntCacheOrder[i+1:]...)
			tntCacheOrder = append(tntCacheOrder, mapPath)
			return
		}
	}
}

// tilePoolCols picks a square-ish layout for the tile-pool atlas.  An
// exact grid avoids any rounding ambiguity between the JSON tile coords
// and the served PNG.
func tilePoolCols(numTiles int) int {
	if numTiles <= 0 {
		return 1
	}
	cols := 1
	for cols*cols < numTiles {
		cols++
	}
	return cols
}

type loadedTile struct {
	SX int `json:"sx"`
	SY int `json:"sy"`
}

type loadedFeature struct {
	Name string `json:"name"`
	AX   int    `json:"ax"`
	AY   int    `json:"ay"`
}

type loadResponse struct {
	Name        string          `json:"name"`
	Path        string          `json:"path"`
	TileW       int             `json:"tileW"`
	TileH       int             `json:"tileH"`
	Planet      string          `json:"planet"`
	MissionName string          `json:"missionName"`
	TilePoolURL string          `json:"tilePoolUrl"`
	TilePoolKey string          `json:"tilePoolKey"`
	Tiles       []loadedTile    `json:"tiles"`
	Heights     []int           `json:"heights"`
	Voids       []int           `json:"voids"`
	Features    []loadedFeature `json:"features"`
	OTA         *otaState       `json:"ota"`
}

// handleMapLoad parses a TNT (and its sibling OTA when present) and
// returns the data the editor needs to populate state: tile pool
// coordinates per cell, heightmap, feature placements, and the full
// OTA struct.  The browser then fetches the tile pool atlas through
// /api/studio/tile-pool/<path>.
func handleMapLoad(w http.ResponseWriter, r *http.Request) {
	mapPath := r.URL.Query().Get("path")
	if mapPath == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	data, err := vfs.ReadFile(mapPath)
	if err != nil {
		http.Error(w, "map not found: "+err.Error(), http.StatusNotFound)
		return
	}
	reader := bytes.NewReader(data)
	m, err := tnt.LoadFromReader(reader)
	if err != nil {
		http.Error(w, "parse TNT: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// Pull feature placements + their name table; needed for the
	// editor's features pane.  Errors are non-fatal — a TNT without
	// features still loads.
	features, _ := m.LoadFeatures(reader)
	placements := m.GetFeaturePlacements()

	cacheTNT(mapPath, m)

	poolCols := tilePoolCols(len(m.Tiles))

	// Per-cell tile pool coords.  TileMap[i] indexes into m.Tiles.
	tiles := make([]loadedTile, len(m.TileMap))
	for i, idx := range m.TileMap {
		px := int(idx) % poolCols
		py := int(idx) / poolCols
		tiles[i] = loadedTile{SX: px, SY: py}
	}

	// Heights from TileAttr — one byte per 16-px attribute cell.
	// Voids are encoded in the same TileAttr.Feature field via the
	// sentinel values 0xFFFC / 0xFFFE (different TA releases use
	// different markers); 0xFFFF means "no feature, passable".
	heights := make([]int, len(m.TileAttr))
	voids := make([]int, len(m.TileAttr))
	for i, a := range m.TileAttr {
		heights[i] = int(a.Height)
		if a.Feature == 0xFFFC || a.Feature == 0xFFFE {
			voids[i] = 1
		}
	}

	// Resolve feature placements to (name, ax, ay).
	outFeatures := make([]loadedFeature, 0, len(placements))
	for _, p := range placements {
		if p.FeatureIdx < 0 || p.FeatureIdx >= len(features) {
			continue
		}
		name := strings.TrimSpace(features[p.FeatureIdx].Name)
		if name == "" {
			continue
		}
		outFeatures = append(outFeatures, loadedFeature{
			Name: name,
			AX:   p.AttrX,
			AY:   p.AttrY,
		})
	}

	// OTA — best-effort.  A blank OTA still leaves the editor usable.
	baseName := strings.TrimSuffix(path.Base(mapPath), path.Ext(mapPath))
	otaPath := strings.TrimSuffix(mapPath, path.Ext(mapPath)) + ".ota"
	planet := ""
	missionName := baseName
	var ota *otaState
	if data, err := vfs.ReadFile(otaPath); err == nil {
		ota = parseOTA(string(data), m.TileW, m.TileH)
		if ota != nil {
			if ota.Planet != "" {
				planet = ota.Planet
			}
			if ota.MissionName != "" {
				missionName = ota.MissionName
			}
			if ota.SeaLevel == 0 && m.Header.SeaLevel > 0 {
				ota.SeaLevel = int(m.Header.SeaLevel)
			}
		}
	}

	resp := loadResponse{
		Name:        baseName,
		Path:        mapPath,
		TileW:       m.TileW,
		TileH:       m.TileH,
		Planet:      planet,
		MissionName: missionName,
		TilePoolURL: "/api/studio/tile-pool/" + url.PathEscape(mapPath),
		TilePoolKey: "tnt:" + mapPath,
		Tiles:       tiles,
		Heights:     heights,
		Voids:       voids,
		Features:    outFeatures,
		OTA:         ota,
	}
	writeJSON(w, resp)
}

// handleMapTilePool renders the TNT's full tile pool as a PNG atlas —
// each 32×32 tile sits at (sx*32, sy*32) where sx/sy match what
// handleMapLoad reported in `tiles[i]`.
func handleMapTilePool(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/tile-pool/")
	mapPath, err := url.PathUnescape(raw)
	if err != nil || mapPath == "" {
		http.Error(w, "bad map path", http.StatusBadRequest)
		return
	}
	m := lookupTNT(mapPath)
	if m == nil {
		// Cache miss (process restart, direct URL hit before /load) —
		// re-parse the file on the fly so the endpoint stays usable.
		data, err := vfs.ReadFile(mapPath)
		if err != nil {
			http.Error(w, "map not found", http.StatusNotFound)
			return
		}
		m, err = tnt.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			http.Error(w, "parse TNT: "+err.Error(), http.StatusInternalServerError)
			return
		}
		cacheTNT(mapPath, m)
	}
	pal := loadVFSPalette()
	cols := tilePoolCols(len(m.Tiles))
	rows := (len(m.Tiles) + cols - 1) / cols
	if rows < 1 {
		rows = 1
	}
	img := image.NewRGBA(image.Rect(0, 0, cols*32, rows*32))
	for i, tile := range m.Tiles {
		px := (i % cols) * 32
		py := (i / cols) * 32
		for y := 0; y < 32; y++ {
			for x := 0; x < 32; x++ {
				idx := tile[y*32+x]
				img.Set(px+x, py+y, pal[idx])
			}
		}
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_ = png.Encode(w, img)
}

// parseOTA walks the [GlobalHeader] block (and its nested Schema /
// specials sub-sections) into the editor's otaState shape.  Returns
// nil when the file is empty or unparseable.
func parseOTA(content string, tileW, tileH int) *otaState {
	doc, err := tdf.ParseString(content)
	if err != nil {
		return nil
	}
	gh := doc.Section("GlobalHeader")
	if gh == nil {
		return nil
	}
	out := &otaState{
		MissionName:        gh.String("missionname"),
		MissionDescription: gh.String("missiondescription"),
		MissionHint:        gh.String("missionhint"),
		Brief:              gh.String("brief"),
		Narration:          gh.String("narration"),
		Glamour:            gh.String("glamour"),
		Planet:             gh.String("planet"),
		NumPlayers:         gh.String("numplayers"),
		Size:               gh.String("size"),
		Memory:             gh.String("memory"),
		LineOfSight:        gh.Int("lineofsight"),
		Mapping:            gh.Int("mapping"),
		TidalStrength:      gh.Int("tidalstrength"),
		SolarStrength:      gh.Int("solarstrength"),
		LavaWorld:          gh.Int("lavaworld"),
		Killmul:            gh.Int("killmul"),
		Timemul:            gh.Int("timemul"),
		MinWindSpeed:       gh.Int("minwindspeed"),
		MaxWindSpeed:       gh.Int("maxwindspeed"),
		Gravity:            gh.Int("gravity"),
		SeaLevel:           gh.Int("sealevel"),
		ImpassibleWater:    gh.Int("impassiblewater"),
		WaterDoesDamage:    gh.Int("waterdoesdamage"),
	}
	for _, sec := range gh.Sections() {
		if !strings.HasPrefix(strings.ToLower(sec.Name()), "schema") {
			continue
		}
		schema := otaSchema{
			Name:           strings.TrimPrefix(sec.Name(), "Schema "),
			Type:           sec.String("type"),
			AIProfile:      sec.String("aiprofile"),
			SurfaceMetal:   sec.Int("surfacemetal"),
			MohoMetal:      sec.Int("mohometal"),
			HumanMetal:     sec.Int("humanmetal"),
			ComputerMetal:  sec.Int("computermetal"),
			HumanEnergy:    sec.Int("humanenergy"),
			ComputerEnergy: sec.Int("computerenergy"),
			MeteorWeapon:   sec.String("meteorweapon"),
			MeteorRadius:   sec.Int("meteorradius"),
			MeteorDensity:  sec.Int("meteordensity"),
			MeteorDuration: sec.Int("meteorduration"),
			MeteorInterval: sec.Int("meteorinterval"),
		}
		if schema.Name == "" {
			schema.Name = sec.Name()
		}
		for _, child := range sec.Sections() {
			if !strings.EqualFold(child.Name(), "specials") {
				continue
			}
			for _, sp := range child.Sections() {
				what := sp.String("specialwhat")
				if !strings.HasPrefix(strings.ToLower(what), "startpos") {
					continue
				}
				num := 0
				_, _ = fmt.Sscanf(strings.ToLower(what), "startpos%d", &num)
				if num <= 0 {
					continue
				}
				schema.StartPos = append(schema.StartPos, saveStartPos{
					Number: num,
					X:      sp.Int("xpos"),
					Z:      sp.Int("zpos"),
				})
			}
		}
		if len(schema.StartPos) == 0 {
			schema.StartPos = defaultStartPositions(tileW, tileH)
		}
		out.Schemas = append(out.Schemas, schema)
	}
	if len(out.Schemas) == 0 {
		out.Schemas = []otaSchema{{
			Name:           "Default",
			Type:           "Network 1",
			AIProfile:      "DEFAULT",
			SurfaceMetal:   3,
			MohoMetal:      30,
			HumanMetal:     1000,
			ComputerMetal:  1000,
			HumanEnergy:    1000,
			ComputerEnergy: 1000,
			StartPos:       defaultStartPositions(tileW, tileH),
		}}
	}
	return out
}

// ── /api/studio/sections ───────────────────────────────────────────────────

type sectionEntry struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Group   string `json:"group"`
	World   string `json:"world"`
	TileW   int    `json:"tileW"`
	TileH   int    `json:"tileH"`
	HasMini bool   `json:"hasMinimap"`
}

func handleSections(w http.ResponseWriter, _ *http.Request) {
	var entries []sectionEntry
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "sections/") || !strings.HasSuffix(lower, ".sct") {
			continue
		}
		entries = append(entries, summariseSection(p))
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].World != entries[j].World {
			return entries[i].World < entries[j].World
		}
		if entries[i].Group != entries[j].Group {
			return entries[i].Group < entries[j].Group
		}
		return entries[i].Name < entries[j].Name
	})
	writeJSON(w, map[string]any{"sections": entries})
}

func summariseSection(p string) sectionEntry {
	parts := strings.Split(p, "/")
	world, group := "", ""
	if len(parts) >= 2 {
		world = parts[1]
	}
	if len(parts) >= 3 {
		group = parts[len(parts)-2]
	}
	entry := sectionEntry{
		Path:  p,
		Name:  strings.TrimSuffix(path.Base(p), path.Ext(p)),
		Group: group,
		World: world,
	}
	if data, err := vfs.ReadFile(p); err == nil {
		if s, err := sct.LoadFromReader(bytes.NewReader(data)); err == nil {
			entry.TileW = int(s.Header.Width)
			entry.TileH = int(s.Header.Height)
			entry.HasMini = s.Minimap != nil
		}
	}
	return entry
}

// ── /api/studio/section-preview/<path> ─────────────────────────────────────

// handleSectionPreview returns a PNG for the section: minimap when present,
// otherwise a rendered tile-grid.  Cached in memory — the preload
// goroutine populates the cache up front and live requests fall back
// to a render+cache when the cache misses.
func handleSectionPreview(w http.ResponseWriter, r *http.Request) {
	sectionPath := strings.TrimPrefix(r.URL.Path, "/api/studio/section-preview/")
	if sectionPath == "" {
		http.Error(w, "missing section path", http.StatusBadRequest)
		return
	}
	sectionPreviewMu.RLock()
	cached := sectionPreviewCache[sectionPath]
	sectionPreviewMu.RUnlock()
	if cached != nil {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	pal := loadVFSPalette()
	pngBytes := renderSectionPreviewPNG(sectionPath, pal)
	if pngBytes == nil {
		http.Error(w, "section not found", http.StatusNotFound)
		return
	}
	sectionPreviewMu.Lock()
	sectionPreviewCache[sectionPath] = pngBytes
	sectionPreviewMu.Unlock()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(pngBytes)
}

// ── /api/studio/feature-preview/<name> ─────────────────────────────────────
//
// Returns an animated PNG (APNG) of the named feature, resolved through the
// feature's TDF metadata (filename → anims/<filename>.gaf, seqname → the
// matching sequence inside that file).  Single-frame sequences come back as
// a plain PNG (APNG degrades to PNG gracefully).

var (
	featureCacheMu sync.Mutex
	featureCache   = make(map[string][]byte) // lowercased name → APNG/PNG bytes
	featureCacheBy map[string]featureEntry   // lazy lookup table
)

func handleFeaturePreview(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/feature-preview/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "bad feature name", http.StatusBadRequest)
		return
	}
	staticOnly := r.URL.Query().Get("static") == "1"
	key := strings.ToLower(name)
	if staticOnly {
		key += "|static"
	}

	featureCacheMu.Lock()
	if cached, ok := featureCache[key]; ok {
		featureCacheMu.Unlock()
		w.Header().Set("Content-Type", contentTypeForFeature(staticOnly))
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	if featureCacheBy == nil {
		_, featureCacheBy = scanFeatures()
	}
	entry, ok := featureCacheBy[strings.ToLower(name)]
	featureCacheMu.Unlock()
	if !ok {
		http.Error(w, "feature not found", http.StatusNotFound)
		return
	}
	if entry.Filename == "" {
		http.Error(w, "feature has no animation", http.StatusNotFound)
		return
	}

	var imgBytes []byte
	if staticOnly {
		imgBytes, err = renderFeatureStaticPNG(entry.Filename, entry.Seqname)
	} else {
		imgBytes, err = renderFeatureAPNG(entry.Filename, entry.Seqname)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	featureCacheMu.Lock()
	featureCache[key] = imgBytes
	featureCacheMu.Unlock()

	w.Header().Set("Content-Type", contentTypeForFeature(staticOnly))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(imgBytes)
}

func contentTypeForFeature(staticOnly bool) string {
	if staticOnly {
		return "image/png"
	}
	return "image/apng"
}

// renderFeatureStaticPNG returns a single-frame PNG of the feature's
// first sequence frame.  Used when the studio's "Animate features"
// toggle is off.
func renderFeatureStaticPNG(gafFilename, seqName string) ([]byte, error) {
	gafPath := "anims/" + strings.ToLower(gafFilename) + ".gaf"
	data, err := vfs.ReadFile(gafPath)
	if err != nil {
		return nil, fmt.Errorf("anim file not found: %s", gafPath)
	}
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", gafPath, err)
	}
	defer func() { _ = reader.Close() }()
	sequences, err := reader.ReadSequences()
	if err != nil || len(sequences) == 0 {
		return nil, fmt.Errorf("no sequences in %s", gafPath)
	}
	target := sequences[0]
	for _, s := range sequences {
		if strings.EqualFold(s.Name, seqName) {
			target = s
			break
		}
	}
	if len(target.Frames) == 0 {
		return nil, fmt.Errorf("sequence %s has no frames", target.Name)
	}
	pal, err := gaf.LoadPaletteFromBytes(loadPaletteBytes())
	if err != nil {
		return nil, fmt.Errorf("load palette: %w", err)
	}
	var buf bytes.Buffer
	if err := target.Frames[0].ToPNG(pal, &buf); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// renderFeatureAPNG opens anims/<gafFilename>.gaf, finds the sequence whose
// name matches seqName (case-insensitive), and returns its APNG bytes.  If
// seqName isn't found we fall back to the first sequence so the user at
// least sees something representative.
func renderFeatureAPNG(gafFilename, seqName string) ([]byte, error) {
	gafPath := "anims/" + strings.ToLower(gafFilename) + ".gaf"
	data, err := vfs.ReadFile(gafPath)
	if err != nil {
		return nil, fmt.Errorf("anim file not found: %s", gafPath)
	}
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", gafPath, err)
	}
	defer func() { _ = reader.Close() }()
	sequences, err := reader.ReadSequences()
	if err != nil {
		return nil, fmt.Errorf("read sequences: %w", err)
	}
	if len(sequences) == 0 {
		return nil, fmt.Errorf("no sequences in %s", gafPath)
	}
	target := sequences[0]
	for _, s := range sequences {
		if strings.EqualFold(s.Name, seqName) {
			target = s
			break
		}
	}
	pal, err := gaf.LoadPaletteFromBytes(loadPaletteBytes())
	if err != nil {
		return nil, fmt.Errorf("load palette: %w", err)
	}
	var buf bytes.Buffer
	if err := target.ToAPNG(pal, &buf); err != nil {
		return nil, fmt.Errorf("encode apng: %w", err)
	}
	return buf.Bytes(), nil
}

// loadPaletteBytes returns the raw 1024-byte palette (RGBA × 256).  Prefers
// the VFS copy if available, else falls back to the embedded TA palette.
func loadPaletteBytes() []byte {
	if data, err := vfs.ReadFile("palettes/palette.pal"); err == nil && len(data) >= 1024 {
		return data
	}
	return assets.DefaultPalette
}

// handleSectionHeights returns the section's per-attribute-cell heights
// as JSON so the studio client can populate its heightmap view without
// having to re-parse the SCT in the browser.
func handleSectionHeights(w http.ResponseWriter, r *http.Request) {
	sectionPath := strings.TrimPrefix(r.URL.Path, "/api/studio/section-heights/")
	if sectionPath == "" {
		http.Error(w, "missing section path", http.StatusBadRequest)
		return
	}
	data, err := vfs.ReadFile(sectionPath)
	if err != nil {
		http.Error(w, "section not found", http.StatusNotFound)
		return
	}
	section, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "failed to parse SCT", http.StatusInternalServerError)
		return
	}
	attrW := int(section.Header.Width) * 2
	attrH := int(section.Header.Height) * 2
	// JSON-marshal as []int so the studio client gets a real array;
	// []uint8 would become base64 (Go's []byte default).
	heights := make([]int, attrW*attrH)
	for i := 0; i < len(heights) && i < len(section.HeightMap); i++ {
		heights[i] = int(section.HeightMap[i].Height)
	}
	writeJSON(w, map[string]any{
		"w":       int(section.Header.Width),
		"h":       int(section.Header.Height),
		"attrW":   attrW,
		"attrH":   attrH,
		"heights": heights,
	})
}

// handleSectionImage returns the full tile-grid render (32px per tile) of a
// section.  The studio canvas slices this image to draw stamped sections on
// the map.
func handleSectionImage(w http.ResponseWriter, r *http.Request) {
	sectionPath := strings.TrimPrefix(r.URL.Path, "/api/studio/section-image/")
	if sectionPath == "" {
		http.Error(w, "missing section path", http.StatusBadRequest)
		return
	}
	data, err := vfs.ReadFile(sectionPath)
	if err != nil {
		http.Error(w, "section not found", http.StatusNotFound)
		return
	}
	section, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "failed to parse SCT", http.StatusInternalServerError)
		return
	}
	img := section.RenderTileMap(loadVFSPalette())
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_ = png.Encode(w, img)
}

// ── /api/studio/features ───────────────────────────────────────────────────

type featureEntry struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	World       string `json:"world"`
	FootprintX  int    `json:"footprintX"`
	FootprintZ  int    `json:"footprintZ"`
	Filename    string `json:"filename"`
	Seqname     string `json:"seqname"`
	OriginX     int    `json:"originX"`
	OriginY     int    `json:"originY"`
	PreviewURL  string `json:"previewUrl,omitempty"`
}

func handleFeatures(w http.ResponseWriter, _ *http.Request) {
	features, _ := scanFeatures()
	sorted := make([]featureEntry, len(features))
	copy(sorted, features)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].World != sorted[j].World {
			return sorted[i].World < sorted[j].World
		}
		if sorted[i].Category != sorted[j].Category {
			return sorted[i].Category < sorted[j].Category
		}
		return strings.ToLower(sorted[i].Name) < strings.ToLower(sorted[j].Name)
	})
	writeJSON(w, map[string]any{"features": sorted})
}

// scanFeaturesCache memoises the (slow) walk of every features/*.tdf so
// repeated /features requests are served from memory.  The walk is
// idempotent — TA's mounted assets don't change during a session.
var (
	scanFeaturesCacheMu sync.Mutex
	scanFeaturesList    []featureEntry
	scanFeaturesByName  map[string]featureEntry
)

// scanFeatures walks features/*.tdf, returning one entry per declared
// feature plus a map keyed by lowercased name for direct lookup.
// Origin metadata (OriginX/OriginY) is *not* loaded here — that
// requires parsing every referenced GAF, which is too slow to block
// the features list on.  The browser fetches origins lazily via
// /api/studio/feature-origins.
func scanFeatures() ([]featureEntry, map[string]featureEntry) {
	scanFeaturesCacheMu.Lock()
	if scanFeaturesList != nil {
		out, byName := scanFeaturesList, scanFeaturesByName
		scanFeaturesCacheMu.Unlock()
		return out, byName
	}
	scanFeaturesCacheMu.Unlock()

	var out []featureEntry
	byName := make(map[string]featureEntry)
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "features/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		data, err := vfs.ReadFile(p)
		if err != nil {
			continue
		}
		doc, err := tdf.ParseString(string(data))
		if err != nil {
			continue
		}
		for _, s := range doc.Sections() {
			name := s.Name()
			key := strings.ToLower(name)
			if _, dup := byName[key]; dup {
				continue
			}
			entry := featureEntry{
				Name:        name,
				Description: s.String("description"),
				Category:    s.String("category"),
				World:       s.String("world"),
				FootprintX:  s.Int("footprintx"),
				FootprintZ:  s.Int("footprintz"),
				Filename:    s.String("filename"),
				Seqname:     s.String("seqname"),
			}
			if entry.Filename != "" && entry.Seqname != "" {
				entry.PreviewURL = "/api/studio/feature-preview/" + url.PathEscape(name)
			}
			byName[key] = entry
			out = append(out, entry)
		}
	}
	scanFeaturesCacheMu.Lock()
	scanFeaturesList = out
	scanFeaturesByName = byName
	scanFeaturesCacheMu.Unlock()
	return out, byName
}

// handleFeatureOrigins returns the GAF hotspot (OriginX/OriginY) for
// every feature with an animation.  Computed lazily and memoised; the
// browser fires this in parallel with /api/studio/features so the
// drawer renders immediately and feature placements progressively
// snap to their correct anchor as origins load.
func handleFeatureOrigins(w http.ResponseWriter, _ *http.Request) {
	features, _ := scanFeatures()
	type originEntry struct {
		Name    string `json:"name"`
		OriginX int    `json:"originX"`
		OriginY int    `json:"originY"`
	}
	out := make([]originEntry, 0, len(features))
	for _, f := range features {
		if f.Filename == "" || f.Seqname == "" {
			continue
		}
		ox, oy, ok := featureSpriteOrigin(f.Filename, f.Seqname)
		if !ok {
			continue
		}
		out = append(out, originEntry{Name: f.Name, OriginX: ox, OriginY: oy})
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, map[string]any{"origins": out})
}

var (
	featureOriginCacheMu sync.Mutex
	featureOriginCache   = map[string][2]int{}
)

// featureSpriteOrigin returns the OriginX/OriginY of the first frame
// of <gafFilename>.gaf's named sequence, with results memoised so
// repeated lookups are free.  Falls back to (0,0,false) when the GAF
// can't be loaded — callers treat that as "no offset known".
func featureSpriteOrigin(gafFilename, seqName string) (int, int, bool) {
	if gafFilename == "" {
		return 0, 0, false
	}
	key := strings.ToLower(gafFilename) + "|" + strings.ToLower(seqName)
	featureOriginCacheMu.Lock()
	if v, ok := featureOriginCache[key]; ok {
		featureOriginCacheMu.Unlock()
		return v[0], v[1], true
	}
	featureOriginCacheMu.Unlock()

	gafPath := "anims/" + strings.ToLower(gafFilename) + ".gaf"
	data, err := vfs.ReadFile(gafPath)
	if err != nil {
		return 0, 0, false
	}
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return 0, 0, false
	}
	defer func() { _ = reader.Close() }()
	sequences, err := reader.ReadSequences()
	if err != nil || len(sequences) == 0 {
		return 0, 0, false
	}
	target := sequences[0]
	for _, s := range sequences {
		if strings.EqualFold(s.Name, seqName) {
			target = s
			break
		}
	}
	if len(target.Frames) == 0 {
		return 0, 0, false
	}
	ox := int(target.Frames[0].OriginX)
	oy := int(target.Frames[0].OriginY)
	featureOriginCacheMu.Lock()
	featureOriginCache[key] = [2]int{ox, oy}
	featureOriginCacheMu.Unlock()
	return ox, oy, true
}

// ── /api/studio/save ───────────────────────────────────────────────────────

type saveStamp struct {
	SectionPath string `json:"sectionPath"`
	SX          int    `json:"sx"`
	SY          int    `json:"sy"`
	Rotation    int    `json:"rotation"` // 0..3 (count of 90° CW quarter-turns)
	FlipH       bool   `json:"flipH,omitempty"`
	FlipV       bool   `json:"flipV,omitempty"`
}

type saveFeature struct {
	Name string `json:"name"`
	AX   int    `json:"ax"`
	AY   int    `json:"ay"`
}

type saveStartPos struct {
	Number int `json:"number"`
	X      int `json:"x"`
	Z      int `json:"z"`
}

// otaSchema is one [Schema N] block in the saved .ota file.  Each
// schema in TA's network play has its own economy, AI, and a set of
// StartPos1..N specials.
type otaSchema struct {
	Name           string         `json:"name"`
	Type           string         `json:"type"`
	AIProfile      string         `json:"aiProfile"`
	SurfaceMetal   int            `json:"surfaceMetal"`
	MohoMetal      int            `json:"mohoMetal"`
	HumanMetal     int            `json:"humanMetal"`
	ComputerMetal  int            `json:"computerMetal"`
	HumanEnergy    int            `json:"humanEnergy"`
	ComputerEnergy int            `json:"computerEnergy"`
	MeteorWeapon   string         `json:"meteorWeapon"`
	MeteorRadius   int            `json:"meteorRadius"`
	MeteorDensity  int            `json:"meteorDensity"`
	MeteorDuration int            `json:"meteorDuration"`
	MeteorInterval int            `json:"meteorInterval"`
	StartPos       []saveStartPos `json:"startPositions"`
}

type otaState struct {
	MissionName        string      `json:"missionName"`
	MissionDescription string      `json:"missionDescription"`
	MissionHint        string      `json:"missionHint"`
	Brief              string      `json:"brief"`
	Narration          string      `json:"narration"`
	Glamour            string      `json:"glamour"`
	Planet             string      `json:"planet"`
	NumPlayers         string      `json:"numPlayers"`
	Size               string      `json:"size"`
	Memory             string      `json:"memory"`
	LineOfSight        int         `json:"lineOfSight"`
	Mapping            int         `json:"mapping"`
	TidalStrength     int         `json:"tidalStrength"`
	SolarStrength    int         `json:"solarStrength"`
	LavaWorld          int         `json:"lavaWorld"`
	Killmul            int         `json:"killmul"`
	Timemul            int         `json:"timemul"`
	MinWindSpeed       int         `json:"minWindSpeed"`
	MaxWindSpeed       int         `json:"maxWindSpeed"`
	Gravity            int         `json:"gravity"`
	SeaLevel           int         `json:"seaLevel"`
	ImpassibleWater    int         `json:"impassibleWater"`
	WaterDoesDamage    int         `json:"waterDoesDamage"`
	Schemas            []otaSchema `json:"schemas"`
}

type saveRequest struct {
	MapName     string         `json:"mapName"`
	DisplayName string         `json:"displayName"`
	TileW       int            `json:"tileW"`
	TileH       int            `json:"tileH"`
	DefaultH    int            `json:"defaultHeight"`
	SeaLevel    int            `json:"seaLevel"`
	Tiles       []*saveStamp   `json:"tiles"`
	Heights     []int          `json:"heights"`
	Voids       []int          `json:"voids"`
	Features    []saveFeature  `json:"features"`
	StartPos    []saveStartPos `json:"startPositions"`
	Planet      string         `json:"planet"`
	OTA         *otaState      `json:"ota"`
}

func handleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "cross-origin POST refused", http.StatusForbidden)
		return
	}
	var req saveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.TileW <= 0 || req.TileH <= 0 {
		http.Error(w, "tileW and tileH must be positive", http.StatusBadRequest)
		return
	}
	if req.MapName == "" {
		req.MapName = "newmap"
	}
	// Sanitise mapName — only ASCII letters/digits/space/underscore.
	req.MapName = sanitiseMapName(req.MapName)

	hpiBytes, err := buildHPI(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("build failed: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", req.MapName+".hpi"))
	_, _ = w.Write(hpiBytes)
}

// handleSaveLoose returns the TNT + OTA artifacts as a multipart
// response so the client can offer separate file downloads.  Pairs
// with the Map menu's loose-save button for users who want to drop a
// new TNT into an HPI tool of their choice.
func handleSaveLoose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "cross-origin POST refused", http.StatusForbidden)
		return
	}
	var req saveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.TileW <= 0 || req.TileH <= 0 {
		http.Error(w, "tileW and tileH must be positive", http.StatusBadRequest)
		return
	}
	if req.MapName == "" {
		req.MapName = "newmap"
	}
	req.MapName = sanitiseMapName(req.MapName)
	which := r.URL.Query().Get("which")
	if which != "tnt" && which != "ota" {
		http.Error(w, "which must be 'tnt' or 'ota'", http.StatusBadRequest)
		return
	}
	tntBytes, otaBytes, err := buildArtifacts(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("build failed: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	if which == "tnt" {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", req.MapName+".tnt"))
		_, _ = w.Write(tntBytes)
	} else {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", req.MapName+".ota"))
		_, _ = w.Write(otaBytes)
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

// sameOrigin reports whether the request was initiated by a page that
// shares an origin with this server.  Used as a low-cost CSRF guard on
// mutating endpoints — a foreign site holding a fetch() to localhost
// can't read the response thanks to CORS, but it CAN issue a side
// effect like /api/studio/save.  We block those by comparing the
// browser-supplied Origin (or, as a fallback, Referer) host against
// the request's own Host header.  Requests with no Origin/Referer
// (curl, server-to-server, same-origin form posts) are allowed
// through — the editor's own fetches always carry a same-origin
// Origin header so they pass.
func sameOrigin(r *http.Request) bool {
	matches := func(raw string) (claimed, ok bool) {
		if raw == "" {
			return false, true // header absent — not claimed; defer to next check
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return true, false
		}
		return true, u.Host == r.Host
	}
	if claimed, ok := matches(r.Header.Get("Origin")); claimed {
		return ok
	}
	if claimed, ok := matches(r.Header.Get("Referer")); claimed {
		return ok
	}
	// Neither Origin nor Referer claimed an origin (non-browser caller
	// like curl).  We can't reach this state from a malicious browser
	// page, so allow it through — the user's own scripted tooling is
	// often the intended caller.
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func loadVFSPalette() color.Palette {
	palData, err := vfs.ReadFile("palettes/palette.pal")
	if err != nil {
		pal, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
		if err != nil {
			return nil
		}
		return pal.ColorModel()
	}
	palette := make(color.Palette, 256)
	for i := 0; i < 256 && i*4+2 < len(palData); i++ {
		a := uint8(255)
		if i == 0 {
			a = 0
		}
		palette[i] = color.RGBA{palData[i*4], palData[i*4+1], palData[i*4+2], a}
	}
	return palette
}

func sanitiseMapName(name string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(name) {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == ' ' || r == '_' || r == '-':
			b.WriteRune(r)
		}
	}
	out := b.String()
	if out == "" {
		out = "newmap"
	}
	return out
}
