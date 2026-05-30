package tak

import "github.com/coreprime/kbot/formats/gamedata/common"

// Map wraps a TA:Kingdoms mission/map .ota file, whose sole top-level section
// is [GlobalHeader]. Decode a file with
//
//	var m tak.Map
//	err := tdf.Unmarshal(data, &m)
type Map struct {
	Header GlobalHeader `tdf:"globalheader"`
}

// GlobalHeader is the [GlobalHeader] section of a TA:Kingdoms .ota file. Unlike
// Total Annihilation it carries a single [Map Data] block rather than a counted
// list of [Schema N] blocks. Fields shared with Total Annihilation live on the
// embedded common.GlobalHeaderBase; the fields below are unique to TA:Kingdoms.
type GlobalHeader struct {
	common.GlobalHeaderBase

	Kingdom   string `tdf:"kingdom,omitempty"`
	Copyright string `tdf:"copyright,omitempty"`
	IsMission int    `tdf:"ismission,omitempty"`

	MapData *MapData `tdf:"map data,omitempty"`
}

// GlobalHeader satisfies the shared common.GlobalHeader interface via its
// embedded base.
var _ common.GlobalHeader = (*GlobalHeader)(nil)

// MapData is the [Map Data] subsection of a TA:Kingdoms .ota file.
type MapData struct {
	Key string `tdf:",name"` // section header, always Map Data

	Type      string `tdf:"type,omitempty"`
	AIProfile string `tdf:"aiprofile,omitempty"`

	Specials *Specials `tdf:"specials,omitempty"`
	Units    *Units    `tdf:"units,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Specials is the [specials] subsection: start positions and scripted markers
// ([special0], [special1], ...).
type Specials struct {
	Items []Placement `tdf:"special"`

	// Remaining preserves any other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Units is the [units] subsection: pre-placed units ([unit0], [unit1], ...).
type Units struct {
	Items []Placement `tdf:"unit"`

	// Remaining preserves any other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Placement is one [specialN] or [unitN] entry on a TA:Kingdoms map.
type Placement struct {
	Key string `tdf:",name"` // section header, e.g. "unit0"

	SpecialWhat string `tdf:"specialwhat,omitempty"`
	UnitName    string `tdf:"unitname,omitempty"`

	XPos int `tdf:"xpos,omitempty"`
	YPos int `tdf:"ypos,omitempty"`
	ZPos int `tdf:"zpos,omitempty"`

	Player           int `tdf:"player,omitempty"`
	Kills            int `tdf:"kills,omitempty"`
	HealthPercentage int `tdf:"healthpercentage,omitempty"`
	ManaPercentage   int `tdf:"manapercentage,omitempty"`
	Angle            int `tdf:"angle,omitempty"`

	// Ident is a string because maps label placements with non-numeric ids
	// (e.g. "ABLE") as well as plain numbers.
	Ident string `tdf:"ident,omitempty"`

	InitialMission string `tdf:"initialmission,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}
