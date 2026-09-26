// Package mapmeta reads the map metadata kbot shows and checks with the
// game's rules, so the studio map editor, the sandbox, the asset explorer,
// `kbot tnt preview`, `kbot tnt lint` and the MCP tools all read a map the
// same way:
//
//   - start positions and schemas come from kbot-io's OTA game view
//     (ta.GlobalHeader.GameSchemas, ta.Schema.StartPositions): the game finds
//     Schema 0, Schema 1, ... up to the first missing number, matches
//     specialwhat=StartPos... ignoring case, keeps StartPos0 and numbers an
//     entry with no digits after the previous such entry;
//   - feature metal is the whole number the game stores (Atol, 16 bits), and
//     a feature name means its first definition across features/**.tdf.
package mapmeta

import (
	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot/internal/gamevfs"
	"sort"
	"strings"

	"github.com/coreprime/kbot-io/formats/gamedata/ta"
	"github.com/coreprime/kbot-io/formats/tdf"
)

// ReadOTA decodes a Total Annihilation .ota. It fails for text with no
// [GlobalHeader], which the game refuses as a map, and for text kbot-io
// cannot read at all (a '[' with no ']').
func ReadOTA(data []byte) (*ta.Map, error) {
	return ta.ReadMap(data)
}

// kingdomsOTA is the part of a TA: Kingdoms .ota that holds the map's
// setup: the [Map Data] section, which has a schema's layout (Type,
// aiprofile and a [specials] list of start positions).
type kingdomsOTA struct {
	Header struct {
		MapData *ta.Schema `tdf:"Map Data,omitempty"`
	} `tdf:"GlobalHeader"`
}

// KingdomsSetup reads the [Map Data] section of a TA: Kingdoms .ota as a
// schema, or returns nil when the file has none. Its start positions are in
// 16-pixel data units, not pixels.
func KingdomsSetup(data []byte) (*ta.Schema, error) {
	var k kingdomsOTA
	if err := tdf.Unmarshal(data, &k); err != nil {
		return nil, err
	}
	return k.Header.MapData, nil
}

// StartSchema returns the schema whose start positions kbot shows for a map
// when no schema is picked: the one a skirmish or multiplayer game uses
// (ta.GlobalHeader.MultiplayerSchema with no particular player count), or
// for a campaign mission the one it uses at medium difficulty. It returns nil
// when the game would use none.
func StartSchema(h *ta.GlobalHeader) *ta.Schema {
	if s := h.MultiplayerSchema(0); s != nil {
		return s
	}
	return h.CampaignSchema(1)
}

// GameSchema returns the schema the game finds as "Schema n", or nil when
// the game never reads one: after a gap in the numbering the game stops
// looking, so a later schema is not returned.
func GameSchema(h *ta.GlobalHeader, n int) *ta.Schema {
	schemas := h.GameSchemas()
	if n < 0 || n >= len(schemas) {
		return nil
	}
	return schemas[n]
}

// StartPositions returns a schema's start positions ordered by player slot
// (StartPos1 and StartPos0 both come first, as slot 0), keeping the file's
// order among positions that share a slot. A nil schema has none.
func StartPositions(s *ta.Schema) []ta.StartPosition {
	if s == nil {
		return nil
	}
	out := s.StartPositions()
	sort.SliceStable(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	return out
}

// FS is the part of a virtual filesystem FeatureMetal reads.
type FS interface {
	List() []string
	ReadFile(path string) ([]byte, error)
}

// featureFiles lists features/**.tdf in the order the game enumerates them
// when fs is a mounted game file system, else in fs's listing order.
func featureFiles(fs FS) []string {
	if v, ok := fs.(*filesystem.VirtualFileSystem); ok {
		return gamevfs.FeatureFiles(v)
	}
	var out []string
	for _, p := range fs.List() {
		lower := strings.ToLower(p)
		if strings.HasPrefix(lower, "features/") && strings.HasSuffix(lower, ".tdf") {
			out = append(out, p)
		}
	}
	return out
}

// FeatureMetal returns the metal of every feature that yields some, keyed by
// lower-cased feature name, from features/**.tdf in the listing order. The
// value is what the game stores (ta.Feature.EffectiveMetal): the whole number
// read with Atol, kept to 16 bits, so metal=56.8 is 56. A name defined more
// than once takes its first definition, as a map's feature does.
func FeatureMetal(fs FS) map[string]int {
	out := map[string]int{}
	if fs == nil {
		return out
	}
	seen := map[string]bool{}
	for _, p := range featureFiles(fs) {
		data, err := fs.ReadFile(p)
		if err != nil {
			continue
		}
		var features []ta.Feature
		if err := tdf.Unmarshal(data, &features); err != nil {
			continue
		}
		for i := range features {
			f := &features[i]
			key := strings.ToLower(strings.TrimSpace(f.Key))
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			if metal := f.EffectiveMetal(); metal > 0 {
				out[key] = metal
			}
		}
	}
	return out
}
