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

// SideData is the whole gamedata/sidedata.tdf document: the playable sides
// plus the [CANBUILD] construction table. (The lossless round-trip view stays
// []Side / []common.Section; this is the consumer-facing typed shape.)
type SideData struct {
	Sides    []Side   `tdf:"SIDE"`
	CanBuild CanBuild `tdf:"CANBUILD"`
}

// CanBuild is the [CANBUILD] table: one subsection per builder unit listing
// what it can construct.
type CanBuild struct {
	Builders []CanBuildBuilder `tdf:",sections"`
}

// CanBuildBuilder is one builder's subsection: the section name is the
// builder unit (e.g. [ARMCOM]) and its canbuild1..N keys list the buildable
// units in menu order. The numbered keys stay in the dynamic map — callers
// order by the numeric suffix.
type CanBuildBuilder struct {
	Name    string            `tdf:",name"`
	Entries map[string]string `tdf:",remaining"`
}
