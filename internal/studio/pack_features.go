package studio

// pack_features.go — the features.json side of a pack (format v5).
//
// A packed map lists its feature placements as (name, cell) pairs; this
// catalogue is the id → "what is this feature" table a renderer needs to
// stand something up at each cell: the category (trees / rocks / metal /
// corpses…), the footprint and height, the 3DO object name when the feature
// is a real model (wrecks, dragon teeth), and — for GAF-sprite features —
// the first frame's pixel size and hotspot so a stand-in can match the
// authored sprite's silhouette.  Like weapons.json it is a global catalogue:
// every features/*.tdf entry in the install is included so any map packed
// later (or a recording naming a corpse feature) resolves.

import (
	"bytes"
	"net/http"
	"sort"
	"strings"

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
)

// featureDefsForRenderer builds (once per session) the id → def catalogue the
// 3D renderer's map-feature stand-ins size, classify and texture themselves
// from. It reuses the pack catalogue builder — same footprints, heights, GAF
// sprite dims and 3DO object links — but stamps a live sprite handle on every
// FLAT ground feature (metal patches, geothermal vents, scars…) that carries
// GAF art, so the renderer paints the feature's real sprite onto the terrain
// as a decal instead of faking it (or, worse, standing it up as a 3D lump).
func (sess *Session) featureDefsForRenderer() map[string]packFeatureJSON {
	sess.featureDefsOnce.Do(func() {
		catalog, refs := sess.buildPackFeatureCatalog()
		for id, entry := range catalog {
			if !isFlatGroundFeature(entry) {
				continue
			}
			// game3d only takes the flat-decal path when the def carries a
			// sprite handle; stamp the id (resolved live via featureSprite →
			// the feature-preview endpoint) for flat features with real art.
			if ref, ok := refs[id]; ok && ref.Filename != "" && ref.SeqName != "" {
				entry.Sprite = id
				catalog[id] = entry
			}
		}
		sess.featureDefsCached = catalog
	})
	return sess.featureDefsCached
}

// handleFeatureDefs serves the live feature catalogue (game3d's featureDefs
// AssetProvider seam) keyed by lower-case feature id. Without it the renderer
// has no footprint/height/category per feature and falls back to tiny,
// mislabelled surrogates; with it trees stand at their real TA height, rocks
// at theirs, and flat resource sites render as ground decals.
func (sess *Session) handleFeatureDefs(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, sess.featureDefsForRenderer())
}

// packFeatureJSON is one features.json entry.  Footprints are in TA feature
// cells (16 px / 16 wu per cell); heightWU is the TDF height= (the LOS
// height, roughly world units).  Sprite fields are the GAF first frame's
// pixel geometry (1 px ≈ 1 wu at TA scale) — absent for object-only
// features, whose visual truth is the 3DO named by object.
type packFeatureJSON struct {
	ID          string `json:"id"`
	Category    string `json:"category,omitempty"`
	World       string `json:"world,omitempty"`
	FootprintX  int    `json:"footprintX,omitempty"`
	FootprintZ  int    `json:"footprintZ,omitempty"`
	HeightWU    int    `json:"heightWU,omitempty"`
	Object      string `json:"object,omitempty"`
	Animating   bool   `json:"animating,omitempty"`
	Blocking    bool   `json:"blocking,omitempty"`
	Reclaimable bool   `json:"reclaimable,omitempty"`
	// Indestructible marks a feature that can never be cleared or reclaimed
	// (metal deposits, geothermal vents, sacred stones). The sim treats it as
	// a build/movement obstacle, so the client uses it to decide whether a
	// pushed resource feature should occupy its plot.
	Indestructible bool `json:"indestructible,omitempty"`
	Permanent      bool `json:"permanent,omitempty"`
	// Geothermal marks a steam vent (featuredef geothermal=1): the heat source
	// a geothermal power plant must be founded over. Surfaced so the sandbox can
	// push the vent into the sim as a geothermal site for the build-legality
	// probe.
	Geothermal  bool    `json:"geothermal,omitempty"`
	Metal       float64 `json:"metal,omitempty"`
	Energy      float64 `json:"energy,omitempty"`
	FeatureDead string  `json:"featureDead,omitempty"`
	SpriteW     int     `json:"spriteW,omitempty"`
	SpriteH     int     `json:"spriteH,omitempty"`
	SpriteOX    int     `json:"spriteOX,omitempty"`
	SpriteOY    int     `json:"spriteOY,omitempty"`
	// Sprite is the packed PNG of the feature's first GAF frame with alpha
	// (featuresprites/<id>.png), extracted for FLAT ground features
	// (metal deposits, steam vents, scars, tracks, craters, holes) so the
	// renderer can paint the feature's real authored art onto the terrain
	// surface as a texture-conforming decal instead of faking it with
	// procedural geometry.  Empty for upright features (trees, rocks,
	// buildings…) which render as 3D stand-ins, and for object-only
	// features (their visual truth is the packed 3DO).
	Sprite string `json:"sprite,omitempty"`
}

// featureGafRef records the GAF file + sequence a feature's first frame
// lives in, so the pack write phase can extract its sprite PNG after the
// catalogue is built.  Keyed by lower-case feature id.
type featureGafRef struct {
	Filename string // anims/<filename>.gaf (no extension, lower-case)
	SeqName  string // sequence name within the GAF
}

// flatGroundFeatureCategories are the feature families TA draws as flat art
// laid into the ground — the ones the renderer paints as real-sprite decals
// rather than 3D stand-ins.  Kept in step with the game3d categoryBuilder's
// flat-decal routing (metal / vent / scar families).
var flatGroundFeatureCategories = map[string]bool{
	"metal":      true,
	"steamvents": true,
	"scars":      true,
	"smudges":    true,
	"tracks":     true,
	"craters":    true,
	"holes":      true,
}

// isFlatGroundFeature reports whether a feature (by category) should be
// packed as a real-sprite ground decal.  Object-bearing features never are
// — they render as their packed 3DO.
func isFlatGroundFeature(f packFeatureJSON) bool {
	if f.Object != "" {
		return false
	}
	return flatGroundFeatureCategories[f.Category]
}

// packFeaturesFileJSON is the features.json document shape — an object keyed
// by lower-case feature id (map keys marshal sorted, keeping the file
// deterministic for the pack content hash).
type packFeaturesFileJSON struct {
	Features map[string]packFeatureJSON `json:"features"`
}

// gafFrameDims caches one GAF file's sequences: lower-case sequence name →
// [w, h, originX, originY] of the first frame.
type gafFrameDims map[string][4]int

// buildPackFeatureCatalog walks every features/*.tdf in the VFS and returns
// the id → catalogue entry map.  Duplicate ids keep the first definition, the
// same rule the studio's feature scan applies.  GAF sprite dimensions are
// read once per referenced anims/<filename>.gaf.
func (sess *Session) buildPackFeatureCatalog() (map[string]packFeatureJSON, map[string]featureGafRef) {
	out := map[string]packFeatureJSON{}
	refs := map[string]featureGafRef{}
	gafCache := map[string]gafFrameDims{}
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
		for i := range features {
			f := &features[i]
			id := strings.ToLower(strings.TrimSpace(f.Key))
			if id == "" {
				continue
			}
			if _, dup := out[id]; dup {
				continue
			}
			entry := packFeatureJSON{
				ID:             id,
				Category:       strings.ToLower(strings.TrimSpace(f.Category)),
				World:          strings.ToLower(strings.TrimSpace(f.World)),
				FootprintX:     f.FootprintX,
				FootprintZ:     f.FootprintZ,
				HeightWU:       f.Height,
				Object:         strings.ToLower(strings.TrimSpace(f.Object)),
				Animating:      f.Animating != 0,
				Blocking:       f.Blocking != 0,
				Reclaimable:    f.Reclaimable != 0,
				Indestructible: f.Indestructible != 0,
				Permanent:      f.Permanent != 0,
				Geothermal:     f.Geothermal != 0,
				Metal:          f.Metal,
				Energy:         f.Energy,
				FeatureDead:    strings.ToLower(strings.TrimSpace(f.FeatureDead)),
			}
			if fn, sq := strings.TrimSpace(f.Filename), strings.TrimSpace(f.SeqName); fn != "" && sq != "" {
				if dims, ok := sess.featureGafDims(gafCache, fn)[strings.ToLower(sq)]; ok {
					entry.SpriteW = dims[0]
					entry.SpriteH = dims[1]
					entry.SpriteOX = dims[2]
					entry.SpriteOY = dims[3]
				}
				refs[id] = featureGafRef{Filename: strings.ToLower(fn), SeqName: sq}
			}
			out[id] = entry
		}
	}
	return out, refs
}

// packFeatureSprites extracts the first-frame PNG (with alpha) of every
// FLAT ground feature in the catalogue and writes it to
// featuresprites/<id>.png, stamping the entry's Sprite field.  Upright and
// object features are skipped (they render as 3D stand-ins / real 3DOs).
// Extraction is deterministic — the map walks in sorted id order and the
// PNG bytes are a pure function of the GAF frame + palette.
func (sess *Session) packFeatureSprites(catalog map[string]packFeatureJSON, refs map[string]featureGafRef, pw *packWriter, warnf func(string, ...any)) {
	ids := make([]string, 0, len(catalog))
	for id := range catalog {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		entry := catalog[id]
		if !isFlatGroundFeature(entry) {
			continue
		}
		ref, ok := refs[id]
		if !ok || ref.Filename == "" || ref.SeqName == "" {
			continue
		}
		pngBytes, err := sess.renderFeatureStaticPNG(ref.Filename, ref.SeqName)
		if err != nil {
			warnf("feature sprite %s: %v", id, err)
			continue
		}
		rel := "featuresprites/" + packStem(id) + ".png"
		if werr := pw.write(rel, pngBytes); werr != nil {
			warnf("write feature sprite %s: %v", id, werr)
			continue
		}
		entry.Sprite = rel
		catalog[id] = entry
	}
}

// featureGafDims loads (or returns the cached) sequence-dimension table for
// one anims/<filename>.gaf.  An unreadable file caches an empty table so the
// walk never retries it.
func (sess *Session) featureGafDims(cache map[string]gafFrameDims, filename string) gafFrameDims {
	key := strings.ToLower(filename)
	if dims, ok := cache[key]; ok {
		return dims
	}
	dims := gafFrameDims{}
	cache[key] = dims
	data, err := sess.vfs.ReadFile("anims/" + key + ".gaf")
	if err != nil {
		return dims
	}
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return dims
	}
	defer func() { _ = reader.Close() }()
	sequences, err := reader.ReadSequences()
	if err != nil {
		return dims
	}
	for _, s := range sequences {
		if len(s.Frames) == 0 {
			continue
		}
		fr := s.Frames[0]
		name := strings.ToLower(s.Name)
		if _, dup := dims[name]; dup {
			continue
		}
		dims[name] = [4]int{int(fr.Width), int(fr.Height), int(fr.OriginX), int(fr.OriginY)}
	}
	return dims
}
