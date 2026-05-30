package tak

import "github.com/coreprime/kbot/formats/gamedata/common"

// Feature is one entry of a TA:Kingdoms features/*.tdf file. Each feature is a
// top-level [SECTION]; decode a file with
//
//	var features []tak.Feature
//	err := tdf.Unmarshal(data, &features)
//
// Fields shared with Total Annihilation live on the embedded common.FeatureBase;
// the fields below are unique to TA:Kingdoms.
type Feature struct {
	common.FeatureBase

	Animatable    int `tdf:"animatable,omitempty"`
	Resurrectable int `tdf:"resurrectable,omitempty"`
	NoShadow      int `tdf:"noshadow,omitempty"`
	IsStone       int `tdf:"isstone,omitempty"`
	IsFrozen      int `tdf:"isfrozen,omitempty"`
	IsBuilding    int `tdf:"isbuilding,omitempty"`

	DecomposeTime float64 `tdf:"decomposetime,omitempty"` // Assuming float, due to name/usage
	SacredSite    float64 `tdf:"sacredsite,omitempty"`    // Assuming float, due to name/usage

	SeqNameFrontFlame string `tdf:"seqnamefrontflame,omitempty"`
	SeqNameBackFlame  string `tdf:"seqnamebackflame,omitempty"`

	// Sound.
	SoundClass    string  `tdf:"soundclass,omitempty"`
	SoundDelay    float64 `tdf:"sounddelay,omitempty"`    // Assuming float, due to name/usage
	SoundVariance float64 `tdf:"soundvariance,omitempty"` // Assuming float, due to name/usage
}

// Feature satisfies the shared common.Feature interface via its embedded base.
var _ common.Feature = (*Feature)(nil)
