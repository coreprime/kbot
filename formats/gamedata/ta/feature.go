package ta

import "github.com/coreprime/kbot/formats/gamedata/common"

// Feature is one entry of a features/*.tdf file. Each feature is a top-level
// [SECTION]; decode a file with
//
//	var features []ta.Feature
//	err := tdf.Unmarshal(data, &features)
//
// Fields shared with TA:Kingdoms live on the embedded common.FeatureBase; the
// fields below are unique to Total Annihilation.
type Feature struct {
	common.FeatureBase

	AutoReclaimable int `tdf:"autoreclaimable,omitempty"`
	NoDrawUndergray int `tdf:"nodrawundergray,omitempty"`
	Geothermal      int `tdf:"geothermal,omitempty"`
}

// Feature satisfies the shared common.Feature interface via its embedded base.
var _ common.Feature = (*Feature)(nil)
