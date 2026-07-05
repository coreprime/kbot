package studio

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/objects3d"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/tdf"
)

// registerModelAPI wires the 3DO + texture endpoints into the shared mux.
// The endpoints are intentionally narrow: list, fetch geometry, fetch
// texture image — the heavy lifting (animation, scene assembly) lives
// in the browser's class-based renderer, @coreprime/kbot-game3d (packages-js/game3d).
func (sess *Session) registerModelAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/studio/models", sess.handleModelsList)
	mux.HandleFunc("/api/studio/model/", sess.handleModelGeometry)
	mux.HandleFunc("/api/studio/texture/", sess.handleTextureImage)
	mux.HandleFunc("/api/studio/palette", sess.handlePaletteJSON)
	mux.HandleFunc("/api/studio/ground-tile/", sess.handleGroundTile)
	mux.HandleFunc("/api/studio/buildpic/", sess.handleBuildPic)
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

func (sess *Session) ensureModelIndex() ([]modelEntry, map[string]modelEntry) {
	sess.modelIndexOnce.Do(func() {
		sess.buildModelIndex()
	})
	sess.modelIndexMu.Lock()
	defer sess.modelIndexMu.Unlock()
	return sess.modelIndex, sess.modelIndexByID
}

func (sess *Session) buildModelIndex() {
	// Walk the VFS ONCE, partitioning by category, then merge the
	// FBI / 3DO / COB / build-pic indexes into modelEntries.  Walking
	// the whole VFS once is much cheaper than the previous "walk for
	// 3DOs, walk for FBIs" two-pass.
	type seenSet struct {
		threeDO  map[string]string // objbasename → 3DO sess.vfs path
		cob      map[string]bool   // script basename → present
		buildPic map[string]bool   // unitname.pcx → present
		fbi      []string          // FBI sess.vfs paths
	}
	seen := seenSet{
		threeDO:  map[string]string{},
		cob:      map[string]bool{},
		buildPic: map[string]bool{},
	}
	for _, p := range sess.vfs.List() {
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
			// TA build pictures live under unitpics/.  Keyed by the
			// stem so a single map covers .pcx/.bmp/.tga variants.
			stem := path.Base(lower)
			stem = stem[:len(stem)-len(path.Ext(stem))]
			seen.buildPic[stem] = true
		case strings.HasPrefix(lower, "anims/buildpic/") && (strings.HasSuffix(lower, ".jpg") || strings.HasSuffix(lower, ".jpeg") || strings.HasSuffix(lower, ".pcx")):
			// TA:Kingdoms build pictures live under anims/buildpic/ as JPEGs.
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
		data, err := sess.vfs.ReadFile(p)
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
			SubmersionMode: sess.inferSubmersionMode(info),
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
	sess.modelIndexMu.Lock()
	sess.modelIndex = list
	sess.modelIndexByID = byID
	sess.modelIndexMu.Unlock()
}

func (sess *Session) handleModelsList(w http.ResponseWriter, _ *http.Request) {
	list, _ := sess.ensureModelIndex()
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
func (sess *Session) inferSubmersionMode(info *ta.UnitInfo) string {
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
	Name     string     `json:"name"`
	Root     *pieceJSON `json:"root"`
	Pieces   []string   `json:"pieces"`   // flat list of piece names in DFS order
	Textures []string   `json:"textures"` // unique texture names referenced
	Decals   []string   `json:"decals"`   // subset of Textures known to carry alpha-keyed pixels (logos, glass, etc.) — clients render these last so they don't depth-occlude the opaque base when two primitives share a face
	// TextureSources maps each referenced texture name (lowercase)
	// to the basename of the GAF file it lives in (e.g.
	// "armhawk.gaf" or "kbot1.gaf").  Used by the Textures tab in
	// the model viewer to group textures by their source GAF so
	// the user can see which file each unit's atlas comes from.
	// Empty string when the texture wasn't found in any GAF (the
	// renderer's neutral-grey fallback will be used).
	TextureSources map[string]string `json:"textureSources,omitempty"`
	// TextureQuery is the query string clients append to each
	// /api/studio/texture/<name> fetch so per-side texture names resolve
	// against this unit's own side GAF ("side=ara"); empty for TA.
	TextureQuery string      `json:"textureQuery,omitempty"`
	Bounds       *boundsJSON `json:"bounds"` // axis-aligned bounds across the whole model in piece-local frames
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
	VertexCount int      `json:"vertexCount"`         // 1=point, 2=line, 3=tri, 4+=polygon
	Synthetic   bool     `json:"synthetic,omitempty"` // reconstructed by FillModel, not original art
	// ColorRGB is the server-resolved colour for an IsColored face, looked
	// up through the game's palette resolver (TA: global palette; TA:K: the
	// unit's side palette). Without it the client falls back to indexing
	// its single global palette, which paints TA:K faces with TA colours.
	ColorRGB *[3]int `json:"colorRGB,omitempty"`
}

// scale3DO converts a 3DO fixed-point int32 to a world-space float.
// TA's convention is 65536 = 1 world unit; that puts ARMSY-class units
// around ~50 units across, which the client orbits comfortably.
const scale3DO = 1.0 / 65536.0

// resolveModelEntry resolves a model name against the FBI-driven index,
// falling back to a bare objects3d/<name>.3do lookup for wreck / feature
// 3DOs (corpse swaps, props) that ship without a unit definition.
func (sess *Session) resolveModelEntry(name string) (modelEntry, bool) {
	name = strings.ToLower(strings.TrimSuffix(name, ".3do"))
	_, byID := sess.ensureModelIndex()
	if entry, ok := byID[name]; ok {
		return entry, true
	}
	p := "objects3d/" + name + ".3do"
	if sess.vfs.Exists(p) {
		return modelEntry{Name: name, Path: p}, true
	}
	return modelEntry{}, false
}

func (sess *Session) handleModelGeometry(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/model/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing model name", http.StatusBadRequest)
		return
	}
	entry, ok := sess.resolveModelEntry(name)
	if !ok {
		http.Error(w, "model not found", http.StatusNotFound)
		return
	}
	out, err := sess.buildModelJSON(entry, r.URL.Query().Get("enhanceMesh") == "1")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	writeJSON(w, out)
}

// buildModelJSON parses a model entry's 3DO and converts it to the wire
// format the browser-side ModelLoader consumes. Shared by the live
// /api/studio/model endpoint and the static pack extractor so both emit
// byte-identical geometry.
func (sess *Session) buildModelJSON(entry modelEntry, enhanceMesh bool) (*modelJSON, error) {
	data, err := sess.vfs.ReadFile(entry.Path)
	if err != nil {
		return nil, fmt.Errorf("read model: %w", err)
	}
	model, err := objects3d.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse model: %w", err)
	}
	// enhanceMesh reconstructs the faces TA's artists deleted as a
	// fill-rate optimisation (open box bottoms, hollow shells) so the unit
	// renders solid from every angle. Synthetic caps flow through the
	// normal primitive path below; the client treats them like any face.
	if enhanceMesh {
		objects3d.FillModel(model, objects3d.FillOptions{})
	}
	out := &modelJSON{Name: entry.Name}
	// Per-game colour table for IsColored faces (TA:K resolves the unit's
	// side palette from its name prefix; TA uses the global palette).
	colorPal := sess.palettes().ModelColorPalette(entry.Name)
	texSide := sess.palettes().TextureSidePrefix(entry.Name)
	if texSide != "" {
		out.TextureQuery = "side=" + texSide
	}
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
			if prim.IsColored && prim.ColorIndex >= 0 && prim.ColorIndex < len(colorPal) {
				cr, cg, cb, _ := colorPal[prim.ColorIndex].RGBA()
				pj.ColorRGB = &[3]int{int(cr >> 8), int(cg >> 8), int(cb >> 8)}
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
	out.TextureSources = make(map[string]string)
	for t := range textures {
		out.Textures = append(out.Textures, t)
		if sess.textureIsDecal(t) {
			out.Decals = append(out.Decals, t)
		}
		if src, ok := sess.resolveTextureSource(t, texSide); ok {
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
	return out, nil
}

// ── /api/studio/texture/{name} ─────────────────────────────────────────────

type textureSource struct {
	GAFPath   string
	SeqName   string
	UseShadow bool // true for texture sequences where the shadow palette index 0 should stay transparent
}

// textureIsDecal returns true when the named texture's GAF frame has any
// pixel matching its transparency index — i.e. when the renderer will
// need alpha-test to punch out those pixels.  Decals (logos, glass,
// rotor blur) carry transparent pixels so the underlying base-texture
// primitive needs to show through; opaque textures (the plain
// metal/noise tiles that cover most of a unit) have zero transparent
// pixels and are safe to render in any order.
//
// Memoised forever — the answer never changes during a server run.
func (sess *Session) textureIsDecal(name string) bool {
	key := strings.ToLower(name)
	sess.textureDecalMu.Lock()
	if v, ok := sess.textureDecalCache[key]; ok {
		sess.textureDecalMu.Unlock()
		return v
	}
	sess.textureDecalMu.Unlock()

	src, ok := sess.ensureTextureIndex()[key]
	if !ok {
		sess.textureDecalMu.Lock()
		sess.textureDecalCache[key] = false
		sess.textureDecalMu.Unlock()
		return false
	}
	data, err := sess.vfs.ReadFile(src.GAFPath)
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
	sess.textureDecalMu.Lock()
	sess.textureDecalCache[key] = hasAlpha
	sess.textureDecalMu.Unlock()
	return hasAlpha
}

func (sess *Session) ensureTextureIndex() map[string]textureSource {
	sess.textureIndexOnce.Do(func() {
		sess.buildTextureIndex()
	})
	sess.textureIndexMu.Lock()
	defer sess.textureIndexMu.Unlock()
	return sess.textureIndex
}

// buildTextureIndex walks every textures/*.gaf, recording the (GAF path,
// sequence name) pair that satisfies each texture name a 3DO might
// reference. Lazy + cached: each entry is read again on demand when a
// client asks for the actual PNG; sequence data isn't decoded here.
func (sess *Session) buildTextureIndex() {
	idx := make(map[string]textureSource)
	all := make(map[string][]textureSource)
	for _, p := range sess.vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "textures/") || !strings.HasSuffix(lower, ".gaf") {
			continue
		}
		data, err := sess.vfs.ReadFile(p)
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
			src := textureSource{GAFPath: p, SeqName: s.Name, UseShadow: true}
			// TA:K ships same-named team/logo textures in every side's GAF;
			// keep every source so per-unit lookups can prefer the unit's own
			// side (see resolveTextureSource).
			all[key] = append(all[key], src)
			if _, ok := idx[key]; ok {
				continue
			}
			idx[key] = src
		}
	}
	sess.textureIndexMu.Lock()
	sess.textureIndex = idx
	sess.textureIndexAll = all
	sess.textureIndexMu.Unlock()
}

// resolveTextureSource resolves a texture name, preferring a GAF whose
// basename starts with the given side prefix (e.g. "ara"). Side-less callers
// (TA) get the default first-seen source.
func (sess *Session) resolveTextureSource(name, side string) (textureSource, bool) {
	idx := sess.ensureTextureIndex()
	sess.textureIndexMu.Lock()
	all := sess.textureIndexAll[name]
	sess.textureIndexMu.Unlock()
	if side != "" {
		for _, src := range all {
			if strings.HasPrefix(strings.ToLower(path.Base(src.GAFPath)), side) {
				return src, true
			}
		}
	}
	src, ok := idx[name]
	return src, ok
}

func (sess *Session) handleTextureImage(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/texture/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing texture name", http.StatusBadRequest)
		return
	}
	name = strings.ToLower(strings.TrimSuffix(name, ".png"))
	// ?side=<prefix> (TA:K): prefer the texture from that side's GAF when
	// several sides ship the same name (team logos, tunic colours).
	side := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("side")))
	cacheKey := name
	if side != "" {
		cacheKey = name + "|" + side
	}

	sess.textureCacheMu.Lock()
	cached, ok := sess.textureCache[cacheKey]
	sess.textureCacheMu.Unlock()
	if ok {
		serveTexturePNG(w, cached)
		return
	}

	src, ok := sess.resolveTextureSource(name, side)
	if !ok {
		// Fall back to a 1×1 neutral grey texture so the client can keep
		// rendering even when a 3DO references a missing or
		// mod-specific texture name.
		png := neutralTexturePNG()
		sess.textureCacheMu.Lock()
		sess.textureCache[cacheKey] = png
		sess.textureCacheMu.Unlock()
		serveTexturePNG(w, png)
		return
	}

	pngBytes, err := sess.renderTexturePNG(src, side)
	if err != nil {
		http.Error(w, "render texture: "+err.Error(), http.StatusInternalServerError)
		return
	}
	sess.textureCacheMu.Lock()
	sess.textureCache[cacheKey] = pngBytes
	sess.textureCacheMu.Unlock()
	serveTexturePNG(w, pngBytes)
}

func serveTexturePNG(w http.ResponseWriter, data []byte) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}

func (sess *Session) renderTexturePNG(src textureSource, side string) ([]byte, error) {
	data, err := sess.vfs.ReadFile(src.GAFPath)
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
	// The palette resolver picks the right table per game (TA: global;
	// TA:Kingdoms: the texture GAF's per-side palette) and the transparency
	// mode (TA: opaque — palette[TI] is a real colour; TA:K: punch out the
	// real transparent key, e.g. a dragon's magenta wings).
	pal := sess.palettes().TexturePalette(src.GAFPath)
	// The requesting unit's side palette beats the GAF-name-derived one:
	// TA:K logo art is shared across sides and takes its team colours from
	// the side palette of whoever wears it.
	if side != "" {
		if sp := sess.palettes().TexturePaletteForSide(side); sp != nil {
			pal = sp
		}
	}
	// See resolver.textureRenderOptions: TA forces opaque (palette[TI] is just
	// another colour for asphalt / panel base, and punching it out let the
	// ground plane bleed through runways); TA:Kingdoms resolves a real
	// transparent key so e.g. dragon wings read through.
	opts := sess.palettes().TextureRenderOptions(pal)
	// Serve unit textures as true-colour PNG with the transparent texels'
	// RGB bled from their opaque neighbours. An indexed PNG keeps the
	// colour-key's RGB (TA:K uses magenta) under alpha 0, and the GPU's
	// bilinear filter then smears pink fringes along every keyed edge.
	frameImg := target.Frames[0].ToImageWith(pal, opts)
	rgba := image.NewNRGBA(frameImg.Bounds())
	draw.Draw(rgba, rgba.Bounds(), frameImg, frameImg.Bounds().Min, draw.Src)
	// Bleed to completion: any transparent texel left with stale RGB still
	// tints mip levels, so dilate until every texel has a neighbour-derived
	// colour (texture tiles are small, the cost is microseconds).
	bleedTransparentRGB(rgba, rgba.Bounds().Dx()+rgba.Bounds().Dy())
	var buf bytes.Buffer
	if err := png.Encode(&buf, rgba); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// bleedTransparentRGB dilates opaque RGB into fully transparent pixels for a
// few passes so texture filtering (and mip generation) blends edge texels
// against their real neighbours instead of the punched-out colour key.
// Alpha is left untouched.
func bleedTransparentRGB(img *image.NRGBA, passes int) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	filled := make([]bool, w*h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			filled[y*w+x] = img.Pix[(y*img.Stride)+x*4+3] != 0
		}
	}
	for p := 0; p < passes; p++ {
		next := make([]bool, len(filled))
		copy(next, filled)
		changed := false
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				if filled[y*w+x] {
					continue
				}
				var r, g, bl, n int
				probe := func(nx, ny int) {
					if nx < 0 || ny < 0 || nx >= w || ny >= h || !filled[ny*w+nx] {
						return
					}
					o := ny*img.Stride + nx*4
					r += int(img.Pix[o])
					g += int(img.Pix[o+1])
					bl += int(img.Pix[o+2])
					n++
				}
				probe(x-1, y)
				probe(x+1, y)
				probe(x, y-1)
				probe(x, y+1)
				if n == 0 {
					continue
				}
				o := y*img.Stride + x*4
				img.Pix[o] = uint8(r / n)
				img.Pix[o+1] = uint8(g / n)
				img.Pix[o+2] = uint8(bl / n)
				next[y*w+x] = true
				changed = true
			}
		}
		filled = next
		if !changed {
			break
		}
	}
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
func (sess *Session) handleGroundTile(w http.ResponseWriter, r *http.Request) {
	tileset := strings.ToLower(strings.TrimPrefix(r.URL.Path, "/api/studio/ground-tile/"))
	if tileset == "" {
		tileset = "greenworld"
	}
	pngBytes, err := sess.renderGroundTilePNG(tileset)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(pngBytes)
}

// renderGroundTilePNG renders a tileset's seamless 32×32 flat-terrain tile.
// Shared by the live ground-tile endpoint and the pack extractor.
func (sess *Session) renderGroundTilePNG(tileset string) ([]byte, error) {
	// Probe the conventional location for flat tiles first; fall back
	// to whatever flat-named SCT we can find in that tileset so future
	// mods don't need a fixed filename.
	candidates := []string{
		fmt.Sprintf("sections/%s/flat/greenflat01.sct", tileset),
		fmt.Sprintf("sections/%s/flat/%sflat01.sct", tileset, strings.TrimSuffix(tileset, "world")),
	}
	var sctPath string
	for _, p := range candidates {
		if _, err := sess.vfs.Stat(p); err == nil {
			sctPath = p
			break
		}
	}
	if sctPath == "" {
		// Walk the tileset's flat/ directory for any SCT.
		prefix := fmt.Sprintf("sections/%s/flat/", tileset)
		for _, p := range sess.vfs.List() {
			if strings.HasPrefix(strings.ToLower(p), prefix) && strings.HasSuffix(strings.ToLower(p), ".sct") {
				sctPath = p
				break
			}
		}
	}
	if sctPath == "" {
		return nil, fmt.Errorf("no flat tile for tileset %s", tileset)
	}
	data, err := sess.vfs.ReadFile(sctPath)
	if err != nil {
		return nil, fmt.Errorf("read tile: %w", err)
	}
	section, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse tile: %w", err)
	}
	// First 32×32 tile of the section's tile grid — the same primitive
	// the studio map editor uses for stamping.  Smaller than the whole
	// tile-map, perfect for GPU-side REPEAT tiling.
	full := section.RenderTileMap(sess.loadVFSPalette())
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
	var buf bytes.Buffer
	if err := png.Encode(&buf, tile); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// ── /api/studio/palette ────────────────────────────────────────────────────

// handlePaletteJSON serves the active TA palette as a flat array of 256
// RGB triples (0..255 each). The browser-side renderer needs the palette
// in addition to texture pixels so it can resolve `IsColored` primitives
// (per-face flat colour, no UVs) without round-tripping back to the
// server for every shaded face.
func (sess *Session) handlePaletteJSON(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=86400")
	writeJSON(w, map[string]any{"palette": sess.paletteRGB()})
}

// paletteRGB returns the active palette as 256 RGB triples — the shape both
// the live palette endpoint and the pack's palette.json serialise.
func (sess *Session) paletteRGB() [][3]int {
	data := sess.loadPaletteBytes()
	out := make([][3]int, 256)
	for i := 0; i < 256 && i*4+2 < len(data); i++ {
		out[i] = [3]int{int(data[i*4]), int(data[i*4+1]), int(data[i*4+2])}
	}
	return out
}

// ── /api/studio/buildpic/{name} ────────────────────────────────────────────

// handleBuildPic serves the unit's build picture as PNG.  TA ships
// these as PCX (most common) or occasionally BMP/TGA under
// unitpics/.  Returns 404 when no build pic is shipped — the JS
// picker renders a muted "no thumbnail" tile in that case.
func (sess *Session) handleBuildPic(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/buildpic/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing buildpic name", http.StatusBadRequest)
		return
	}
	stem := strings.ToLower(strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(name, ".pcx"), ".bmp"), ".tga"))
	// Try the common variants in the order TA itself would.
	// TA stores build pics as unitpics/<unit>.pcx; TA:Kingdoms as
	// anims/buildpic/<unit>.jpg. Try both layouts (JPEG first since it's the
	// TA:K convention and self-describing).
	candidates := []string{
		"anims/buildpic/" + stem + ".jpg",
		"anims/buildpic/" + stem + ".jpeg",
		"unitpics/" + stem + ".pcx",
		"unitpics/" + strings.ToUpper(stem) + ".PCX",
		"anims/buildpic/" + stem + ".pcx",
	}
	var data []byte
	var found string
	for _, p := range candidates {
		if b, e := sess.vfs.ReadFile(p); e == nil {
			data, found = b, p
			break
		}
	}
	if data == nil {
		// Last-ditch case-insensitive walk over both build-pic locations.
		for _, p := range sess.vfs.List() {
			lower := strings.ToLower(p)
			if !strings.HasPrefix(lower, "unitpics/") && !strings.HasPrefix(lower, "anims/buildpic/") {
				continue
			}
			bn := strings.ToLower(path.Base(lower))
			ext := path.Ext(bn)
			if bn[:len(bn)-len(ext)] != strings.ToLower(stem) {
				continue
			}
			if ext == ".pcx" || ext == ".jpg" || ext == ".jpeg" {
				if b, e := sess.vfs.ReadFile(p); e == nil {
					data, found = b, p
					break
				}
			}
		}
	}
	if data == nil {
		http.Error(w, "build picture not found", http.StatusNotFound)
		return
	}
	img, err := decodeBuildPic(found, data)
	if err != nil {
		http.Error(w, "decode build pic: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	if err := png.Encode(w, img); err != nil {
		http.Error(w, "encode png: "+err.Error(), http.StatusInternalServerError)
	}
}

// decodeBuildPic decodes a build picture by extension: JPEG (TA:Kingdoms, full
// colour — no palette needed) or PCX (TA, palette embedded in the file).
func decodeBuildPic(srcPath string, data []byte) (image.Image, error) {
	if ext := strings.ToLower(path.Ext(srcPath)); ext == ".jpg" || ext == ".jpeg" {
		return jpeg.Decode(bytes.NewReader(data))
	}
	rd, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return rd.Decode()
}
