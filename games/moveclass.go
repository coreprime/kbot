// Movement-class resolution: the moveinfo.tdf bridge that applies a unit's
// [CLASSn] traversal profile onto its simulation stat block. Both games load
// classes at startup and resolve each unit's FBI `movementclass` name
// case-insensitively; when a class resolves, the unitdef's footprint and
// water/slope limits are copied FROM the class, replacing the FBI's own
// values entirely — moveinfo wins for everything it carries, and the FBI's
// [UNITINFO] copies of the same fields are only the fallback for classless
// units (which the plain FBI parse already covers).
package games

import (
	"strings"

	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/tdf"
)

// moveClassRec parses one [CLASSn] record with pointer fields so an omitted
// key is distinguishable from an explicit zero: the engines' class records
// initialise to defaults the loader only overwrites for keys present in the
// TDF, and the initialised water-depth/slope defaults are permissive (hover
// classes omit maxwaterdepth entirely and still ride any water; the spider
// class omits maxslope and climbs everything). The exact initialised values
// are unconfirmed (spec UNKNOWN-8); 255 — the u8 ceiling the same classes
// spell out for maxwaterslope — is the working inference.
type moveClassRec struct {
	Key           string `tdf:",name"`
	Name          string `tdf:"name,omitempty"`
	FootprintX    *int   `tdf:"footprintx,omitempty"`
	FootprintZ    *int   `tdf:"footprintz,omitempty"`
	MinWaterDepth *int   `tdf:"minwaterdepth,omitempty"`
	MaxWaterDepth *int   `tdf:"maxwaterdepth,omitempty"`
	MaxSlope      *int   `tdf:"maxslope,omitempty"`

	Remaining map[string]string `tdf:",remaining"`
}

// MovementClasses is the parsed moveinfo.tdf class table, keyed by
// upper-cased class name.
type MovementClasses map[string]*moveClassRec

// LoadMovementClasses parses raw moveinfo.tdf bytes into the class table.
func LoadMovementClasses(data []byte) (MovementClasses, error) {
	var recs []moveClassRec
	if err := tdf.Unmarshal(data, &recs); err != nil {
		return nil, err
	}
	out := MovementClasses{}
	for i := range recs {
		if n := strings.ToUpper(strings.TrimSpace(recs[i].Name)); n != "" {
			out[n] = &recs[i]
		}
	}
	return out, nil
}

// permissiveClassDefault is the inferred class-record initialisation value
// for the depth/slope limits a [CLASSn] omits (UNKNOWN-8).
const permissiveClassDefault = 255

// ApplyMovementClass resolves the meta's FBI movementclass name against the
// class table and, when it resolves, replaces the footprint and water/slope
// limits with the class's — present keys verbatim, omitted keys at the
// class-record defaults (footprint keeps the FBI's own when the class omits
// it; min depth 0; max depth and slope permissive). A classless unit, or an
// unknown name, keeps its FBI values untouched.
func ApplyMovementClass(m *sim.UnitMeta, classes MovementClasses) {
	if m == nil || m.MovementClass == "" || classes == nil {
		return
	}
	c := classes[strings.ToUpper(strings.TrimSpace(m.MovementClass))]
	if c == nil {
		return
	}
	if c.FootprintX != nil {
		m.FootprintX = *c.FootprintX
	}
	if c.FootprintZ != nil {
		m.FootprintZ = *c.FootprintZ
	}
	m.MinWaterDepth = 0
	if c.MinWaterDepth != nil {
		m.MinWaterDepth = *c.MinWaterDepth
	}
	m.MaxWaterDepth = permissiveClassDefault
	if c.MaxWaterDepth != nil {
		m.MaxWaterDepth = *c.MaxWaterDepth
	}
	m.MaxSlope = permissiveClassDefault
	if c.MaxSlope != nil {
		m.MaxSlope = *c.MaxSlope
	}
}
