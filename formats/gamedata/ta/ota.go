package ta

import "github.com/coreprime/kbot/formats/gamedata/common"

// Map wraps a mission/map .ota file, whose sole top-level section is
// [GlobalHeader]. Decode a file with
//
//	var m ta.Map
//	err := tdf.Unmarshal(data, &m)
type Map struct {
	Header GlobalHeader `tdf:"globalheader"`
}

// GlobalHeader is the [GlobalHeader] section of an .ota file: map metadata plus
// one or more start-position/resource [Schema N] blocks. Fields shared with
// TA:Kingdoms live on the embedded common.GlobalHeaderBase; the fields below
// are unique to Total Annihilation.
type GlobalHeader struct {
	common.GlobalHeaderBase

	MissionHint  string `tdf:"missionhint,omitempty"`
	Planet       string `tdf:"planet,omitempty"`
	Brief        string `tdf:"brief,omitempty"`
	Narration    string `tdf:"narration,omitempty"`
	Glamour      string `tdf:"glamour,omitempty"`
	GlamourSound string `tdf:"glamoursound,omitempty"`

	// SCHEMACOUNT in the file is the length of this slice; the codec emits it.
	Schemas []Schema `tdf:"Schema,repeats=SCHEMACOUNT"`
}

// GlobalHeader satisfies the shared common.GlobalHeader interface via its
// embedded base.
var _ common.GlobalHeader = (*GlobalHeader)(nil)

// Schema is one [Schema N] block of an .ota file: a per-difficulty resource and
// start-position configuration.
type Schema struct {
	Key string `tdf:",name"` // section header, e.g. "Schema 0"

	Type      string `tdf:"type,omitempty"`
	AIProfile string `tdf:"aiprofile,omitempty"`

	SurfaceMetal   int `tdf:"surfacemetal,omitempty"`
	MohoMetal      int `tdf:"mohometal,omitempty"`
	HumanMetal     int `tdf:"humanmetal,omitempty"`
	ComputerMetal  int `tdf:"computermetal,omitempty"`
	HumanEnergy    int `tdf:"humanenergy,omitempty"`
	ComputerEnergy int `tdf:"computerenergy,omitempty"`

	MeteorWeapon   string  `tdf:"meteorweapon,omitempty"`
	MeteorRadius   int     `tdf:"meteorradius,omitempty"`
	MeteorDensity  float64 `tdf:"meteordensity,omitempty"` // Assuming float, due to name/usage
	MeteorDuration int     `tdf:"meteorduration,omitempty"`
	MeteorInterval int     `tdf:"meteorinterval,omitempty"`

	Specials *Specials `tdf:"specials,omitempty"`
	Units    *Units    `tdf:"units,omitempty"`
	Features *Features `tdf:"features,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Specials is the [specials] subsection of a schema: a list of placed units,
// features and start positions ([special0], [special1], ...).
type Specials struct {
	Items []Special `tdf:"special"`

	// Remaining preserves any other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Units is the [units] subsection of a schema: pre-placed units ([unit0],
// [unit1], ...). Entries share the placement fields of Special.
type Units struct {
	Items []Special `tdf:"unit"`

	// Remaining preserves any other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Features is the [features] subsection of a schema: pre-placed features
// ([feature0], [feature1], ...). Entries share the placement fields of Special.
type Features struct {
	Items []Special `tdf:"feature"`

	// Remaining preserves any other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Special is one [specialN] entry: a unit, feature or start position placed on
// the map.
type Special struct {
	Key string `tdf:",name"` // section header, e.g. "special0"

	SpecialWhat string `tdf:"specialwhat,omitempty"`
	UnitName    string `tdf:"unitname,omitempty"`
	FeatureName string `tdf:"featurename,omitempty"`

	XPos int `tdf:"xpos,omitempty"`
	YPos int `tdf:"ypos,omitempty"`
	ZPos int `tdf:"zpos,omitempty"`

	Player           int `tdf:"player,omitempty"`
	Kills            int `tdf:"kills,omitempty"`
	HealthPercentage int `tdf:"healthpercentage,omitempty"`
	Angle            int `tdf:"angle,omitempty"`

	// Ident, InitialGroup and BuildPriority are strings because maps use
	// non-numeric labels for them (e.g. ident "AIRHEAD", group "patrol",
	// buildpriority "CORHRK") as well as plain numbers.
	Ident         string `tdf:"ident,omitempty"`
	InitialGroup  string `tdf:"initialgroup,omitempty"`
	BuildPriority string `tdf:"buildpriority,omitempty"`

	InitialMission    string `tdf:"initialmission,omitempty"`
	CreationCountdown int    `tdf:"creationcountdown,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}
