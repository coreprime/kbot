package ta

import "github.com/coreprime/kbot/formats/gamedata/common"

// Side is a [SIDEn] section of gamedata/sidedata.tdf: the on-screen HUD layout
// and identity of one playable side (ARM, CORE). The many [LOGO], [ENERGYBAR],
// ... rectangle sub-sections are preserved generically in Regions. Fields shared
// with TA:Kingdoms live on the embedded common.SideBase.
type Side struct {
	common.SideBase

	IntGAF      string `tdf:"intgaf,omitempty"`
	Font        string `tdf:"font,omitempty"`
	FontGUI     string `tdf:"fontgui,omitempty"`
	EnergyColor int    `tdf:"energycolor,omitempty"`
	MetalColor  int    `tdf:"metalcolor,omitempty"`

	// Regions holds the HUD rectangle sub-sections ([LOGO], [ENERGYBAR], ...),
	// each a { x1; y1; x2; y2; } block.
	Regions []common.Section `tdf:",sections"`
}

// Side satisfies the shared common.Side interface via its embedded base.
var _ common.Side = (*Side)(nil)
