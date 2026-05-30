package tak

import "github.com/coreprime/kbot/formats/gamedata/common"

// MovementClass is one [CLASSn] section of gamedata/moveinfo.tdf. Decode the
// whole file with
//
//	var classes []tak.MovementClass
//	err := tdf.Unmarshal(data, &classes)
//
// Fields shared with Total Annihilation live on the embedded
// common.MovementClassBase; the field below is unique to TA:Kingdoms.
type MovementClass struct {
	common.MovementClassBase

	BadMinWaterDepth int `tdf:"badminwaterdepth,omitempty"`
}

// MovementClass satisfies the shared common.MovementClass interface via its
// embedded base.
var _ common.MovementClass = (*MovementClass)(nil)
