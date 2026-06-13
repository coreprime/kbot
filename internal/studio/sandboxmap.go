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
	// SlopeScalePct scales unit MaxSlope onto this heightmap's per-cell delta
	// scale (see sim.Terrain). TA's coarse attribute grid → 40; TA:K's native,
	// far steeper heightmap → 100, or its GROUND units can't climb island edges.
	SlopeScalePct int `json:"slopeScalePct"`
	SeaLevel      int `json:"seaLevel"`
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
}

type sandboxStartPos struct {
	Number int     `json:"number"`
	X      float64 `json:"x"`
	Z      float64 `json:"z"`
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

	// TA:K's native heightmap runs ~2.5x steeper per cell than TA's attribute
	// grid, so it takes MaxSlope at full scale; TA keeps the 2/5 calibration.
	slopeScalePct := 40
	if m.IsTAK {
		slopeScalePct = 100
	}
	out := sandboxMapJSON{
		Path:          mapPath,
		Name:          strings.TrimSuffix(path.Base(mapPath), path.Ext(mapPath)),
		CellWU:        sandboxCellWU,
		HeightScale:   sandboxHeightScale,
		SlopeScalePct: slopeScalePct,
		TextureURL:    "/api/studio/sandbox-map-texture?path=" + mapPath,
		MinimapURL:    "/api/studio/minimap/" + mapPath,
	}
	var heights []byte
	if m.IsTAK {
		out.W, out.H = m.TAKW, m.TAKH
		heights = make([]byte, len(m.TAKHeight))
		copy(heights, m.TAKHeight)
	} else {
		out.W, out.H = m.AttrW, m.AttrH
		out.SeaLevel = int(m.Header.SeaLevel)
		heights = make([]byte, len(m.TileAttr))
		voids := make([]byte, len(m.TileAttr))
		anyVoid := false
		for i, a := range m.TileAttr {
			heights[i] = a.Height
			if a.Feature == 0xFFFC {
				voids[i] = 1
				anyVoid = true
			}
		}
		if anyVoid {
			out.Voids = base64.StdEncoding.EncodeToString(voids)
		}
	}
	if len(heights) < out.W*out.H || out.W == 0 || out.H == 0 {
		http.Error(w, "map has no usable heightmap", http.StatusUnprocessableEntity)
		return
	}
	out.WorldW = float64(out.W) * sandboxCellWU
	out.WorldH = float64(out.H) * sandboxCellWU
	out.Heights = base64.StdEncoding.EncodeToString(heights)

	// OTA — sea level (TA:K, where the TNT field is repurposed) and the
	// first schema's start positions, converted map-pixels → world units.
	otaPath := strings.TrimSuffix(mapPath, path.Ext(mapPath)) + ".ota"
	if otaData, err := sess.vfs.ReadFile(otaPath); err == nil {
		if ota := parseOTA(string(otaData), out.W/2, out.H/2); ota != nil {
			if m.IsTAK || out.SeaLevel == 0 {
				out.SeaLevel = ota.SeaLevel
			}
			if len(ota.Schemas) > 0 {
				for _, sp := range ota.Schemas[0].StartPos {
					out.StartPositions = append(out.StartPositions, sandboxStartPos{
						Number: sp.Number,
						X:      float64(sp.X) / pxPerWU,
						Z:      float64(sp.Z) / pxPerWU,
					})
				}
			}
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
	maxDim := 2048
	if v, err := strconv.Atoi(r.URL.Query().Get("max")); err == nil && v >= 256 && v <= 8192 {
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
