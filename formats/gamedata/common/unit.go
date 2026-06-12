package common

// UnitInfoBase is the set of [UNITINFO] fields common to TA and TA:Kingdoms
// unit .fbi files. Game-specific UnitInfo types embed it and add their own
// fields (resource economy, mana, localisation, nested adjust sections, ...).
type UnitInfoBase struct {
	Key string `tdf:",name"` // section header, always UNITINFO

	UnitName    string  `tdf:"unitname,omitempty"`
	Version     float64 `tdf:"version,omitempty"` // Assuming float, due to name/usage
	Side        string  `tdf:"side,omitempty"`
	ObjectName  string  `tdf:"objectname,omitempty"`
	Name        string  `tdf:"name,omitempty"`
	Description string  `tdf:"description,omitempty"`
	UnitNumber  int     `tdf:"unitnumber,omitempty"`
	Copyright   string  `tdf:"copyright,omitempty"`
	TEDClass    string  `tdf:"tedclass,omitempty"`

	// Category is a space-separated list of capability/role flags
	// (e.g. "ARM KBOT LEVEL2 WEAPON NOTAIR").
	Category []string `tdf:"category,omitempty"`

	FootprintX int `tdf:"footprintx,omitempty"`
	FootprintZ int `tdf:"footprintz,omitempty"`
	BuildAngle int `tdf:"buildangle,omitempty"`

	WorkerTime        int `tdf:"workertime,omitempty"`
	BuildDistance     int `tdf:"builddistance,omitempty"`
	ActivateWhenBuilt int `tdf:"activatewhenbuilt,omitempty"`

	MaxDamage     int     `tdf:"maxdamage,omitempty"`
	MaxWaterDepth int     `tdf:"maxwaterdepth,omitempty"`
	MaxSlope      int     `tdf:"maxslope,omitempty"`
	WaterLine     float64 `tdf:"waterline,omitempty"` // Assuming float, due to name/usage

	SightDistance int    `tdf:"sightdistance,omitempty"`
	RadarDistance int    `tdf:"radardistance,omitempty"`
	SonarDistance int    `tdf:"sonardistance,omitempty"`
	BMcode        int    `tdf:"bmcode,omitempty"`
	ShootMe       int    `tdf:"shootme,omitempty"`
	SoundCategory string `tdf:"soundcategory,omitempty"`
	Corpse        string `tdf:"corpse,omitempty"`

	// Movement.
	MovementClass       string  `tdf:"movementclass,omitempty"`
	MaxVelocity         float64 `tdf:"maxvelocity,omitempty"`  // Assuming float, due to name/usage
	Acceleration        float64 `tdf:"acceleration,omitempty"` // Assuming float, due to name/usage
	BrakeRate           float64 `tdf:"brakerate,omitempty"`    // Assuming float, due to name/usage
	TurnRate            int     `tdf:"turnrate,omitempty"`
	ManeuverLeashLength int     `tdf:"maneuverleashlength,omitempty"`
	BankScale           float64 `tdf:"bankscale,omitempty"`  // Assuming float, due to name/usage
	PitchScale          float64 `tdf:"pitchscale,omitempty"` // Assuming float, due to name/usage
	Upright             int     `tdf:"upright,omitempty"`

	// Aircraft.
	CanFly    int     `tdf:"canfly,omitempty"`
	CruiseAlt float64 `tdf:"cruisealt,omitempty"` // Assuming float, due to name/usage
	Floater   int     `tdf:"floater,omitempty"`
	CanHover  int     `tdf:"canhover,omitempty"`

	// Orders / behaviour flags.
	CanMove            int    `tdf:"canmove,omitempty"`
	CanStop            int    `tdf:"canstop,omitempty"`
	CanPatrol          int    `tdf:"canpatrol,omitempty"`
	CanGuard           int    `tdf:"canguard,omitempty"`
	CanAttack          int    `tdf:"canattack,omitempty"`
	Builder            int    `tdf:"builder,omitempty"`
	DefaultMissionType string `tdf:"defaultmissiontype,omitempty"`

	YardMap string `tdf:"yardmap,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// UnitInfo is the read interface satisfied by every game's [UNITINFO] type via
// its embedded UnitInfoBase.
type UnitInfo interface {
	GetKey() string
	GetUnitName() string
	GetVersion() float64
	GetSide() string
	GetObjectName() string
	GetName() string
	GetDescription() string
	GetUnitNumber() int
	GetCopyright() string
	GetTEDClass() string
	GetCategory() []string
	GetFootprintX() int
	GetFootprintZ() int
	GetBuildAngle() int
	GetWorkerTime() int
	GetBuildDistance() int
	GetMaxDamage() int
	GetMaxWaterDepth() int
	GetMaxSlope() int
	GetWaterLine() float64
	GetSightDistance() int
	GetRadarDistance() int
	GetSonarDistance() int
	GetBMcode() int
	GetShootMe() int
	GetSoundCategory() string
	GetCorpse() string
	GetMovementClass() string
	GetMaxVelocity() float64
	GetAcceleration() float64
	GetBrakeRate() float64
	GetTurnRate() int
	GetManeuverLeashLength() int
	GetBankScale() float64
	GetPitchScale() float64
	GetUpright() int
	GetCanFly() int
	GetCruiseAlt() float64
	GetFloater() int
	GetCanHover() int
	GetCanMove() int
	GetCanStop() int
	GetCanPatrol() int
	GetCanGuard() int
	GetCanAttack() int
	GetBuilder() int
	GetDefaultMissionType() string
	GetYardMap() string
	GetRemaining() map[string]string
}

func (b *UnitInfoBase) GetKey() string                  { return b.Key }
func (b *UnitInfoBase) GetUnitName() string             { return b.UnitName }
func (b *UnitInfoBase) GetVersion() float64             { return b.Version }
func (b *UnitInfoBase) GetSide() string                 { return b.Side }
func (b *UnitInfoBase) GetObjectName() string           { return b.ObjectName }
func (b *UnitInfoBase) GetName() string                 { return b.Name }
func (b *UnitInfoBase) GetDescription() string          { return b.Description }
func (b *UnitInfoBase) GetUnitNumber() int              { return b.UnitNumber }
func (b *UnitInfoBase) GetCopyright() string            { return b.Copyright }
func (b *UnitInfoBase) GetTEDClass() string             { return b.TEDClass }
func (b *UnitInfoBase) GetCategory() []string           { return b.Category }
func (b *UnitInfoBase) GetFootprintX() int              { return b.FootprintX }
func (b *UnitInfoBase) GetFootprintZ() int              { return b.FootprintZ }
func (b *UnitInfoBase) GetBuildAngle() int              { return b.BuildAngle }
func (b *UnitInfoBase) GetWorkerTime() int              { return b.WorkerTime }
func (b *UnitInfoBase) GetBuildDistance() int           { return b.BuildDistance }
func (b *UnitInfoBase) GetMaxDamage() int               { return b.MaxDamage }
func (b *UnitInfoBase) GetMaxWaterDepth() int           { return b.MaxWaterDepth }
func (b *UnitInfoBase) GetMaxSlope() int                { return b.MaxSlope }
func (b *UnitInfoBase) GetWaterLine() float64           { return b.WaterLine }
func (b *UnitInfoBase) GetSightDistance() int           { return b.SightDistance }
func (b *UnitInfoBase) GetRadarDistance() int           { return b.RadarDistance }
func (b *UnitInfoBase) GetSonarDistance() int           { return b.SonarDistance }
func (b *UnitInfoBase) GetBMcode() int                  { return b.BMcode }
func (b *UnitInfoBase) GetShootMe() int                 { return b.ShootMe }
func (b *UnitInfoBase) GetSoundCategory() string        { return b.SoundCategory }
func (b *UnitInfoBase) GetCorpse() string               { return b.Corpse }
func (b *UnitInfoBase) GetMovementClass() string        { return b.MovementClass }
func (b *UnitInfoBase) GetMaxVelocity() float64         { return b.MaxVelocity }
func (b *UnitInfoBase) GetAcceleration() float64        { return b.Acceleration }
func (b *UnitInfoBase) GetBrakeRate() float64           { return b.BrakeRate }
func (b *UnitInfoBase) GetTurnRate() int                { return b.TurnRate }
func (b *UnitInfoBase) GetManeuverLeashLength() int     { return b.ManeuverLeashLength }
func (b *UnitInfoBase) GetBankScale() float64           { return b.BankScale }
func (b *UnitInfoBase) GetPitchScale() float64          { return b.PitchScale }
func (b *UnitInfoBase) GetUpright() int                 { return b.Upright }
func (b *UnitInfoBase) GetCanFly() int                  { return b.CanFly }
func (b *UnitInfoBase) GetCruiseAlt() float64           { return b.CruiseAlt }
func (b *UnitInfoBase) GetFloater() int                 { return b.Floater }
func (b *UnitInfoBase) GetCanHover() int                { return b.CanHover }
func (b *UnitInfoBase) GetCanMove() int                 { return b.CanMove }
func (b *UnitInfoBase) GetCanStop() int                 { return b.CanStop }
func (b *UnitInfoBase) GetCanPatrol() int               { return b.CanPatrol }
func (b *UnitInfoBase) GetCanGuard() int                { return b.CanGuard }
func (b *UnitInfoBase) GetCanAttack() int               { return b.CanAttack }
func (b *UnitInfoBase) GetBuilder() int                 { return b.Builder }
func (b *UnitInfoBase) GetDefaultMissionType() string   { return b.DefaultMissionType }
func (b *UnitInfoBase) GetYardMap() string              { return b.YardMap }
func (b *UnitInfoBase) GetRemaining() map[string]string { return b.Remaining }
