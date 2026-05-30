package ta

import "github.com/coreprime/kbot/formats/gamedata/common"

// Side is a [SIDEn] section of gamedata/sidedata.tdf: the on-screen HUD layout
// and identity of one playable side (ARM, CORE). The many [LOGO], [ENERGYBAR],
// ... rectangle sub-sections are preserved generically in Regions.
type Side struct {
	Key string `tdf:",name"` // section header, e.g. SIDE0

	Name        string `tdf:"name,omitempty"`
	NamePrefix  string `tdf:"nameprefix,omitempty"`
	Commander   string `tdf:"commander,omitempty"`
	IntGAF      string `tdf:"intgaf,omitempty"`
	Font        string `tdf:"font,omitempty"`
	FontGUI     string `tdf:"fontgui,omitempty"`
	EnergyColor int    `tdf:"energycolor,omitempty"`
	MetalColor  int    `tdf:"metalcolor,omitempty"`

	// Regions holds the HUD rectangle sub-sections ([LOGO], [ENERGYBAR], ...),
	// each a { x1; y1; x2; y2; } block.
	Regions []common.Section `tdf:",sections"`

	// Remaining preserves any other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}
