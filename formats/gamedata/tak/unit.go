// Package tak provides typed Go representations of Total Annihilation: Kingdoms
// game-data files, built on the github.com/coreprime/kbot/formats/tdf codec.
//
// TA:Kingdoms uses the same TDF text grammar as Total Annihilation but a
// different schema: a unit .fbi file is a document of sibling top-level
// sections ([UNITINFO], [WEAPON1..3], [EXPLODEAS]) rather than a single
// [UNITINFO]. Well-known keys are exposed as named fields; any remaining keys
// are preserved in a Remaining map so every file round-trips losslessly. Fields
// shared with Total Annihilation are factored into embedded base types from the
// common package.
package tak

import "github.com/coreprime/kbot/formats/gamedata/common"

// UnitInfo is the [UNITINFO] section of a TA:Kingdoms unit .fbi file. Fields
// shared with Total Annihilation live on the embedded common.UnitInfoBase; the
// fields below are unique to TA:Kingdoms.
type UnitInfo struct {
	common.UnitInfoBase

	BodyType string `tdf:"bodytype,omitempty"`
	SubType  string `tdf:"subtype,omitempty"`
	Model    string `tdf:"model,omitempty"`

	BuildCost        int     `tdf:"buildcost,omitempty"`
	BuildTime        float64 `tdf:"buildtime,omitempty"` // Assuming float, due to name/usage
	ExperiencePoints int     `tdf:"experiencepoints,omitempty"`

	HealTime       float64 `tdf:"healtime,omitempty"` // Assuming float, due to name/usage
	DamageCategory string  `tdf:"damagecategory,omitempty"`

	MaxMana          int     `tdf:"maxmana,omitempty"`
	ManaRechargeRate float64 `tdf:"manarechargerate,omitempty"` // Assuming float, due to name/usage
	MogriumStorage   int     `tdf:"mogriumstorage,omitempty"`
	MogriumIncome    float64 `tdf:"mogriumincome,omitempty"` // Assuming float, due to name/usage

	SoundClass string `tdf:"soundclass,omitempty"`
	ShadowGAF  string `tdf:"shadowgaf,omitempty"`

	// Movement.
	TurnInPlaceRate int     `tdf:"turninplacerate,omitempty"`
	WaterMultiplier float64 `tdf:"watermultiplier,omitempty"` // Assuming float, due to name/usage
	RoadMultiplier  float64 `tdf:"roadmultiplier,omitempty"`  // Assuming float, due to name/usage

	// Orders / behaviour flags.
	CanReclaim        int `tdf:"canreclaim,omitempty"`
	StandingUnitOrder int `tdf:"standingunitorder,omitempty"`
	UnitStandOrders   int `tdf:"unitstandorders,omitempty"`

	Type string `tdf:"type,omitempty"`
	Wind int    `tdf:"wind,omitempty"`

	// Blood colours are space-separated "R G B" triples, modelled as RGBString.
	BloodColor1 *common.RGBString `tdf:"bloodcolor1,omitempty"`
	BloodColor2 *common.RGBString `tdf:"bloodcolor2,omitempty"`
	BloodColor3 *common.RGBString `tdf:"bloodcolor3,omitempty"`

	ButtonImageUp       string `tdf:"buttonimageup,omitempty"`
	ButtonImageDown     string `tdf:"buttonimagedown,omitempty"`
	ButtonImageSelected string `tdf:"buttonimageselected,omitempty"`
	ButtonImageDisabled string `tdf:"buttonimagedisabled,omitempty"`

	// Area "adjust" abilities are optional nested sections of [UNITINFO].
	AdjustJoy    *Adjust `tdf:"adjustjoy,omitempty"`
	AdjustArmor  *Adjust `tdf:"adjustarmor,omitempty"`
	AdjustAttack *Adjust `tdf:"adjustattack,omitempty"`
}

// UnitInfo satisfies the shared common.UnitInfo interface via its embedded base.
var _ common.UnitInfo = (*UnitInfo)(nil)

// Adjust is an area-effect ability subsection of [UNITINFO]
// ([AdjustJoy], [AdjustArmor], [AdjustAttack]).
type Adjust struct {
	Adjustment        float64 `tdf:"adjustment,omitempty"` // Assuming float, due to name/usage
	AffectsEnemy      int     `tdf:"affectsenemy,omitempty"`
	EdgeEffectiveness float64 `tdf:"edgeeffectiveness,omitempty"`
	Radius            int     `tdf:"radius,omitempty"`

	// Remaining preserves any other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Weapon is a [WEAPONn] section of a TA:Kingdoms unit .fbi file. Fields shared
// with Total Annihilation live on the embedded common.WeaponBase; the fields
// below are unique to TA:Kingdoms.
type Weapon struct {
	common.WeaponBase

	Type     string `tdf:"type,omitempty"`
	SubType  string `tdf:"subtype,omitempty"`
	MinRange int    `tdf:"minrange,omitempty"`

	AimTolerance int     `tdf:"aimtolerance,omitempty"`
	ManaPerShot  float64 `tdf:"manapershot,omitempty"` // Assuming float, due to name/usage

	DamageType          string `tdf:"damagetype,omitempty"`
	ExplosionClass      string `tdf:"explosionclass,omitempty"`
	WaterExplosionClass string `tdf:"waterexplosionclass,omitempty"`

	// Projectile presentation flags. Nimbus marks the glow halo the engine
	// draws around magic projectiles; LightMap ("small"/"medium"/"large")
	// sizes the light splash the shot casts on the ground; HwEffect names a
	// hardware-rendered stream effect ("fire", "lightning", ...).
	Nimbus   int    `tdf:"nimbus,omitempty"`
	LightMap string `tdf:"lightmap,omitempty"`
	HwEffect string `tdf:"hweffect,omitempty"`

	// Tracer/beam colours, stored as space-separated "R G B" triples.
	InnerColor  *common.RGBString `tdf:"innercolor,omitempty"`
	MiddleColor *common.RGBString `tdf:"middlecolor,omitempty"`
	OuterColor  *common.RGBString `tdf:"outercolor,omitempty"`

	WeaponArt     string `tdf:"weaponart,omitempty"`
	ShadowArt     string `tdf:"shadowart,omitempty"`
	ShadowGAF     string `tdf:"shadowgaf,omitempty"`
	SoundHitClass string `tdf:"soundhitclass,omitempty"`

	// Per-target-category damage multipliers: [DAMAGE]{ default=1; fort=0.2; }.
	Damage map[string]float64 `tdf:"damage,omitempty"`
}

// Weapon satisfies the shared common.Weapon interface via its embedded base.
var _ common.Weapon = (*Weapon)(nil)

// ExplodeAs is the [EXPLODEAS] section of a TA:Kingdoms unit .fbi file: the
// effect produced when the unit is destroyed.
type ExplodeAs struct {
	Key string `tdf:",name"` // section header, always EXPLODEAS

	Name                string  `tdf:"name,omitempty"`
	AreaOfEffect        int     `tdf:"areaofeffect,omitempty"`
	DamageType          string  `tdf:"damagetype,omitempty"`
	EdgeEffectiveness   float64 `tdf:"edgeeffectiveness,omitempty"`
	ExplosionClass      string  `tdf:"explosionclass,omitempty"`
	WaterExplosionClass string  `tdf:"waterexplosionclass,omitempty"`

	Damage map[string]float64 `tdf:"damage,omitempty"`

	// Remaining preserves every other key=value so the file round-trips.
	Remaining map[string]string `tdf:",remaining"`
}

// Unit wraps a TA:Kingdoms unit .fbi file: one [UNITINFO] plus up to three
// [WEAPONn] sections and an optional [EXPLODEAS], as sibling top-level blocks.
//
//	var u tak.Unit
//	err := tdf.Unmarshal(data, &u)
type Unit struct {
	Info      UnitInfo   `tdf:"unitinfo"`
	Weapon1   *Weapon    `tdf:"weapon1,omitempty"`
	Weapon2   *Weapon    `tdf:"weapon2,omitempty"`
	Weapon3   *Weapon    `tdf:"weapon3,omitempty"`
	ExplodeAs *ExplodeAs `tdf:"explodeas,omitempty"`
}
