package studio

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/objects3d"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/tdf"
)

// registerModelAPI wires the 3DO + texture endpoints into the shared mux.
// The endpoints are intentionally narrow: list, fetch geometry, fetch
// texture image — the heavy lifting (animation, scene assembly) lives
// in the browser's class-based renderer under web/game3d/.
func registerModelAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/studio/models", handleModelsList)
	mux.HandleFunc("/api/studio/model/", handleModelGeometry)
	mux.HandleFunc("/api/studio/texture/", handleTextureImage)
	mux.HandleFunc("/api/studio/palette", handlePaletteJSON)
	mux.HandleFunc("/api/studio/ground-tile/", handleGroundTile)
	mux.HandleFunc("/api/studio/buildpic/", handleBuildPic)
}

// ── /api/studio/models ─────────────────────────────────────────────────────

type modelEntry struct {
	Name          string `json:"name"`                    // canonical key (lowercased unit-name when FBI present, else 3DO basename)
	Path          string `json:"path"`                    // VFS path of the 3DO if known; "" when FBI references a missing 3DO
	UnitName      string `json:"unitName"`                // FBI [UNITINFO].UnitName (if a unit references this model)
	UnitTitle     string `json:"unitTitle"`               // FBI Name field (human-readable)
	Side          string `json:"side"`                    // ARM / CORE / etc.
	Description   string `json:"description"`             // FBI Description
	Category      string `json:"category"`                // FBI TEDClass
	DefaultGround string `json:"defaultGround,omitempty"` // recommended initial ground mode ("terrain" / "sea") inferred from the unit's environment hints
	// SubmersionMode: how the unit sits relative to the water plane.
	//   "surface"   = surface ship, hull boot-stripe at waterline
	//   "submerged" = submarine / underwater, top of unit below water
	//   ""          = no override, unit sits ON the water plane
	// Derived from FBI Category + TEDClass + WaterLine in
	// inferSubmersionMode below.
	SubmersionMode string `json:"submersionMode,omitempty"`
	// Presence flags — the UI renders coloured chips per row so the
	// user can see at a glance which related files actually shipped
	// in the loaded VFS for this unit.  A unit can be browsable
	// (FBI defines it + 3DO exists) even when the COB script is
	// absent (no animation, static display).
	HasFBI      bool `json:"hasFBI"`
	Has3DO      bool `json:"has3DO"`
	HasCOB      bool `json:"hasCOB"`
	HasBuildPic bool `json:"hasBuildPic"`
}

var (
	modelIndexMu   sync.Mutex
	modelIndexOnce sync.Once
	modelIndex     []modelEntry
	modelIndexByID map[string]modelEntry // keyed by lowercased name (no extension)
)

func ensureModelIndex() ([]modelEntry, map[string]modelEntry) {
	modelIndexOnce.Do(func() {
		buildModelIndex()
	})
	modelIndexMu.Lock()
	defer modelIndexMu.Unlock()
	return modelIndex, modelIndexByID
}

func buildModelIndex() {
	// Walk the VFS ONCE, partitioning by category, then merge the
	// FBI / 3DO / COB / build-pic indexes into modelEntries.  Walking
	// the whole VFS once is much cheaper than the previous "walk for
	// 3DOs, walk for FBIs" two-pass.
	type seenSet struct {
		threeDO  map[string]string // objbasename → 3DO vfs path
		cob      map[string]bool   // script basename → present
		buildPic map[string]bool   // unitname.pcx → present
		fbi      []string          // FBI vfs paths
	}
	seen := seenSet{
		threeDO:  map[string]string{},
		cob:      map[string]bool{},
		buildPic: map[string]bool{},
	}
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		switch {
		case strings.HasPrefix(lower, "objects3d/") && strings.HasSuffix(lower, ".3do"):
			base := strings.TrimSuffix(path.Base(lower), ".3do")
			if _, dup := seen.threeDO[base]; !dup {
				seen.threeDO[base] = p
			}
		case strings.HasPrefix(lower, "scripts/") && strings.HasSuffix(lower, ".cob"):
			seen.cob[strings.TrimSuffix(path.Base(lower), ".cob")] = true
		case strings.HasPrefix(lower, "unitpics/") && (strings.HasSuffix(lower, ".pcx") || strings.HasSuffix(lower, ".bmp") || strings.HasSuffix(lower, ".tga")):
			// Build pictures live under unitpics/.  Keyed by the
			// stem so a single map covers .pcx/.bmp/.tga variants.
			stem := path.Base(lower)
			stem = stem[:len(stem)-len(path.Ext(stem))]
			seen.buildPic[stem] = true
		case strings.HasPrefix(lower, "units/") && strings.HasSuffix(lower, ".fbi"):
			seen.fbi = append(seen.fbi, p)
		}
	}

	byID := make(map[string]modelEntry)

	// FBI is the source of truth — iterate each unit definition,
	// resolve its 3DO + COB references, attach build-pic presence.
	for _, p := range seen.fbi {
		data, err := vfs.ReadFile(p)
		if err != nil {
			continue
		}
		var u ta.Unit
		if err := tdf.Unmarshal(data, &u); err != nil {
			continue
		}
		info := &u.Info
		unitName := strings.TrimSpace(info.UnitName)
		obj := strings.ToLower(strings.TrimSpace(info.ObjectName))
		if unitName == "" && obj == "" {
			continue // not a unit section
		}
		key := strings.ToLower(unitName)
		if key == "" {
			key = obj
		}
		if _, dup := byID[key]; dup {
			continue
		}
		threePath := seen.threeDO[obj]
		entry := modelEntry{
			Name:           key,
			Path:           threePath,
			UnitName:       unitName,
			UnitTitle:      info.Name,
			Side:           info.Side,
			Description:    info.Description,
			Category:       info.TEDClass,
			DefaultGround:  inferDefaultGround(info),
			SubmersionMode: inferSubmersionMode(info),
			HasFBI:         true,
			Has3DO:         threePath != "",
			HasCOB:         seen.cob[key] || seen.cob[obj],
			HasBuildPic:    seen.buildPic[key] || seen.buildPic[obj] || seen.buildPic[strings.ToLower(unitName)],
		}
		byID[key] = entry
	}

	// Add any orphan 3DOs that no FBI references — props / features /
	// debug geometry the studio can still load even though they aren't
	// real units.  Keyed by the 3DO basename, with a synthetic entry
	// that reports HasFBI=false so the indicator chip shows accurately.
	for obj, threePath := range seen.threeDO {
		if _, claimed := byID[obj]; claimed {
			continue
		}
		// Also guard against an FBI whose UnitName == this obj basename.
		// (FBI iteration above already keyed by UnitName, but the obj
		// reference might differ in case.)
		alreadyByObj := false
		for _, e := range byID {
			if strings.EqualFold(e.Name, obj) || strings.EqualFold(strings.TrimSuffix(path.Base(strings.ToLower(e.Path)), ".3do"), obj) {
				alreadyByObj = true
				break
			}
		}
		if alreadyByObj {
			continue
		}
		byID[obj] = modelEntry{
			Name:        obj,
			Path:        threePath,
			HasFBI:      false,
			Has3DO:      true,
			HasCOB:      seen.cob[obj],
			HasBuildPic: seen.buildPic[obj],
		}
	}

	list := make([]modelEntry, 0, len(byID))
	for _, e := range byID {
		list = append(list, e)
	}
	// Real units (HasFBI) first, then orphan 3DOs.  Within each
	// group sort by side then name so ARM/CORE/etc. cluster cleanly.
	sort.Slice(list, func(i, j int) bool {
		if list[i].HasFBI != list[j].HasFBI {
			return list[i].HasFBI
		}
		if list[i].Side != list[j].Side {
			return list[i].Side < list[j].Side
		}
		return list[i].Name < list[j].Name
	})
	modelIndexMu.Lock()
	modelIndex = list
	modelIndexByID = byID
	modelIndexMu.Unlock()
}

func handleModelsList(w http.ResponseWriter, _ *http.Request) {
	list, _ := ensureModelIndex()
	writeJSON(w, map[string]any{"models": list})
}

// inferDefaultGround derives the initial ground render mode for a
// unit from its FBI metadata.  TA flags water-going units two ways:
// the TEDClass field (SHIP / SUB) and a non-empty water-depth range
// in MinWaterDepth / MaxWaterDepth.  Anything that screams "lives in
// the water" gets the Sea ground; everything else falls through to
// Terrain (which the client treats as the default when this field is
// empty).
func inferDefaultGround(info *ta.UnitInfo) string {
	ted := strings.ToUpper(strings.TrimSpace(info.TEDClass))
	switch ted {
	case "SHIP", "SUB", "UWMINE", "UWBLDG":
		return "sea"
	}
	// Category is a token list — e.g. ARMCOM has `ARM commander LEVEL10
	// WEAPON NOTAIR NOTSUB CTRL_C`.  A plain substring check matched the
	// `SUB` inside `NOTSUB` and shoved the Commander onto Sea; exact token
	// membership avoids that.
	tokens := categoryTokens(info.Category)
	for _, kw := range []string{"SHIP", "SUB", "UNDERWATER"} {
		if tokens[kw] {
			return "sea"
		}
	}
	// MinWaterDepth > 0 means the unit only spawns where there's at
	// least that much water (subs, water mines).  MaxWaterDepth > 0
	// without a paired land flag is also a strong "this lives in
	// water" signal — but it overlaps with hovercraft + the
	// Commander (who has MaxWaterDepth=35 because he can wade), so
	// we don't trust it on its own.
	if info.MinWaterDepth > 0 {
		return "sea"
	}
	return ""
}

// categoryTokens upper-cases a unit's already-tokenised Category list into a
// set for exact membership tests, avoiding the NOTSUB / NOTSHIP pitfall a
// plain substring check trips into.
func categoryTokens(cats []string) map[string]bool {
	out := make(map[string]bool)
	for _, t := range cats {
		out[strings.ToUpper(strings.TrimSpace(t))] = true
	}
	return out
}

// inferSubmersionMode classifies how the unit should sit relative
// to the water plane.  Lurker-style submarines have an explicit
// WaterLine (depth-below-water at which they ride) — typically 20
// for TA's subs — and almost always carry "UNDERWATER" in their
// Category.  Surface ships are TEDClass=SHIP with no WaterLine.
// Hovercraft / non-water units return "".
func inferSubmersionMode(info *ta.UnitInfo) string {
	ted := strings.ToUpper(strings.TrimSpace(info.TEDClass))
	tokens := categoryTokens(info.Category)
	// Submarine signals (in priority order):
	//   * Category explicitly tags UNDERWATER (TA's submarine units
	//     always include this).
	//   * TEDClass = SUB / UWMINE / UWBLDG.
	//   * WaterLine field present + non-trivial — TA uses this
	//     numeric field only for diving units; surface ships leave
	//     it blank.
	// Surface ship signals: TEDClass = SHIP, or Category contains
	// SHIP without UNDERWATER (so a "ship sub" wouldn't get
	// double-counted).  Anything else returns "" so the renderer
	// leaves the unit sitting ON the water.  Token-based matching
	// avoids the NOTSUB / NOTSHIP substring traps the Commander and
	// other walking units used to trigger.
	if tokens["UNDERWATER"] ||
		ted == "SUB" || ted == "UWMINE" || ted == "UWBLDG" ||
		info.WaterLine > 0 {
		return "submerged"
	}
	if ted == "SHIP" || tokens["SHIP"] {
		return "surface"
	}
	return ""
}

// ── /api/studio/model/{name} ───────────────────────────────────────────────

// modelJSON is the wire format consumed by the browser-side ModelLoader.
// Vertices are pre-divided by the 3DO fixed-point scale (1/65536) so the
// client gets pure float meshes; piece offsets are reported the same way
// so the hierarchy can be assembled with a straight translate.
type modelJSON struct {
	Name     string      `json:"name"`
	Root     *pieceJSON  `json:"root"`
	Pieces   []string    `json:"pieces"`   // flat list of piece names in DFS order
	Textures []string    `json:"textures"` // unique texture names referenced
	Decals   []string    `json:"decals"`   // subset of Textures known to carry alpha-keyed pixels (logos, glass, etc.) — clients render these last so they don't depth-occlude the opaque base when two primitives share a face
	// TextureSources maps each referenced texture name (lowercase)
	// to the basename of the GAF file it lives in (e.g.
	// "armhawk.gaf" or "kbot1.gaf").  Used by the Textures tab in
	// the model viewer to group textures by their source GAF so
	// the user can see which file each unit's atlas comes from.
	// Empty string when the texture wasn't found in any GAF (the
	// renderer's neutral-grey fallback will be used).
	TextureSources map[string]string `json:"textureSources,omitempty"`
	Bounds         *boundsJSON       `json:"bounds"` // axis-aligned bounds across the whole model in piece-local frames
}

type boundsJSON struct {
	Min [3]float32 `json:"min"`
	Max [3]float32 `json:"max"`
}

type pieceJSON struct {
	Name           string          `json:"name"`
	Origin         [3]float32      `json:"origin"`   // translation from parent (world units)
	Vertices       []float32       `json:"vertices"` // flat [x,y,z, x,y,z, ...]
	Primitives     []primitiveJSON `json:"primitives"`
	SelectionPrim  int32           `json:"selectionPrim"`
	Children       []*pieceJSON    `json:"children"`
	IsEmitterPoint bool            `json:"isEmitterPoint"` // vertex-only piece, used by COB emit-sfx/explode
}

type primitiveJSON struct {
	Indices     []uint16 `json:"indices"`
	Texture     string   `json:"texture,omitempty"`
	ColorIndex  int      `json:"colorIndex"`
	IsColored   bool     `json:"isColored"`
	VertexCount int      `json:"vertexCount"`        // 1=point, 2=line, 3=tri, 4+=polygon
	Synthetic   bool     `json:"synthetic,omitempty"` // reconstructed by FillModel, not original art
}

// scale3DO converts a 3DO fixed-point int32 to a world-space float.
// TA's convention is 65536 = 1 world unit; that puts ARMSY-class units
// around ~50 units across, which the client orbits comfortably.
const scale3DO = 1.0 / 65536.0

func handleModelGeometry(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/model/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing model name", http.StatusBadRequest)
		return
	}
	name = strings.ToLower(strings.TrimSuffix(name, ".3do"))
	_, byID := ensureModelIndex()
	entry, ok := byID[name]
	if !ok {
		http.Error(w, "model not found", http.StatusNotFound)
		return
	}
	data, err := vfs.ReadFile(entry.Path)
	if err != nil {
		http.Error(w, "read model: "+err.Error(), http.StatusInternalServerError)
		return
	}
	model, err := objects3d.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "parse model: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// ?enhanceMesh=1 reconstructs the faces TA's artists deleted as a
	// fill-rate optimisation (open box bottoms, hollow shells) so the unit
	// renders solid from every angle. Synthetic caps flow through the
	// normal primitive path below; the client treats them like any face.
	if r.URL.Query().Get("enhanceMesh") == "1" {
		objects3d.FillModel(model, objects3d.FillOptions{})
	}
	out := &modelJSON{Name: entry.Name}
	textures := map[string]bool{}
	pieceNames := []string{}
	bounds := &boundsJSON{
		Min: [3]float32{float32(1e9), float32(1e9), float32(1e9)},
		Max: [3]float32{float32(-1e9), float32(-1e9), float32(-1e9)},
	}
	var convert func(o *objects3d.Object, parentX, parentY, parentZ float32) *pieceJSON
	convert = func(o *objects3d.Object, parentX, parentY, parentZ float32) *pieceJSON {
		p := &pieceJSON{
			Name: o.Name,
			Origin: [3]float32{
				float32(o.XFromParent) * scale3DO,
				float32(o.YFromParent) * scale3DO,
				float32(o.ZFromParent) * scale3DO,
			},
			SelectionPrim: o.SelectionPrim,
		}
		pieceNames = append(pieceNames, o.Name)
		absX := parentX + p.Origin[0]
		absY := parentY + p.Origin[1]
		absZ := parentZ + p.Origin[2]
		p.Vertices = make([]float32, 0, len(o.Vertices)*3)
		for _, v := range o.Vertices {
			fx := float32(v.X) * scale3DO
			fy := float32(v.Y) * scale3DO
			fz := float32(v.Z) * scale3DO
			p.Vertices = append(p.Vertices, fx, fy, fz)
			// Bounding box is computed in world frame so the client can
			// frame the camera without re-walking the hierarchy.
			wx, wy, wz := absX+fx, absY+fy, absZ+fz
			if wx < bounds.Min[0] {
				bounds.Min[0] = wx
			}
			if wy < bounds.Min[1] {
				bounds.Min[1] = wy
			}
			if wz < bounds.Min[2] {
				bounds.Min[2] = wz
			}
			if wx > bounds.Max[0] {
				bounds.Max[0] = wx
			}
			if wy > bounds.Max[1] {
				bounds.Max[1] = wy
			}
			if wz > bounds.Max[2] {
				bounds.Max[2] = wz
			}
		}
		p.IsEmitterPoint = len(o.Primitives) == 0 && len(o.Vertices) == 1
		for _, prim := range o.Primitives {
			pj := primitiveJSON{
				Indices:     make([]uint16, len(prim.VertexIndices)),
				Texture:     prim.TextureName,
				ColorIndex:  prim.ColorIndex,
				IsColored:   prim.IsColored,
				VertexCount: len(prim.VertexIndices),
				Synthetic:   prim.Synthetic,
			}
			for i, idx := range prim.VertexIndices {
				if idx < 0 || idx > 65535 {
					pj.Indices[i] = 0
					continue
				}
				pj.Indices[i] = uint16(idx)
			}
			if prim.TextureName != "" {
				textures[strings.ToLower(prim.TextureName)] = true
			}
			p.Primitives = append(p.Primitives, pj)
		}
		for _, c := range o.Children {
			p.Children = append(p.Children, convert(c, absX, absY, absZ))
		}
		return p
	}
	out.Root = convert(model.Root, 0, 0, 0)
	// Resolve GAF source per texture so the Textures tab can group
	// by parent GAF.  Done now (one walk over the textures map)
	// instead of from the texture endpoint so the client has the
	// full picture in a single fetch.  Texture names not found in
	// the index map to "" so the client can group those as
	// "unknown / missing" — typical for stub textures the engine
	// would substitute with the default grey.
	texIdx := ensureTextureIndex()
	out.TextureSources = make(map[string]string)
	for t := range textures {
		out.Textures = append(out.Textures, t)
		if textureIsDecal(t) {
			out.Decals = append(out.Decals, t)
		}
		if src, ok := texIdx[t]; ok {
			out.TextureSources[t] = path.Base(src.GAFPath)
		} else {
			out.TextureSources[t] = ""
		}
	}
	sort.Strings(out.Textures)
	sort.Strings(out.Decals)
	out.Pieces = pieceNames
	// Guard against a model with no geometry — surface zeroed bounds so
	// the client's framing math doesn't blow up dividing by 1e9.
	if bounds.Min[0] > bounds.Max[0] {
		bounds.Min = [3]float32{0, 0, 0}
		bounds.Max = [3]float32{0, 0, 0}
	}
	out.Bounds = bounds
	w.Header().Set("Cache-Control", "public, max-age=3600")
	writeJSON(w, out)
}

// ── /api/studio/texture/{name} ─────────────────────────────────────────────

type textureSource struct {
	GAFPath   string
	SeqName   string
	UseShadow bool // true for texture sequences where the shadow palette index 0 should stay transparent
}

var (
	textureIndexOnce sync.Once
	textureIndexMu   sync.Mutex
	textureIndex     map[string]textureSource // lowercase texture name → source
	textureCacheMu   sync.Mutex
	textureCache     = map[string][]byte{}
	textureDecalMu   sync.Mutex
	textureDecalCache = map[string]bool{}
)

// textureIsDecal returns true when the named texture's GAF frame has any
// pixel matching its transparency index — i.e. when the renderer will
// need alpha-test to punch out those pixels.  Decals (logos, glass,
// rotor blur) carry transparent pixels so the underlying base-texture
// primitive needs to show through; opaque textures (the plain
// metal/noise tiles that cover most of a unit) have zero transparent
// pixels and are safe to render in any order.
//
// Memoised forever — the answer never changes during a server run.
func textureIsDecal(name string) bool {
	key := strings.ToLower(name)
	textureDecalMu.Lock()
	if v, ok := textureDecalCache[key]; ok {
		textureDecalMu.Unlock()
		return v
	}
	textureDecalMu.Unlock()

	src, ok := ensureTextureIndex()[key]
	if !ok {
		textureDecalMu.Lock()
		textureDecalCache[key] = false
		textureDecalMu.Unlock()
		return false
	}
	data, err := vfs.ReadFile(src.GAFPath)
	if err != nil {
		return false
	}
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return false
	}
	defer func() { _ = reader.Close() }()
	seqs, err := reader.ReadSequences()
	if err != nil {
		return false
	}
	// Texture rendering now forces all unit textures fully opaque,
	// so there are no real decals — keeping the list empty stops
	// the client from running its decal-specific bucket sort &
	// synthetic-base injection (which became a no-op anyway).
	hasAlpha := false
	_ = seqs
	textureDecalMu.Lock()
	textureDecalCache[key] = hasAlpha
	textureDecalMu.Unlock()
	return hasAlpha
}

func ensureTextureIndex() map[string]textureSource {
	textureIndexOnce.Do(func() {
		buildTextureIndex()
	})
	textureIndexMu.Lock()
	defer textureIndexMu.Unlock()
	return textureIndex
}

// buildTextureIndex walks every textures/*.gaf, recording the (GAF path,
// sequence name) pair that satisfies each texture name a 3DO might
// reference. Lazy + cached: each entry is read again on demand when a
// client asks for the actual PNG; sequence data isn't decoded here.
func buildTextureIndex() {
	idx := make(map[string]textureSource)
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "textures/") || !strings.HasSuffix(lower, ".gaf") {
			continue
		}
		data, err := vfs.ReadFile(p)
		if err != nil {
			continue
		}
		reader, err := gaf.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			continue
		}
		seqs, err := reader.ReadSequences()
		_ = reader.Close()
		if err != nil {
			continue
		}
		for _, s := range seqs {
			key := strings.ToLower(s.Name)
			if _, ok := idx[key]; ok {
				continue
			}
			idx[key] = textureSource{GAFPath: p, SeqName: s.Name, UseShadow: true}
		}
	}
	textureIndexMu.Lock()
	textureIndex = idx
	textureIndexMu.Unlock()
}

func handleTextureImage(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/texture/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing texture name", http.StatusBadRequest)
		return
	}
	name = strings.ToLower(strings.TrimSuffix(name, ".png"))

	textureCacheMu.Lock()
	cached, ok := textureCache[name]
	textureCacheMu.Unlock()
	if ok {
		serveTexturePNG(w, cached)
		return
	}

	idx := ensureTextureIndex()
	src, ok := idx[name]
	if !ok {
		// Fall back to a 1×1 neutral grey texture so the client can keep
		// rendering even when a 3DO references a missing or
		// mod-specific texture name.
		png := neutralTexturePNG()
		textureCacheMu.Lock()
		textureCache[name] = png
		textureCacheMu.Unlock()
		serveTexturePNG(w, png)
		return
	}

	pngBytes, err := renderTexturePNG(src)
	if err != nil {
		http.Error(w, "render texture: "+err.Error(), http.StatusInternalServerError)
		return
	}
	textureCacheMu.Lock()
	textureCache[name] = pngBytes
	textureCacheMu.Unlock()
	serveTexturePNG(w, pngBytes)
}

func serveTexturePNG(w http.ResponseWriter, data []byte) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}

func renderTexturePNG(src textureSource) ([]byte, error) {
	data, err := vfs.ReadFile(src.GAFPath)
	if err != nil {
		return nil, err
	}
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()
	seqs, err := reader.ReadSequences()
	if err != nil || len(seqs) == 0 {
		return nil, fmt.Errorf("no sequences in %s", src.GAFPath)
	}
	var target *gaf.Sequence
	for _, s := range seqs {
		if strings.EqualFold(s.Name, src.SeqName) {
			target = s
			break
		}
	}
	if target == nil {
		return nil, errors.New("sequence not found")
	}
	if len(target.Frames) == 0 {
		return nil, errors.New("sequence has no frames")
	}
	pal, err := gaf.LoadPaletteFromBytes(loadPaletteBytes())
	if err != nil {
		return nil, fmt.Errorf("load palette: %w", err)
	}
	// 3DO model textures are ALWAYS rendered fully opaque.  Unlike
	// sprite GAFs, the TA engine doesn't punch through unit textures
	// at the GAF's "transparency" index — palette[TI] is just another
	// colour for asphalt / panel base / etc.  Forcing TransparencyModeNone
	// fixes the long-running bug where runways and panel atlases let
	// the ground plane bleed through dense palette[TI] regions.
	opts := gaf.RenderOptions{Mode: gaf.TransparencyModeNone}
	var buf bytes.Buffer
	if err := target.Frames[0].ToPNGWith(pal, opts, &buf); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// neutralTexturePNG returns a tiny 2×2 grey PNG used as the fallback when
// the 3DO references a texture name we couldn't resolve. Two pixels (not
// one) so the GPU's bilinear sampler doesn't smear a single texel across
// the whole face when the renderer happens to be set to linear filtering.
func neutralTexturePNG() []byte {
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i+0] = 0x70
		img.Pix[i+1] = 0x70
		img.Pix[i+2] = 0x78
		img.Pix[i+3] = 0xff
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// ── /api/studio/ground-tile/{tileset} ──────────────────────────────────────

// handleGroundTile serves a single flat terrain tile as a PNG, used by
// the model viewer's "Terrain" ground mode.  The tileset name
// (greenworld, archipelago, lava, mars, metal, moon) maps to the
// flat/*.sct convention TA uses; we pick the first one that resolves
// so mods missing greenworld content still get something usable.
//
// We render the SCT's first tile rather than the whole tile-map: 32×32
// pixels of seamless terrain that the GPU can tile across the ground
// plane via CLAMP_TO_EDGE doesn't help us here, so it sets
// TEXTURE_WRAP_S/T to REPEAT on the client.
func handleGroundTile(w http.ResponseWriter, r *http.Request) {
	tileset := strings.ToLower(strings.TrimPrefix(r.URL.Path, "/api/studio/ground-tile/"))
	if tileset == "" {
		tileset = "greenworld"
	}
	// Probe the conventional location for flat tiles first; fall back
	// to whatever flat-named SCT we can find in that tileset so future
	// mods don't need a fixed filename.
	candidates := []string{
		fmt.Sprintf("sections/%s/flat/greenflat01.sct", tileset),
		fmt.Sprintf("sections/%s/flat/%sflat01.sct", tileset, strings.TrimSuffix(tileset, "world")),
	}
	var sctPath string
	for _, p := range candidates {
		if _, err := vfs.Stat(p); err == nil {
			sctPath = p
			break
		}
	}
	if sctPath == "" {
		// Walk the tileset's flat/ directory for any SCT.
		prefix := fmt.Sprintf("sections/%s/flat/", tileset)
		for _, p := range vfs.List() {
			if strings.HasPrefix(strings.ToLower(p), prefix) && strings.HasSuffix(strings.ToLower(p), ".sct") {
				sctPath = p
				break
			}
		}
	}
	if sctPath == "" {
		http.Error(w, "no flat tile for tileset "+tileset, http.StatusNotFound)
		return
	}
	data, err := vfs.ReadFile(sctPath)
	if err != nil {
		http.Error(w, "read tile: "+err.Error(), http.StatusInternalServerError)
		return
	}
	section, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "parse tile: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// First 32×32 tile of the section's tile grid — the same primitive
	// the studio map editor uses for stamping.  Smaller than the whole
	// tile-map, perfect for GPU-side REPEAT tiling.
	full := section.RenderTileMap(loadVFSPalette())
	tileW := 32
	tileH := 32
	if full.Bounds().Dx() < tileW {
		tileW = full.Bounds().Dx()
	}
	if full.Bounds().Dy() < tileH {
		tileH = full.Bounds().Dy()
	}
	tile := image.NewRGBA(image.Rect(0, 0, tileW, tileH))
	for y := 0; y < tileH; y++ {
		for x := 0; x < tileW; x++ {
			tile.Set(x, y, full.At(x, y))
		}
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_ = png.Encode(w, tile)
}

// ── /api/studio/palette ────────────────────────────────────────────────────

// handlePaletteJSON serves the active TA palette as a flat array of 256
// RGB triples (0..255 each). The browser-side renderer needs the palette
// in addition to texture pixels so it can resolve `IsColored` primitives
// (per-face flat colour, no UVs) without round-tripping back to the
// server for every shaded face.
func handlePaletteJSON(w http.ResponseWriter, _ *http.Request) {
	data := loadPaletteBytes()
	out := make([][3]int, 256)
	for i := 0; i < 256 && i*4+2 < len(data); i++ {
		out[i] = [3]int{int(data[i*4]), int(data[i*4+1]), int(data[i*4+2])}
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	writeJSON(w, map[string]any{"palette": out})
}

// ── /api/studio/buildpic/{name} ────────────────────────────────────────────

// handleBuildPic serves the unit's build picture as PNG.  TA ships
// these as PCX (most common) or occasionally BMP/TGA under
// unitpics/.  Returns 404 when no build pic is shipped — the JS
// picker renders a muted "no thumbnail" tile in that case.
func handleBuildPic(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/buildpic/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing buildpic name", http.StatusBadRequest)
		return
	}
	stem := strings.ToLower(strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(name, ".pcx"), ".bmp"), ".tga"))
	// Try the common variants in the order TA itself would.
	candidates := []string{
		"unitpics/" + stem + ".pcx",
		"unitpics/" + strings.ToUpper(stem) + ".PCX",
	}
	var data []byte
	for _, p := range candidates {
		if b, e := vfs.ReadFile(p); e == nil {
			data = b
			break
		}
	}
	if data == nil {
		// Last-ditch case-insensitive walk.
		want := strings.ToLower(stem + ".pcx")
		for _, p := range vfs.List() {
			lower := strings.ToLower(p)
			if !strings.HasPrefix(lower, "unitpics/") { continue }
			if strings.ToLower(path.Base(lower)) == want {
				if b, e := vfs.ReadFile(p); e == nil {
					data = b
					break
				}
			}
		}
	}
	if data == nil {
		http.Error(w, "build picture not found", http.StatusNotFound)
		return
	}
	rd, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "read pcx: "+err.Error(), http.StatusInternalServerError)
		return
	}
	img, err := rd.Decode()
	if err != nil {
		http.Error(w, "decode pcx: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	if err := png.Encode(w, img); err != nil {
		http.Error(w, "encode png: "+err.Error(), http.StatusInternalServerError)
	}
}
