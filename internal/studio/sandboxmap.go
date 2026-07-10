package studio

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/formats/tnt"
)

// Sandbox map support: the battlefield endpoints behind the sandbox's map
// picker. /api/studio/sandbox-map describes a TNT for the 3D sandbox — the
// attribute-resolution heightmap (base64), the world scale, sea level and
// start positions — and /api/studio/sandbox-map-texture serves the full
// terrain render (TA tile composite or TA:K texture composite) downscaled
// for use as the ground texture.
//
// World scale: the studio renders one map pixel as one world unit — a
// 2×2-footprint Peewee model is ~32 wu wide, matching its 32 px in-game
// footprint — so one 16-px attribute cell is 16 wu and heights land at the
// classic 1/2 wu per height unit.
const (
	sandboxCellWU = 16.0
	// sandboxHeightScale is the world-Y per raw height unit, fed identically to
	// the sim height field, the rendered mesh, and the click-pick terrain (see
	// map-loader.js), so they always agree and units sit on the ground. Held at
	// 0.61 — a 39% cut from the former 1.0 — because the full relief read far
	// too tall in-game (most glaring on TA:Kingdoms maps). This is a purely
	// visual/elevation scale: slope, water-depth and build-legality all work on
	// the raw height bytes, so flattening the look does NOT change what a unit
	// can climb or where it can build.
	sandboxHeightScale = 0.61
	pxPerWU            = 1.0
)

// sandboxMapJSON is the /api/studio/sandbox-map response.
type sandboxMapJSON struct {
	Path        string  `json:"path"`
	Name        string  `json:"name"`
	W           int     `json:"w"` // heightmap cells
	H           int     `json:"h"`
	CellWU      float64 `json:"cellWU"`
	HeightScale float64 `json:"heightScale"`
	SeaLevel    int     `json:"seaLevel"`
	WorldW      float64 `json:"worldW"` // world units
	WorldH      float64 `json:"worldH"`
	// Heights is the raw row-major heightmap bytes, base64-encoded.
	Heights string `json:"heights"`
	// Voids marks carved-out cells (1 = void), base64-encoded, same layout
	// as Heights. Omitted when the map has none.
	Voids string `json:"voids,omitempty"`
	// StartPositions are the first schema's player starts in world units,
	// origin at the map's top-left corner.
	StartPositions []sandboxStartPos `json:"startPositions"`
	TextureURL     string            `json:"textureUrl"`
	MinimapURL     string            `json:"minimapUrl"`
	// Features are the map's placed scenery (trees, rocks, metal, geo vents…)
	// in attribute-cell coordinates. The client turns each into a procedural
	// 3D stand-in anchored at its cell centre + terrain height. Same 16px cell
	// grid for both games. Omitted when the map has no feature table.
	Features []sandboxFeature `json:"features,omitempty"`
}

// sandboxFeature is one placed scenery instance: the raw TNT feature name and
// its attribute-cell position. The client maps the name to a surrogate.
type sandboxFeature struct {
	Name string `json:"name"`
	AX   int    `json:"ax"`
	AY   int    `json:"ay"`
}

type sandboxStartPos struct {
	Number int     `json:"number"`
	X      float64 `json:"x"`
	Z      float64 `json:"z"`
}

// startPosWorldScale is the factor that turns a schema's OTA StartPos into
// sandbox world units. The two games store the coordinate in different grids:
// TA writes map-pixels (1 px = 1 wu at pxPerWU), while TA:K writes DataUnit
// cells (one per 16-px height cell), so a TA:K start scales up by the cell
// size. Missing the TA:K scaling shrinks a start to a pixel offset near the
// map corner — frequently deep water — and the spawned leader lands stuck.
func startPosWorldScale(isTAK bool) float64 {
	if isTAK {
		return sandboxCellWU
	}
	return 1.0 / pxPerWU
}

// sandboxTerrain is the raw height field extracted from a TNT, shared by the
// /api/studio/sandbox-map JSON (which base64-encodes it for the browser) and
// the authority-side sim.Terrain builder, so a hosted match and its clients
// derive an identical grid from the same map file.
type sandboxTerrain struct {
	W, H     int
	SeaLevel int
	Heights  []byte // row-major, len = W*H
	Voids    []byte // row-major void flags, or nil when the map carves none
}

// loadSandboxTerrain parses a map's TNT and pulls the attribute-resolution
// height field (and void mask) both games share, abstracting the TA/TA:K
// storage split. It returns an error for an unreadable map or one with no
// usable heightmap.
func (sess *Session) loadSandboxTerrain(mapPath string) (*sandboxTerrain, error) {
	data, err := sess.vfs.ReadFile(mapPath)
	if err != nil {
		return nil, fmt.Errorf("map not found: %w", err)
	}
	m, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse TNT: %w", err)
	}
	t := &sandboxTerrain{}
	if m.IsTAK {
		t.W, t.H = m.TAKW, m.TAKH
		t.Heights = make([]byte, len(m.TAKHeight))
		copy(t.Heights, m.TAKHeight)
		// TA:K stores its sea level in the repurposed PTRMapData header slot
		// (the SeaLevel field holds the U-mapping table instead). Without this
		// the sim sees no water: ships/sea buildings can't be placed and the
		// underwater unit tint never triggers. The OTA carries no sealevel for
		// TA:K, so the header is the only source.
		t.SeaLevel = int(m.Header.PTRMapData)
	} else {
		t.W, t.H = m.AttrW, m.AttrH
		t.SeaLevel = int(m.Header.SeaLevel)
		t.Heights = make([]byte, len(m.TileAttr))
		voids := make([]byte, len(m.TileAttr))
		anyVoid := false
		for i, a := range m.TileAttr {
			t.Heights[i] = a.Height
			if a.Feature == 0xFFFC {
				voids[i] = 1
				anyVoid = true
			}
		}
		if anyVoid {
			t.Voids = voids
		}
	}
	if len(t.Heights) < t.W*t.H || t.W == 0 || t.H == 0 {
		return nil, fmt.Errorf("map has no usable heightmap")
	}
	// The OTA overrides sea level only when it actually carries one; TA:K OTAs
	// omit it (the level lives in the TNT header, already read above), so a
	// zero never clobbers the header value.
	otaPath := strings.TrimSuffix(mapPath, path.Ext(mapPath)) + ".ota"
	if otaData, err := sess.vfs.ReadFile(otaPath); err == nil {
		if ota := parseOTA(string(otaData), t.W/2, t.H/2); ota != nil {
			if ota.SeaLevel > 0 && (m.IsTAK || t.SeaLevel == 0) {
				t.SeaLevel = ota.SeaLevel
			}
		}
	}
	return t, nil
}

func (sess *Session) handleSandboxMap(w http.ResponseWriter, r *http.Request) {
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
	m, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "parse TNT: "+err.Error(), http.StatusInternalServerError)
		return
	}
	terr, err := sess.loadSandboxTerrain(mapPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}

	out := sandboxMapJSON{
		Path:        mapPath,
		Name:        strings.TrimSuffix(path.Base(mapPath), path.Ext(mapPath)),
		CellWU:      sandboxCellWU,
		HeightScale: sandboxHeightScale,
		TextureURL:  "/api/studio/sandbox-map-texture?path=" + mapPath,
		MinimapURL:  "/api/studio/minimap/" + mapPath,
		W:           terr.W,
		H:           terr.H,
		SeaLevel:    terr.SeaLevel,
	}
	if terr.Voids != nil {
		out.Voids = base64.StdEncoding.EncodeToString(terr.Voids)
	}
	out.WorldW = float64(out.W) * sandboxCellWU
	out.WorldH = float64(out.H) * sandboxCellWU
	out.Heights = base64.StdEncoding.EncodeToString(terr.Heights)

	// OTA — the first schema's start positions, converted to world units (the
	// sea-level override is folded into loadSandboxTerrain above). The two games
	// store StartPos in different grids: TA writes map-pixels (1 px = 1 wu at
	// pxPerWU), while TA:K writes DataUnit cells (one per 16-px height cell), so
	// a TA:K start must scale up by the cell size to land in world units.
	// Without the TA:K scaling a start reads as a tiny pixel offset near the
	// map corner — often deep water — and the leader spawns stuck.
	startScale := startPosWorldScale(m.IsTAK)
	otaPath := strings.TrimSuffix(mapPath, path.Ext(mapPath)) + ".ota"
	if otaData, err := sess.vfs.ReadFile(otaPath); err == nil {
		if ota := parseOTA(string(otaData), out.W/2, out.H/2); ota != nil {
			if len(ota.Schemas) > 0 {
				for _, sp := range ota.Schemas[0].StartPos {
					out.StartPositions = append(out.StartPositions, sandboxStartPos{
						Number: sp.Number,
						X:      float64(sp.X) * startScale,
						Z:      float64(sp.Z) * startScale,
					})
				}
			}
		}
	}

	// Placed scenery → attribute-cell positions for the 3D surrogates. The name
	// table lives at a different header offset per game, but GetFeaturePlacements
	// abstracts the grid. Non-fatal: a featureless map still loads its terrain.
	if feats, ferr := m.LoadFeatures(bytes.NewReader(data)); ferr == nil && len(feats) > 0 {
		for _, p := range m.GetFeaturePlacements() {
			if p.FeatureIdx < 0 || p.FeatureIdx >= len(feats) {
				continue
			}
			name := strings.TrimSpace(feats[p.FeatureIdx].Name)
			if name == "" {
				continue
			}
			out.Features = append(out.Features, sandboxFeature{Name: name, AX: p.AttrX, AY: p.AttrY})
		}
	}
	writeJSON(w, out)
}

// sandboxTextureCache memoizes the downscaled terrain renders — a full TA
// tile composite can be 8k×8k before scaling, so each (path, max) pair is
// rendered once per session.
var (
	sandboxTexMu    sync.Mutex
	sandboxTexCache = map[string][]byte{}
)

func (sess *Session) handleSandboxMapTexture(w http.ResponseWriter, r *http.Request) {
	mapPath := r.URL.Query().Get("path")
	if mapPath == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	// 4096 long edge: the client uploads the render to a power-of-two square and
	// mipmaps it, so it wants real detail to build the mip chain from (the old
	// 2048 cap left distant terrain shimmering under plain LINEAR sampling).
	// The client loads the composite ONCE at high resolution and keeps it in
	// memory, slicing the near-camera window into a bounded GPU clipmap cache
	// in-process — so this is a single up-front fetch, never a runtime stream.
	// Ceiling raised to the GPU max so that one fetch can carry near-native
	// detail; downscaleRGBA only ever shrinks, so a small map stays native.
	maxDim := 4096
	if v, err := strconv.Atoi(r.URL.Query().Get("max")); err == nil && v >= 256 && v <= 16384 {
		maxDim = v
	}
	key := fmt.Sprintf("%s|%d", mapPath, maxDim)
	sandboxTexMu.Lock()
	cached := sandboxTexCache[key]
	sandboxTexMu.Unlock()
	if cached != nil {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}

	data, err := sess.vfs.ReadFile(mapPath)
	if err != nil {
		http.Error(w, "map not found: "+err.Error(), http.StatusNotFound)
		return
	}
	m, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "parse TNT: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// TA:K first — RenderTileMap on a section-based map yields a non-nil
	// 0x0 image (no tile grid), which would slip past a nil check and die
	// at the PNG encoder.
	var img *image.RGBA
	if m.IsTAK {
		img, _ = sess.renderTAKTerrain(mapPath)
	} else {
		img = m.RenderTileMap(sess.palettes().TerrainPalette(mapPath))
	}
	if img == nil || img.Bounds().Empty() {
		http.Error(w, "render failed", http.StatusInternalServerError)
		return
	}
	img = downscaleRGBA(img, maxDim)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		http.Error(w, "encode: "+err.Error(), http.StatusInternalServerError)
		return
	}
	sandboxTexMu.Lock()
	sandboxTexCache[key] = buf.Bytes()
	sandboxTexMu.Unlock()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(buf.Bytes())
}

// sandboxSideJSON is one playable faction for the launch picker: the
// sidedata name plus its leader unit (commander / monarch).
type sandboxSideJSON struct {
	Index     int    `json:"index"`
	Name      string `json:"name"`
	Commander string `json:"commander,omitempty"`
}

// handleSandboxSides lists the game's playable sides from
// gamedata/sidedata.tdf — dynamic, so TA reports ARM/CORE and TA:K its five
// kingdoms without any hardcoding.
func (sess *Session) handleSandboxSides(w http.ResponseWriter, _ *http.Request) {
	out := []sandboxSideJSON{}
	for _, p := range []string{"gamedata/sidedata.tdf", "gamedata/SIDEDATA.tdf", "GameData/sidedata.tdf"} {
		data, err := sess.vfs.ReadFile(p)
		if err != nil {
			continue
		}
		var sd ta.SideData
		if err := tdf.Unmarshal(data, &sd); err != nil {
			continue
		}
		for i, s := range sd.Sides {
			name := strings.TrimSpace(s.Name)
			cmdr := strings.ToLower(strings.TrimSpace(s.Commander))
			// Only sides with a leader unit are playable — TA:K's sidedata
			// also lists LIFEFORMS / WANDERING_MONSTERS entries.
			if name == "" || cmdr == "" {
				continue
			}
			out = append(out, sandboxSideJSON{Index: i, Name: name, Commander: cmdr})
		}
		break
	}
	writeJSON(w, out)
}
