package common

// GlobalHeaderBase is the set of [GlobalHeader] fields common to TA and
// TA:Kingdoms .ota map/mission files. Game-specific GlobalHeader types embed it
// and add their own fields (TA's Schema list, TA:Kingdoms' single Map Data
// block and kingdom metadata).
type GlobalHeaderBase struct {
	Key string `tdf:",name"` // section header, always GlobalHeader

	MissionName        string `tdf:"missionname,omitempty"`
	MissionDescription string `tdf:"missiondescription,omitempty"`
	Size               string `tdf:"size,omitempty"`
	Memory             string `tdf:"memory,omitempty"`
	UseOnlyUnits       string `tdf:"useonlyunits,omitempty"`

	LineOfSight int `tdf:"lineofsight,omitempty"`
	Mapping     int `tdf:"mapping,omitempty"`
	LavaWorld   int `tdf:"lavaworld,omitempty"`

	TidalStrength int `tdf:"tidalstrength,omitempty"`
	SolarStrength int `tdf:"solarstrength,omitempty"`
	MinWindSpeed  int `tdf:"minwindspeed,omitempty"`
	MaxWindSpeed  int `tdf:"maxwindspeed,omitempty"`
	Gravity       int `tdf:"gravity,omitempty"`

	KillMul int `tdf:"killmul,omitempty"`
	TimeMul int `tdf:"timemul,omitempty"`

	MaxUnits int `tdf:"maxunits,omitempty"`

	// NumPlayers is the set of supported player counts. Many maps list several
	// (e.g. "2, 3, 4") rather than a single number, so it is modelled as a list.
	NumPlayers []int `tdf:"numplayers,omitempty,delimiter=', '"`

	WaterDoesDamage int `tdf:"waterdoesdamage,omitempty"`
	WaterDamage     int `tdf:"waterdamage,omitempty"`

	// Remaining preserves every other key=value (per-player setup, victory and
	// trigger conditions) so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// GlobalHeader is the read interface satisfied by every game's [GlobalHeader]
// type via its embedded GlobalHeaderBase.
type GlobalHeader interface {
	GetKey() string
	GetMissionName() string
	GetMissionDescription() string
	GetSize() string
	GetMemory() string
	GetUseOnlyUnits() string
	GetLineOfSight() int
	GetMapping() int
	GetLavaWorld() int
	GetTidalStrength() int
	GetSolarStrength() int
	GetMinWindSpeed() int
	GetMaxWindSpeed() int
	GetGravity() int
	GetKillMul() int
	GetTimeMul() int
	GetMaxUnits() int
	GetNumPlayers() []int
	GetWaterDoesDamage() int
	GetWaterDamage() int
	GetRemaining() map[string]string
}

func (b *GlobalHeaderBase) GetKey() string                  { return b.Key }
func (b *GlobalHeaderBase) GetMissionName() string          { return b.MissionName }
func (b *GlobalHeaderBase) GetMissionDescription() string   { return b.MissionDescription }
func (b *GlobalHeaderBase) GetSize() string                 { return b.Size }
func (b *GlobalHeaderBase) GetMemory() string               { return b.Memory }
func (b *GlobalHeaderBase) GetUseOnlyUnits() string         { return b.UseOnlyUnits }
func (b *GlobalHeaderBase) GetLineOfSight() int             { return b.LineOfSight }
func (b *GlobalHeaderBase) GetMapping() int                 { return b.Mapping }
func (b *GlobalHeaderBase) GetLavaWorld() int               { return b.LavaWorld }
func (b *GlobalHeaderBase) GetTidalStrength() int           { return b.TidalStrength }
func (b *GlobalHeaderBase) GetSolarStrength() int           { return b.SolarStrength }
func (b *GlobalHeaderBase) GetMinWindSpeed() int            { return b.MinWindSpeed }
func (b *GlobalHeaderBase) GetMaxWindSpeed() int            { return b.MaxWindSpeed }
func (b *GlobalHeaderBase) GetGravity() int                 { return b.Gravity }
func (b *GlobalHeaderBase) GetKillMul() int                 { return b.KillMul }
func (b *GlobalHeaderBase) GetTimeMul() int                 { return b.TimeMul }
func (b *GlobalHeaderBase) GetMaxUnits() int                { return b.MaxUnits }
func (b *GlobalHeaderBase) GetNumPlayers() []int            { return b.NumPlayers }
func (b *GlobalHeaderBase) GetWaterDoesDamage() int         { return b.WaterDoesDamage }
func (b *GlobalHeaderBase) GetWaterDamage() int             { return b.WaterDamage }
func (b *GlobalHeaderBase) GetRemaining() map[string]string { return b.Remaining }
