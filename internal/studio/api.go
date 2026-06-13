package studio

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/assets"
)

func (sess *Session) registerAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/studio/heartbeat", handleHeartbeat)
	// Build fingerprint lives only at the global root /api/build-id (hub mux) —
	// it's a server-wide fact, not workspace-scoped. The build-watcher fetches
	// it via the origin root (bypassing the workspace API shim), so no
	// session-prefixed route is needed here.
	mux.HandleFunc("/api/studio/session-info", sess.handleSessionInfo)
	mux.HandleFunc("/api/studio/feature-origins", sess.handleFeatureOrigins)
	mux.HandleFunc("/api/studio/defaults", handleDefaults)
	mux.HandleFunc("/api/studio/tilesets", sess.handleTilesets)
	mux.HandleFunc("/api/studio/maps", sess.handleMapsList)
	mux.HandleFunc("/api/studio/sandbox-map", sess.handleSandboxMap)
	mux.HandleFunc("/api/studio/sandbox-map-texture", sess.handleSandboxMapTexture)
	mux.HandleFunc("/api/studio/sandbox-sides", sess.handleSandboxSides)
	mux.HandleFunc("/api/studio/sandbox-loadscreen", sess.handleSandboxLoadScreen)
	mux.HandleFunc("/api/studio/minimap/", sess.handleMapMinimap)
	mux.HandleFunc("/api/studio/map-render/", sess.handleMapRender)
	mux.HandleFunc("/api/studio/tak-stamp", sess.handleTAKStamp)
	mux.HandleFunc("/api/studio/load", sess.handleMapLoad)
	mux.HandleFunc("/api/studio/load-upload", sess.handleMapLoadUpload)
	mux.HandleFunc("/api/studio/tile-pool/", sess.handleMapTilePool)
	mux.HandleFunc("/api/studio/sections", sess.handleSections)
	mux.HandleFunc("/api/studio/section-preview/", sess.handleSectionPreview)
	mux.HandleFunc("/api/studio/section-image/", sess.handleSectionImage)
	mux.HandleFunc("/api/studio/section-heights/", sess.handleSectionHeights)
	mux.HandleFunc("/api/studio/features", sess.handleFeatures)
	mux.HandleFunc("/api/studio/feature-preview/", sess.handleFeaturePreview)
	mux.HandleFunc("/api/studio/save", sess.handleSave)
	mux.HandleFunc("/api/studio/save-loose", sess.handleSaveLoose)
	mux.HandleFunc("/api/studio/quality-check", sess.handleQualityCheck)
	mux.HandleFunc("/api/studio/export-render", sess.handleExportFullRender)
	mux.HandleFunc("/api/studio/export-map-image", sess.handleExportMapImage)
	mux.HandleFunc("/api/studio/export-buildmap", sess.handleExportBuildmap)
	mux.HandleFunc("/api/studio/export-voidmap", sess.handleExportVoidmap)
	mux.HandleFunc("/api/studio/glamour/list", sess.handleGlamourList)
	mux.HandleFunc("/api/studio/glamour/image/", sess.handleGlamourImage)
	mux.HandleFunc("/api/studio/sound/", sess.handleSound)
	mux.HandleFunc("/api/studio/music", sess.handleMusicList)
	mux.HandleFunc("/api/studio/music/", sess.handleMusicStream)
	mux.HandleFunc("/api/studio/weapon-fx/", sess.handleWeaponFx)
	mux.HandleFunc("/api/studio/weapon-bitmap/", sess.handleWeaponBitmap)
	mux.HandleFunc("/api/studio/export-mod", sess.handleExportMod)
	sess.registerModelAPI(mux)
	sess.registerCobAPI(mux)
	sess.registerUnitAPI(mux)
	sess.registerKeysAPI(mux)
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

// ── /api/studio/session-info ───────────────────────────────────────────────

// handleSessionInfo reports the session's game and display name so the editor
// chrome can show the game-specific brand banner and the workspace name.
func (sess *Session) handleSessionInfo(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, map[string]any{
		"id":   sess.id,
		"name": sess.name,
		"game": sess.game,
	})
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

// sectionPreviewCache memoises rendered section-preview PNGs so the
// drawer's per-section thumbnails don't re-parse the SCT on every
// request.  Populated lazily and by the startup preload goroutine.
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
func (sess *Session) startAssetPreload() {
	pal := sess.loadVFSPalette()
	paths := sess.vfs.List()

	// ── Maps ──
	var tntPaths []string
	for _, p := range paths {
		lower := strings.ToLower(p)
		if strings.HasPrefix(lower, "maps/") && strings.HasSuffix(lower, ".tnt") {
			tntPaths = append(tntPaths, p)
		}
	}
	sess.preloadProgress.set("maps", 0, len(tntPaths))
	for i, p := range tntPaths {
		entry, mini := sess.summariseMapWithMinimap(p)
		sess.mapCatalog.mu.Lock()
		sess.mapCatalog.entries = append(sess.mapCatalog.entries, entry)
		if mini != nil {
			sess.mapCatalog.minimaps[p] = mini
		}
		sess.mapCatalog.mu.Unlock()
		sess.preloadProgress.set("maps", i+1, len(tntPaths))
	}
	sess.mapCatalog.mu.Lock()
	sort.Slice(sess.mapCatalog.entries, func(i, j int) bool {
		return strings.ToLower(sess.mapCatalog.entries[i].Name) < strings.ToLower(sess.mapCatalog.entries[j].Name)
	})
	sess.mapCatalog.ready = true
	sess.mapCatalog.mu.Unlock()

	// ── Sections + feature thumbnails (parallel via the asset queue) ──
	//
	// Both phases share one worker pool so the warm-up actually uses
	// multiple cores instead of running each phase serially.  Jobs are
	// LOW priority — if the user hits the editor mid-warm and asks for
	// a specific section/feature, the handler enqueues at HIGH and
	// jumps the queue.
	sections := sess.allSectionsFromVFS()
	features, _ := sess.scanFeatures()
	withFile := features[:0:0]
	for _, f := range features {
		if f.Filename != "" && f.Seqname != "" {
			withFile = append(withFile, f)
		}
	}

	q := sess.getAssetQueue()

	// Track section + feature drain progress separately so the TTY
	// progress bar still reports per-phase counters.
	var sectionsDone, featuresDone atomic.Int64
	sess.preloadProgress.set("sections", 0, len(sections))
	sess.preloadProgress.set("features", 0, len(withFile))

	for _, s := range sections {
		path := s.Path
		q.Submit(priorityLow, func() {
			// Skip if a HIGH-priority handler raced ahead and cached
			// this section already — no point burning a worker.
			sess.sectionPreviewMu.RLock()
			cached := sess.sectionPreviewCache[path] != nil
			sess.sectionPreviewMu.RUnlock()
			if !cached {
				if b := sess.renderSectionPreviewPNG(path, pal); b != nil {
					sess.sectionPreviewMu.Lock()
					sess.sectionPreviewCache[path] = b
					sess.sectionPreviewMu.Unlock()
				}
			}
			n := sectionsDone.Add(1)
			sess.preloadProgress.set("sections", int(n), len(sections))
		})
	}

	for _, f := range withFile {
		feat := f
		q.Submit(priorityLow, func() {
			key := strings.ToLower(feat.Name) + "|static"
			sess.featureCacheMu.Lock()
			_, already := sess.featureCache[key]
			sess.featureCacheMu.Unlock()
			if !already {
				if data, err := sess.renderFeatureStaticPNG(feat.Filename, feat.Seqname); err == nil {
					sess.featureCacheMu.Lock()
					sess.featureCache[key] = data
					sess.featureCacheMu.Unlock()
				}
			}
			n := featuresDone.Add(1)
			sess.preloadProgress.set("features", int(n), len(withFile))
		})
	}

	// Block until both phases have drained.  Polling the atomic
	// counters lets handler-triggered HIGH-priority work flow in
	// without us blocking a worker.
	for sectionsDone.Load() < int64(len(sections)) || featuresDone.Load() < int64(len(withFile)) {
		time.Sleep(50 * time.Millisecond)
	}

	sess.preloadProgress.finish()
}

// renderSectionPreviewPNG renders the same PNG handleSectionPreview
// would serve, so the preload goroutine and the live handler agree
// on bytes.
func (sess *Session) renderSectionPreviewPNG(sectionPath string, pal color.Palette) []byte {
	// TA:Kingdoms sections are texture-mapped TNT prefabs — render the terrain
	// surface as the thumbnail (downscaled), with the baked minimap as fallback.
	if strings.HasSuffix(strings.ToLower(sectionPath), ".tnt") {
		if img, err := sess.renderTAKTerrain(sectionPath); err == nil && img != nil {
			var buf bytes.Buffer
			if png.Encode(&buf, downscaleRGBA(img, 256)) == nil {
				return buf.Bytes()
			}
		}
		if data, err := sess.vfs.ReadFile(sectionPath); err == nil {
			if m, err := tnt.LoadFromReader(bytes.NewReader(data)); err == nil && m.Minimap != nil {
				if mm := m.RenderMinimap(sess.palettes().TerrainPalette(sectionPath)); mm != nil {
					var buf bytes.Buffer
					if png.Encode(&buf, mm) == nil {
						return buf.Bytes()
					}
				}
			}
		}
		return nil
	}
	data, err := sess.vfs.ReadFile(sectionPath)
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
func (sess *Session) allSectionsFromVFS() []sectionEntry {
	var out []sectionEntry
	for _, p := range sess.vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "sections/") || !strings.HasSuffix(lower, ".sct") {
			continue
		}
		out = append(out, sectionEntry{Path: p})
	}
	return out
}

func (sess *Session) handleMapsList(w http.ResponseWriter, _ *http.Request) {
	sess.mapCatalog.mu.RLock()
	ready := sess.mapCatalog.ready
	entries := make([]mapEntry, len(sess.mapCatalog.entries))
	copy(entries, sess.mapCatalog.entries)
	sess.mapCatalog.mu.RUnlock()
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
func (sess *Session) summariseMapWithMinimap(p string) (mapEntry, []byte) {
	entry := mapEntry{Path: p, Name: strings.TrimSuffix(path.Base(p), path.Ext(p))}
	var pngBytes []byte
	if data, err := sess.vfs.ReadFile(p); err == nil {
		if m, err := tnt.LoadFromReader(bytes.NewReader(data)); err == nil {
			entry.TileW = m.TileW
			entry.TileH = m.TileH
			if m.Minimap != nil {
				entry.MinimapURL = "/api/studio/minimap/" + p
				// The resolver picks the per-map terrain palette (TA:K bakes its
				// minimap with the map's per-kingdom table).
				if img := m.RenderMinimap(sess.palettes().TerrainPalette(p)); img != nil {
					var buf bytes.Buffer
					if err := png.Encode(&buf, img); err == nil {
						pngBytes = buf.Bytes()
					}
				}
			}
		}
	}
	otaPath := strings.TrimSuffix(p, path.Ext(p)) + ".ota"
	if data, err := sess.vfs.ReadFile(otaPath); err == nil {
		var m ta.Map
		if err := tdf.Unmarshal(data, &m); err == nil && m.Header.Key != "" {
			entry.MissionName = m.Header.MissionName
			entry.Planet = m.Header.Planet
			entry.NumPlayers = joinInts(m.Header.NumPlayers)
		}
	}
	return entry, pngBytes
}

// handleMapMinimap streams the embedded TNT minimap as a PNG so the
// open-map dialog can show a thumbnail per map.  The preload goroutine
// usually has the PNG ready; the live fallback covers requests that
// race ahead of the preload (or maps that weren't picked up by it).
func (sess *Session) handleMapMinimap(w http.ResponseWriter, r *http.Request) {
	mapPath := strings.TrimPrefix(r.URL.Path, "/api/studio/minimap/")
	if mapPath == "" {
		http.Error(w, "missing map path", http.StatusBadRequest)
		return
	}
	sess.mapCatalog.mu.RLock()
	cached := sess.mapCatalog.minimaps[mapPath]
	sess.mapCatalog.mu.RUnlock()
	if cached != nil {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	data, err := sess.vfs.ReadFile(mapPath)
	if err != nil {
		http.Error(w, "map not found", http.StatusNotFound)
		return
	}
	m, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil || m.Minimap == nil {
		http.Error(w, "no minimap available", http.StatusNotFound)
		return
	}
	img := m.RenderMinimap(sess.palettes().TerrainPalette(mapPath))
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

func (sess *Session) cacheTNT(mapPath string, m *tnt.Map) {
	sess.tntCacheMu.Lock()
	defer sess.tntCacheMu.Unlock()
	if _, ok := sess.tntCache[mapPath]; ok {
		sess.tntCacheTouchLocked(mapPath)
	} else {
		sess.tntCacheOrder = append(sess.tntCacheOrder, mapPath)
	}
	sess.tntCache[mapPath] = m
	for len(sess.tntCacheOrder) > tntCacheCap {
		evict := sess.tntCacheOrder[0]
		sess.tntCacheOrder = sess.tntCacheOrder[1:]
		delete(sess.tntCache, evict)
	}
}

// uncacheTNT drops a parsed map from the cache (after a save rewrites the
// underlying file) so the next load re-reads the fresh bytes.
func (sess *Session) uncacheTNT(mapPath string) {
	sess.tntCacheMu.Lock()
	defer sess.tntCacheMu.Unlock()
	if _, ok := sess.tntCache[mapPath]; !ok {
		return
	}
	delete(sess.tntCache, mapPath)
	for i, p := range sess.tntCacheOrder {
		if p == mapPath {
			sess.tntCacheOrder = append(sess.tntCacheOrder[:i], sess.tntCacheOrder[i+1:]...)
			break
		}
	}
}

func (sess *Session) lookupTNT(mapPath string) *tnt.Map {
	sess.tntCacheMu.Lock()
	defer sess.tntCacheMu.Unlock()
	m, ok := sess.tntCache[mapPath]
	if !ok {
		return nil
	}
	sess.tntCacheTouchLocked(mapPath)
	return m
}

func (sess *Session) tntCacheTouchLocked(mapPath string) {
	for i, p := range sess.tntCacheOrder {
		if p == mapPath {
			sess.tntCacheOrder = append(sess.tntCacheOrder[:i], sess.tntCacheOrder[i+1:]...)
			sess.tntCacheOrder = append(sess.tntCacheOrder, mapPath)
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
	// TextureMapped marks a TA:Kingdoms map: its terrain is a texture-mapped
	// surface (no 32×32 tile pool), so the editor shows TerrainURL as a backdrop
	// instead of stamped tiles.
	TextureMapped bool   `json:"textureMapped,omitempty"`
	TerrainURL    string `json:"terrainUrl,omitempty"`
}

// handleMapLoad parses a TNT (and its sibling OTA when present) and
// returns the data the editor needs to populate state: tile pool
// coordinates per cell, heightmap, feature placements, and the full
// OTA struct.  The browser then fetches the tile pool atlas through
// /api/studio/tile-pool/<path>.
func (sess *Session) handleMapLoad(w http.ResponseWriter, r *http.Request) {
	mapPath := r.URL.Query().Get("path")
	if mapPath == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	data, err := sess.vfs.ReadFile(mapPath)
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

	sess.cacheTNT(mapPath, m)

	poolCols := tilePoolCols(len(m.Tiles))

	// TA:Kingdoms maps are texture-mapped rather than tile-stamped: there is no
	// 32×32 tile pool. Report the graphic-unit grid as the tile dimensions, an
	// empty tile list, and the per-DataUnit heightmap (TAKW×TAKH = 2×2 per
	// graphic unit, exactly the attribute-cell resolution the editor expects).
	// The editor shows the terrain render as a backdrop (TextureMapped flag).
	tileW, tileH := m.TileW, m.TileH
	textureMapped := m.IsTAK
	var tiles []loadedTile
	var heights, voids []int
	if m.IsTAK {
		tileW, tileH = m.TAKGUW, m.TAKGUH
		tiles = []loadedTile{}
		heights = make([]int, len(m.TAKHeight))
		for i, h := range m.TAKHeight {
			heights[i] = int(h)
		}
		voids = make([]int, len(m.TAKHeight))
	} else {
		// Per-cell tile pool coords.  TileMap[i] indexes into m.Tiles.
		tiles = make([]loadedTile, len(m.TileMap))
		for i, idx := range m.TileMap {
			px := int(idx) % poolCols
			py := int(idx) / poolCols
			tiles[i] = loadedTile{SX: px, SY: py}
		}
		// Heights from TileAttr — one byte per 16-px attribute cell.
		// Voids are encoded in the same TileAttr.Feature field; 0xFFFC is
		// the canonical void sentinel and 0xFFFF means "no feature,
		// passable".  Early Cavedog maps (Metal Heck, Lava Run) also use
		// 0xFFFE on cells that are demonstrably buildable in-engine, so we
		// treat those as ordinary passable cells per the project's TNT
		// pitfall note (docs/formats/tnt.md).
		heights = make([]int, len(m.TileAttr))
		voids = make([]int, len(m.TileAttr))
		for i, a := range m.TileAttr {
			heights[i] = int(a.Height)
			if a.Feature == 0xFFFC {
				voids[i] = 1
			}
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
	if data, err := sess.vfs.ReadFile(otaPath); err == nil {
		ota = parseOTA(string(data), tileW, tileH)
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
	// TA:Kingdoms maps have no .ota planet= (only kingdom=); report the kingdom
	// as the planet so the editor's section drawer activates the matching
	// kingdom's section group (sections are grouped by kingdom for TA:K).
	if textureMapped && planet == "" {
		if k := sess.palettes().MapTerrainGroup(mapPath); k != "" {
			planet = k
		}
	}

	resp := loadResponse{
		Name:        baseName,
		Path:        mapPath,
		TileW:       tileW,
		TileH:       tileH,
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
	if textureMapped {
		resp.TextureMapped = true
		resp.TerrainURL = "/api/studio/map-render/" + mapPath
	}
	writeJSON(w, resp)
}

// handleMapLoadUpload accepts a multipart POST carrying a .tnt (and
// optionally a sibling .ota) from the user's local disk, parses it
// in-memory, stuffs the *tnt.Map into the TNT cache under a synthetic
// "upload:<name>" path, and returns the same loadResponse shape the
// VFS-backed loader does.  The tile-pool serving relies on the LRU
// cache; cache eviction would break subsequent tile-pool fetches, but
// the cap is 16 entries so that's only an issue when juggling many
// uploads at once.
func (sess *Session) handleMapLoadUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "cross-origin POST refused", http.StatusForbidden)
		return
	}
	// 32 MB cap — big enough for the largest stock TNTs by a margin.
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Error(w, "parse upload: "+err.Error(), http.StatusBadRequest)
		return
	}
	tntFile, tntHdr, err := r.FormFile("tnt")
	if err != nil {
		http.Error(w, "missing tnt file", http.StatusBadRequest)
		return
	}
	defer func() { _ = tntFile.Close() }()
	tntBytes, err := io.ReadAll(tntFile)
	if err != nil {
		http.Error(w, "read tnt: "+err.Error(), http.StatusBadRequest)
		return
	}
	m, err := tnt.LoadFromReader(bytes.NewReader(tntBytes))
	if err != nil {
		http.Error(w, "parse TNT: "+err.Error(), http.StatusBadRequest)
		return
	}
	features, _ := m.LoadFeatures(bytes.NewReader(tntBytes))
	placements := m.GetFeaturePlacements()

	baseName := strings.TrimSuffix(path.Base(tntHdr.Filename), path.Ext(tntHdr.Filename))
	if baseName == "" {
		baseName = "upload"
	}
	baseName = sanitiseMapName(baseName)
	uploadPath := fmt.Sprintf("upload:%s:%d", baseName, time.Now().UnixNano())
	sess.cacheTNT(uploadPath, m)

	poolCols := tilePoolCols(len(m.Tiles))
	tiles := make([]loadedTile, len(m.TileMap))
	for i, idx := range m.TileMap {
		px := int(idx) % poolCols
		py := int(idx) / poolCols
		tiles[i] = loadedTile{SX: px, SY: py}
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
		name := strings.TrimSpace(features[p.FeatureIdx].Name)
		if name == "" {
			continue
		}
		outFeatures = append(outFeatures, loadedFeature{Name: name, AX: p.AttrX, AY: p.AttrY})
	}

	// Optional OTA upload.  Best-effort — silently dropped on parse fail.
	var ota *otaState
	planet := ""
	missionName := baseName
	if otaFile, _, err := r.FormFile("ota"); err == nil {
		if data, err := io.ReadAll(otaFile); err == nil {
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
		_ = otaFile.Close()
	}

	resp := loadResponse{
		Name:        baseName,
		Path:        uploadPath,
		TileW:       m.TileW,
		TileH:       m.TileH,
		Planet:      planet,
		MissionName: missionName,
		TilePoolURL: "/api/studio/tile-pool/" + url.PathEscape(uploadPath),
		TilePoolKey: "upload:" + uploadPath,
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
func (sess *Session) handleMapTilePool(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/tile-pool/")
	mapPath, err := url.PathUnescape(raw)
	if err != nil || mapPath == "" {
		http.Error(w, "bad map path", http.StatusBadRequest)
		return
	}
	m := sess.lookupTNT(mapPath)
	if m == nil {
		// Upload-only maps live in cache; once evicted they can't be
		// rehydrated, so don't try to read them from VFS.
		if strings.HasPrefix(mapPath, "upload:") {
			http.Error(w, "uploaded map evicted from cache — reload from welcome screen", http.StatusGone)
			return
		}
		// Cache miss (process restart, direct URL hit before /load) —
		// re-parse the file on the fly so the endpoint stays usable.
		data, err := sess.vfs.ReadFile(mapPath)
		if err != nil {
			http.Error(w, "map not found", http.StatusNotFound)
			return
		}
		m, err = tnt.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			http.Error(w, "parse TNT: "+err.Error(), http.StatusInternalServerError)
			return
		}
		sess.cacheTNT(mapPath, m)
	}
	// The atlas only changes when the map's tile pool changes (a save),
	// so memoise the encoded PNG — compositing + encoding a big pool costs
	// the better part of a second and the editor refetches on every open.
	sess.tilePoolMu.Lock()
	if sess.tilePoolPNG == nil {
		sess.tilePoolPNG = map[string][]byte{}
	}
	cached := sess.tilePoolPNG[mapPath]
	sess.tilePoolMu.Unlock()
	if cached == nil {
		pal := sess.loadVFSPalette()
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
		var buf bytes.Buffer
		enc := png.Encoder{CompressionLevel: png.BestSpeed}
		if err := enc.Encode(&buf, img); err != nil {
			http.Error(w, "encode atlas: "+err.Error(), http.StatusInternalServerError)
			return
		}
		cached = buf.Bytes()
		sess.tilePoolMu.Lock()
		sess.tilePoolPNG[mapPath] = cached
		sess.tilePoolMu.Unlock()
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(cached)
}

// invalidateTilePool drops a map's cached atlas after a save rewrites its
// tile pool.
func (sess *Session) invalidateTilePool(mapPath string) {
	sess.tilePoolMu.Lock()
	delete(sess.tilePoolPNG, mapPath)
	sess.tilePoolMu.Unlock()
}

// joinInts renders the typed NumPlayers list back to the comma-joined
// string the editor JSON expects (e.g. []int{2,3,4} → "2, 3, 4").
func joinInts(vals []int) string {
	parts := make([]string, len(vals))
	for i, v := range vals {
		parts[i] = strconv.Itoa(v)
	}
	return strings.Join(parts, ", ")
}

// parseOTA walks the [GlobalHeader] block (and its nested Schema /
// specials sub-sections) into the editor's otaState shape.  Returns
// nil when the file is empty or unparseable.
func parseOTA(content string, tileW, tileH int) *otaState {
	var m ta.Map
	if err := tdf.Unmarshal([]byte(content), &m); err != nil {
		return nil
	}
	gh := m.Header
	if gh.Key == "" {
		return nil
	}
	out := &otaState{
		MissionName:        gh.MissionName,
		MissionDescription: gh.MissionDescription,
		MissionHint:        gh.MissionHint,
		Brief:              gh.Brief,
		Narration:          gh.Narration,
		Glamour:            gh.Glamour,
		Planet:             gh.Planet,
		NumPlayers:         joinInts(gh.NumPlayers),
		Size:               gh.Size,
		Memory:             gh.Memory,
		LineOfSight:        gh.LineOfSight,
		Mapping:            gh.Mapping,
		TidalStrength:      gh.TidalStrength,
		SolarStrength:      gh.SolarStrength,
		LavaWorld:          gh.LavaWorld,
		Killmul:            gh.KillMul,
		Timemul:            gh.TimeMul,
		MinWindSpeed:       gh.MinWindSpeed,
		MaxWindSpeed:       gh.MaxWindSpeed,
		Gravity:            gh.Gravity,
		SeaLevel:           gh.SeaLevel,
		ImpassibleWater:    gh.ImpassibleWater,
		WaterDoesDamage:    gh.WaterDoesDamage,
	}
	for _, sec := range gh.Schemas {
		schema := otaSchema{
			Name:           strings.TrimPrefix(sec.Key, "Schema "),
			Type:           sec.Type,
			AIProfile:      sec.AIProfile,
			SurfaceMetal:   sec.SurfaceMetal,
			MohoMetal:      sec.MohoMetal,
			HumanMetal:     sec.HumanMetal,
			ComputerMetal:  sec.ComputerMetal,
			HumanEnergy:    sec.HumanEnergy,
			ComputerEnergy: sec.ComputerEnergy,
			MeteorWeapon:   sec.MeteorWeapon,
			MeteorRadius:   sec.MeteorRadius,
			MeteorDensity:  int(sec.MeteorDensity),
			MeteorDuration: sec.MeteorDuration,
			MeteorInterval: sec.MeteorInterval,
		}
		if schema.Name == "" {
			schema.Name = sec.Key
		}
		if sec.Specials != nil {
			for _, sp := range sec.Specials.Items {
				what := sp.SpecialWhat
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
					X:      sp.XPos,
					Z:      sp.ZPos,
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

func (sess *Session) handleSections(w http.ResponseWriter, _ *http.Request) {
	var entries []sectionEntry
	for _, p := range sess.vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "sections/") {
			continue
		}
		// TA uses .sct prefabs; TA:Kingdoms ships .tnt section prefabs.
		if !strings.HasSuffix(lower, ".sct") && !strings.HasSuffix(lower, ".tnt") {
			continue
		}
		entries = append(entries, sess.summariseSection(p))
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

func (sess *Session) summariseSection(p string) sectionEntry {
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
	if data, err := sess.vfs.ReadFile(p); err == nil {
		if strings.HasSuffix(strings.ToLower(p), ".tnt") {
			// TA:Kingdoms sections are texture-mapped TNT prefabs (Sections.hpi
			// / IPSections.hpi), grouped sections/<kingdom>/<group>/*.tnt.
			if m, merr := tnt.LoadFromReader(bytes.NewReader(data)); merr == nil {
				if m.IsTAK {
					entry.TileW, entry.TileH = m.TAKGUW, m.TAKGUH
				} else {
					entry.TileW, entry.TileH = m.TileW, m.TileH
				}
				entry.HasMini = m.Minimap != nil
			}
		} else if s, serr := sct.LoadFromReader(bytes.NewReader(data)); serr == nil {
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
func (sess *Session) handleSectionPreview(w http.ResponseWriter, r *http.Request) {
	sectionPath := strings.TrimPrefix(r.URL.Path, "/api/studio/section-preview/")
	if sectionPath == "" {
		http.Error(w, "missing section path", http.StatusBadRequest)
		return
	}
	sess.sectionPreviewMu.RLock()
	cached := sess.sectionPreviewCache[sectionPath]
	sess.sectionPreviewMu.RUnlock()
	if cached != nil {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	// Jump the warm queue: the user is staring at the drawer waiting
	// for this exact section.  singleflight inside Run() dedupes
	// concurrent requests for the same path.
	sess.getAssetQueue().Run("section:"+sectionPath, func() {
		pal := sess.loadVFSPalette()
		b := sess.renderSectionPreviewPNG(sectionPath, pal)
		if b != nil {
			sess.sectionPreviewMu.Lock()
			sess.sectionPreviewCache[sectionPath] = b
			sess.sectionPreviewMu.Unlock()
		}
	})
	sess.sectionPreviewMu.RLock()
	pngBytes := sess.sectionPreviewCache[sectionPath]
	sess.sectionPreviewMu.RUnlock()
	if pngBytes == nil {
		http.Error(w, "section not found", http.StatusNotFound)
		return
	}
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

func (sess *Session) handleFeaturePreview(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/feature-preview/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "bad feature name", http.StatusBadRequest)
		return
	}
	staticOnly := r.URL.Query().Get("static") == "1"
	size := 0
	if s := r.URL.Query().Get("size"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 512 {
			size = n
		}
	}
	key := strings.ToLower(name)
	if staticOnly {
		key += "|static"
	}
	if size > 0 {
		key += "|" + strconv.Itoa(size)
	}

	sess.featureCacheMu.Lock()
	if cached, ok := sess.featureCache[key]; ok {
		sess.featureCacheMu.Unlock()
		w.Header().Set("Content-Type", contentTypeForFeature(staticOnly))
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	if sess.featureCacheBy == nil {
		_, sess.featureCacheBy = sess.scanFeatures()
	}
	entry, ok := sess.featureCacheBy[strings.ToLower(name)]
	sess.featureCacheMu.Unlock()
	if !ok {
		http.Error(w, "feature not found", http.StatusNotFound)
		return
	}
	if entry.Filename == "" {
		// No GAF — render the feature's 3DO object (wreckage / dead units).
		if entry.Object != "" {
			sess.serveObjectFeaturePreview(w, key, entry.Object, staticOnly, size)
			return
		}
		http.Error(w, "feature has no preview", http.StatusNotFound)
		return
	}

	// Jump the warm queue at HIGH priority + dedupe concurrent requests
	// for the same (feature, static) key via singleflight inside Run().
	var renderErr error
	sess.getAssetQueue().Run("feature:"+key, func() {
		var b []byte
		var e error
		if staticOnly {
			b, e = sess.renderFeatureStaticPNG(entry.Filename, entry.Seqname)
		} else {
			b, e = sess.renderFeatureAPNG(entry.Filename, entry.Seqname)
		}
		if e != nil {
			renderErr = e
			return
		}
		sess.featureCacheMu.Lock()
		sess.featureCache[key] = b
		sess.featureCacheMu.Unlock()
	})
	if renderErr != nil {
		http.Error(w, renderErr.Error(), http.StatusNotFound)
		return
	}
	sess.featureCacheMu.Lock()
	imgBytes := sess.featureCache[key]
	sess.featureCacheMu.Unlock()
	if imgBytes == nil {
		http.Error(w, "feature render failed", http.StatusInternalServerError)
		return
	}
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
func (sess *Session) renderFeatureStaticPNG(gafFilename, seqName string) ([]byte, error) {
	gafPath := "anims/" + strings.ToLower(gafFilename) + ".gaf"
	data, err := sess.vfs.ReadFile(gafPath)
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
	pal := sess.palettes().FeaturePalette(gafFilename)
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
func (sess *Session) renderFeatureAPNG(gafFilename, seqName string) ([]byte, error) {
	gafPath := "anims/" + strings.ToLower(gafFilename) + ".gaf"
	data, err := sess.vfs.ReadFile(gafPath)
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
	pal := sess.palettes().FeaturePalette(gafFilename)
	var buf bytes.Buffer
	if err := target.ToAPNG(pal, &buf); err != nil {
		return nil, fmt.Errorf("encode apng: %w", err)
	}
	return buf.Bytes(), nil
}

// loadPaletteBytes returns the raw 1024-byte palette (RGBA × 256).  Prefers
// the VFS copy if available, else falls back to the embedded TA palette.
func (sess *Session) loadPaletteBytes() []byte {
	if data, err := sess.vfs.ReadFile("palettes/palette.pal"); err == nil && len(data) >= 1024 {
		return data
	}
	return assets.DefaultPalette
}

// handleSectionHeights returns the section's per-attribute-cell heights
// as JSON so the studio client can populate its heightmap view without
// having to re-parse the SCT in the browser.
func (sess *Session) handleSectionHeights(w http.ResponseWriter, r *http.Request) {
	sectionPath := strings.TrimPrefix(r.URL.Path, "/api/studio/section-heights/")
	if sectionPath == "" {
		http.Error(w, "missing section path", http.StatusBadRequest)
		return
	}
	data, err := sess.vfs.ReadFile(sectionPath)
	if err != nil {
		http.Error(w, "section not found", http.StatusNotFound)
		return
	}
	// TA:K sections are texture-mapped TNT prefabs; their heights live in
	// the DataUnit grid (16px cells — the same resolution as TA's attribute
	// grid, so the response shape is identical).
	if strings.HasSuffix(strings.ToLower(sectionPath), ".tnt") {
		m, err := tnt.LoadFromReader(bytes.NewReader(data))
		if err != nil || !m.IsTAK {
			http.Error(w, "failed to parse TA:K section", http.StatusInternalServerError)
			return
		}
		heights := make([]int, len(m.TAKHeight))
		for i, h := range m.TAKHeight {
			heights[i] = int(h)
		}
		writeJSON(w, map[string]any{
			"w":       m.TAKGUW,
			"h":       m.TAKGUH,
			"attrW":   m.TAKW,
			"attrH":   m.TAKH,
			"heights": heights,
		})
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
func (sess *Session) handleSectionImage(w http.ResponseWriter, r *http.Request) {
	sectionPath := strings.TrimPrefix(r.URL.Path, "/api/studio/section-image/")
	if sectionPath == "" {
		http.Error(w, "missing section path", http.StatusBadRequest)
		return
	}
	data, err := sess.vfs.ReadFile(sectionPath)
	if err != nil {
		http.Error(w, "section not found", http.StatusNotFound)
		return
	}
	// TA:K sections render their texture-mapped terrain at full resolution
	// (32px per graphic unit — the same px-per-cell contract the TA tile
	// grid render keeps, so the canvas slicing math is unchanged).
	if strings.HasSuffix(strings.ToLower(sectionPath), ".tnt") {
		img, err := sess.renderTAKTerrain(sectionPath)
		if err != nil || img == nil {
			http.Error(w, "failed to render TA:K section", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_ = png.Encode(w, img)
		return
	}
	section, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "failed to parse SCT", http.StatusInternalServerError)
		return
	}
	img := section.RenderTileMap(sess.loadVFSPalette())
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
	Object      string `json:"-"`              // 3DO model for object-only features (wreckage)
	FeatureDead string `json:"-"`              // next wreck in the damage chain (corpse -> heap)
	Spin        bool   `json:"spin,omitempty"` // preview is a 3DO spin APNG (hover-only)
	OriginX     int    `json:"originX"`
	OriginY     int    `json:"originY"`
	// Metal yield (non-zero for the rocks-with-metal features the
	// engine considers a starting resource).  Used by the Quality
	// Checker's metal-proximity check; harmless extra field for the
	// rest of the UI which just ignores it.
	Metal      int    `json:"metal,omitempty"`
	PreviewURL string `json:"previewUrl,omitempty"`
}

func (sess *Session) handleFeatures(w http.ResponseWriter, _ *http.Request) {
	features, _ := sess.scanFeatures()
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
// scanFeatures walks features/*.tdf, returning one entry per declared
// feature plus a map keyed by lowercased name for direct lookup.
// Origin metadata (OriginX/OriginY) is *not* loaded here — that
// requires parsing every referenced GAF, which is too slow to block
// the features list on.  The browser fetches origins lazily via
// /api/studio/feature-origins.
func (sess *Session) scanFeatures() ([]featureEntry, map[string]featureEntry) {
	sess.scanFeaturesCacheMu.Lock()
	if sess.scanFeaturesList != nil {
		out, byName := sess.scanFeaturesList, sess.scanFeaturesByName
		sess.scanFeaturesCacheMu.Unlock()
		return out, byName
	}
	sess.scanFeaturesCacheMu.Unlock()

	var out []featureEntry
	byName := make(map[string]featureEntry)
	for _, p := range sess.vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "features/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		data, err := sess.vfs.ReadFile(p)
		if err != nil {
			continue
		}
		var features []ta.Feature
		if err := tdf.Unmarshal(data, &features); err != nil {
			continue
		}
		for _, f := range features {
			name := f.Key
			key := strings.ToLower(name)
			if _, dup := byName[key]; dup {
				continue
			}
			entry := featureEntry{
				Name:        name,
				Description: f.Description,
				Category:    f.Category,
				World:       f.World,
				FootprintX:  f.FootprintX,
				FootprintZ:  f.FootprintZ,
				Filename:    f.Filename,
				Seqname:     f.SeqName,
				Object:      f.Object,
				FeatureDead: f.FeatureDead,
				Metal:       int(f.Metal),
			}
			if entry.Filename != "" && entry.Seqname != "" {
				entry.PreviewURL = "/api/studio/feature-preview/" + url.PathEscape(name)
			} else if entry.Object != "" && sess.vfs != nil &&
				sess.vfs.Exists("objects3d/"+strings.ToLower(entry.Object)+".3do") {
				// Wreckage / dead-unit features are 3DO objects with no GAF; the
				// preview endpoint renders the 3DO. Only advertise it when the
				// model exists so the drawer never shows a broken image. Marked
				// as a spin preview so the drawer shows a static still until hover
				// (the animated spin APNG is expensive to render for all at once).
				entry.PreviewURL = "/api/studio/feature-preview/" + url.PathEscape(name)
				entry.Spin = true
			}
			byName[key] = entry
			out = append(out, entry)
		}
	}
	sess.scanFeaturesCacheMu.Lock()
	sess.scanFeaturesList = out
	sess.scanFeaturesByName = byName
	sess.scanFeaturesCacheMu.Unlock()
	return out, byName
}

// handleFeatureOrigins returns the GAF hotspot (OriginX/OriginY) for
// every feature with an animation.  Computed lazily and memoised; the
// browser fires this in parallel with /api/studio/features so the
// drawer renders immediately and feature placements progressively
// snap to their correct anchor as origins load.
func (sess *Session) handleFeatureOrigins(w http.ResponseWriter, _ *http.Request) {
	features, _ := sess.scanFeatures()
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
		ox, oy, ok := sess.featureSpriteOrigin(f.Filename, f.Seqname)
		if !ok {
			continue
		}
		out = append(out, originEntry{Name: f.Name, OriginX: ox, OriginY: oy})
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, map[string]any{"origins": out})
}

// featureSpriteOrigin returns the OriginX/OriginY of the first frame
// of <gafFilename>.gaf's named sequence, with results memoised so
// repeated lookups are free.  Falls back to (0,0,false) when the GAF
// can't be loaded — callers treat that as "no offset known".
func (sess *Session) featureSpriteOrigin(gafFilename, seqName string) (int, int, bool) {
	if gafFilename == "" {
		return 0, 0, false
	}
	key := strings.ToLower(gafFilename) + "|" + strings.ToLower(seqName)
	sess.featureOriginCacheMu.Lock()
	if v, ok := sess.featureOriginCache[key]; ok {
		sess.featureOriginCacheMu.Unlock()
		return v[0], v[1], true
	}
	sess.featureOriginCacheMu.Unlock()

	gafPath := "anims/" + strings.ToLower(gafFilename) + ".gaf"
	data, err := sess.vfs.ReadFile(gafPath)
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
	sess.featureOriginCacheMu.Lock()
	sess.featureOriginCache[key] = [2]int{ox, oy}
	sess.featureOriginCacheMu.Unlock()
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
	TidalStrength      int         `json:"tidalStrength"`
	SolarStrength      int         `json:"solarStrength"`
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
	// Fixes lists the quality-check fixes the user has accepted.  The
	// list is forwarded to maplint as AppliedFixes so rules with a
	// dialog-driven auto-fix know to skip re-flagging.  Unknown ids are
	// silently ignored, so the client can roll new fixes without a
	// coordinated server upgrade.
	Fixes []string `json:"fixes,omitempty"`

	// ActiveSchema is the 0-based schema index the editor's schema
	// picker currently has selected.  Used by the export-render
	// endpoint so the rendered StartPos markers reflect what the user
	// is looking at, not always Schema 0.
	ActiveSchema int `json:"activeSchema,omitempty"`

	// TakMapPath marks a TA:Kingdoms save: the VFS path of the open
	// texture-mapped map. TA:K terrain/heights are server-authoritative
	// (section stamps write the TNT immediately), so Save updates the
	// EXISTING 0x4000 TNT in place — features + sea level from the editor —
	// instead of running the TA tile-pool builder, which would otherwise
	// clobber the map with a blank TA-format TNT.
	TakMapPath string `json:"takMapPath,omitempty"`
}

func (sess *Session) handleSave(w http.ResponseWriter, r *http.Request) {
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

	// TA:K maps never go through the TA tile-pool builder — the 0x4000 TNT
	// is updated in place (see saveTAKMap), or packaged for download when
	// the session has no writable overlay.
	if req.TakMapPath != "" {
		if sess.workDir != "" {
			paths, err := sess.saveTAKMap(req)
			if err != nil {
				http.Error(w, fmt.Sprintf("save failed: %v", err), http.StatusInternalServerError)
				return
			}
			writeJSON(w, map[string]any{"ok": true, "saved": paths})
			return
		}
		tntBytes, otaBytes, err := sess.buildTAKArtifacts(req)
		if err != nil {
			http.Error(w, fmt.Sprintf("build failed: %v", err), http.StatusInternalServerError)
			return
		}
		hpiBytes, err := bundleMapHPI(req.MapName, tntBytes, otaBytes)
		if err != nil {
			http.Error(w, fmt.Sprintf("build failed: %v", err), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", req.MapName+".hpi"))
		_, _ = w.Write(hpiBytes)
		return
	}
	// A writable workspace session treats Save as a real save: every changed
	// file the map comprises (TNT + OTA) is written into the workspace's
	// copy-on-write VFS overlay, and the response is a JSON receipt rather
	// than a download. Read-only context sessions have nowhere to write, so
	// they keep the original behaviour: stream the packaged HPI download.
	if sess.workDir != "" {
		paths, err := sess.saveMapToWorkspace(req)
		if err != nil {
			http.Error(w, fmt.Sprintf("save failed: %v", err), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "saved": paths})
		return
	}
	hpiBytes, err := sess.buildHPI(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("build failed: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", req.MapName+".hpi"))
	_, _ = w.Write(hpiBytes)
}

// saveMapToWorkspace writes the built TNT + OTA into the session's writable
// VFS overlay and returns the paths written. Errors when the session has no
// work folder (read-only context).
func (sess *Session) saveMapToWorkspace(req saveRequest) ([]string, error) {
	if sess.workDir == "" || sess.vfs == nil {
		return nil, fmt.Errorf("session has no writable workspace")
	}
	tntBytes, otaBytes, err := sess.buildArtifacts(req)
	if err != nil {
		return nil, err
	}
	name := strings.ToLower(req.MapName)
	tntPath, otaPath := "maps/"+name+".tnt", "maps/"+name+".ota"
	sess.invalidateTilePool(tntPath)
	if err := sess.vfs.WriteFile(tntPath, tntBytes); err != nil {
		return nil, err
	}
	if err := sess.vfs.WriteFile(otaPath, otaBytes); err != nil {
		return nil, err
	}
	// Drop the stale parse cache so the next load sees the saved bytes.
	sess.uncacheTNT(tntPath)
	return []string{tntPath, otaPath}, nil
}

// handleSaveLoose returns the TNT + OTA artifacts as a multipart
// response so the client can offer separate file downloads.  Pairs
// with the Map menu's loose-save button for users who want to drop a
// new TNT into an HPI tool of their choice.
func (sess *Session) handleSaveLoose(w http.ResponseWriter, r *http.Request) {
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
	var tntBytes, otaBytes []byte
	var err error
	if req.TakMapPath != "" {
		// TA:K: apply the editor's feature/sea-level state to the existing
		// 0x4000 TNT and serve that; the OTA ships verbatim (it carries
		// kingdom= and other fields the TA OTA writer doesn't model).
		tntBytes, otaBytes, err = sess.buildTAKArtifacts(req)
	} else {
		tntBytes, otaBytes, err = sess.buildArtifacts(req)
	}
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

func (sess *Session) loadVFSPalette() color.Palette {
	palData, err := sess.vfs.ReadFile("palettes/palette.pal")
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
