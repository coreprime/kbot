package ta

import "github.com/coreprime/kbot/formats/gamedata/common"

// MovementClass is one [CLASSn] section of gamedata/moveinfo.tdf. Decode the
// whole file with
//
//	var classes []ta.MovementClass
//	err := tdf.Unmarshal(data, &classes)
//
// Total Annihilation uses only the fields shared with TA:Kingdoms, so it adds
// nothing to the embedded common.MovementClassBase.
type MovementClass struct {
	common.MovementClassBase
}

// MovementClass satisfies the shared common.MovementClass interface via its
// embedded base.
var _ common.MovementClass = (*MovementClass)(nil)
