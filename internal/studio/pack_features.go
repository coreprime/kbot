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
	"strings"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/tdf"
)

// packFeatureJSON is one features.json entry.  Footprints are in TA feature
// cells (16 px / 16 wu per cell); heightWU is the TDF height= (the LOS
// height, roughly world units).  Sprite fields are the GAF first frame's
// pixel geometry (1 px ≈ 1 wu at TA scale) — absent for object-only
// features, whose visual truth is the 3DO named by object.
type packFeatureJSON struct {
	ID          string  `json:"id"`
	Category    string  `json:"category,omitempty"`
	World       string  `json:"world,omitempty"`
	FootprintX  int     `json:"footprintX,omitempty"`
	FootprintZ  int     `json:"footprintZ,omitempty"`
	HeightWU    int     `json:"heightWU,omitempty"`
	Object      string  `json:"object,omitempty"`
	Animating   bool    `json:"animating,omitempty"`
	Blocking    bool    `json:"blocking,omitempty"`
	Reclaimable bool    `json:"reclaimable,omitempty"`
	Permanent   bool    `json:"permanent,omitempty"`
	Metal       float64 `json:"metal,omitempty"`
	Energy      float64 `json:"energy,omitempty"`
	FeatureDead string  `json:"featureDead,omitempty"`
	SpriteW     int     `json:"spriteW,omitempty"`
	SpriteH     int     `json:"spriteH,omitempty"`
	SpriteOX    int     `json:"spriteOX,omitempty"`
	SpriteOY    int     `json:"spriteOY,omitempty"`
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
func (sess *Session) buildPackFeatureCatalog() map[string]packFeatureJSON {
	out := map[string]packFeatureJSON{}
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
				ID:          id,
				Category:    strings.ToLower(strings.TrimSpace(f.Category)),
				World:       strings.ToLower(strings.TrimSpace(f.World)),
				FootprintX:  f.FootprintX,
				FootprintZ:  f.FootprintZ,
				HeightWU:    f.Height,
				Object:      strings.ToLower(strings.TrimSpace(f.Object)),
				Animating:   f.Animating != 0,
				Blocking:    f.Blocking != 0,
				Reclaimable: f.Reclaimable != 0,
				Permanent:   f.Permanent != 0,
				Metal:       f.Metal,
				Energy:      f.Energy,
				FeatureDead: strings.ToLower(strings.TrimSpace(f.FeatureDead)),
			}
			if fn, sq := strings.TrimSpace(f.Filename), strings.TrimSpace(f.SeqName); fn != "" && sq != "" {
				if dims, ok := sess.featureGafDims(gafCache, fn)[strings.ToLower(sq)]; ok {
					entry.SpriteW = dims[0]
					entry.SpriteH = dims[1]
					entry.SpriteOX = dims[2]
					entry.SpriteOY = dims[3]
				}
			}
			out[id] = entry
		}
	}
	return out
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
