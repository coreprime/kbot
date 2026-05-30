// Package ta provides typed Go representations of Total Annihilation game-data
// files (TDF/FBI/GUI), built on the github.com/coreprime/kbot/formats/tdf codec.
//
// Each type maps one TDF schema. Well-known keys are exposed as named fields;
// any remaining keys are preserved in a Remaining map so every file round-trips
// losslessly. Fields shared with TA:Kingdoms are factored into embedded base
// types from the common package. Use tdf.Unmarshal/tdf.Marshal with these types.
package ta

import "github.com/coreprime/kbot/formats/gamedata/common"

// Weapon is one entry of gamedata/weapons.tdf (and standalone weapons/*.tdf
// files). Each weapon is a top-level [SECTION]; decode a file with
//
//	var weapons []ta.Weapon
//	err := tdf.Unmarshal(data, &weapons)
//
// Fields shared with TA:Kingdoms live on the embedded common.WeaponBase; the
// fields below are unique to Total Annihilation.
type Weapon struct {
	common.WeaponBase

	ID         int `tdf:"id"`
	RenderType int `tdf:"rendertype,omitempty"`

	// Basic category flags.
	Ballistic   int `tdf:"ballistic,omitempty"`
	LineOfSight int `tdf:"lineofsight,omitempty"`
	Dropped     int `tdf:"dropped,omitempty"`
	Turret      int `tdf:"turret,omitempty"`
	NoExplode   int `tdf:"noexplode,omitempty"`

	// Trajectory / targeting category flags.
	SelfProp     int `tdf:"selfprop,omitempty"`
	Tracks       int `tdf:"tracks,omitempty"`
	CommandFire  int `tdf:"commandfire,omitempty"`
	VLaunch      int `tdf:"vlaunch,omitempty"`
	Cruise       int `tdf:"cruise,omitempty"`
	Guidance     int `tdf:"guidance,omitempty"`
	WaterWeapon  int `tdf:"waterweapon,omitempty"`
	TwoPhase     int `tdf:"twophase,omitempty"`
	NoAutoRange  int `tdf:"noautorange,omitempty"`
	BurnBlow     int `tdf:"burnblow,omitempty"`
	UnitsOnly    int `tdf:"unitsonly,omitempty"`
	Targetable   int `tdf:"targetable,omitempty"`
	Interceptor  int `tdf:"interceptor,omitempty"`
	Meteor       int `tdf:"meteor,omitempty"`
	Paralyzer    int `tdf:"paralyzer,omitempty"`
	NoRadar      int `tdf:"noradar,omitempty"`
	GroundBounce int `tdf:"groundbounce,omitempty"`
	Stockpile    int `tdf:"stockpile,omitempty"`
	ToAirWeapon  int `tdf:"toairweapon,omitempty"`
	StartFire    int `tdf:"startfire,omitempty"`

	Coverage int `tdf:"coverage,omitempty"`

	EnergyPerShot float64 `tdf:"energypershot,omitempty"` // Assuming float, due to name/usage
	MetalPerShot  int     `tdf:"metalpershot,omitempty"`
	Energy        int     `tdf:"energy,omitempty"` // build/stockpile cost
	Metal         int     `tdf:"metal,omitempty"`  // build/stockpile cost
	WeaponTimer   float64 `tdf:"weapontimer,omitempty"`

	WeaponAcceleration float64 `tdf:"weaponacceleration,omitempty"` // Assuming float, due to name/usage
	StartVelocity      float64 `tdf:"startvelocity,omitempty"`      // Assuming float, due to name/usage
	Duration           float64 `tdf:"duration,omitempty"`

	Burst       int     `tdf:"burst,omitempty"`
	BurstRate   float64 `tdf:"burstrate,omitempty"`
	SprayAngle  int     `tdf:"sprayangle,omitempty"`
	RandomDecay float64 `tdf:"randomdecay,omitempty"`

	FlightTime float64 `tdf:"flighttime,omitempty"` // Assuming float, due to name/usage
	Accuracy   int     `tdf:"accuracy,omitempty"`
	Tolerance  int     `tdf:"tolerance,omitempty"`
	PitchTolerance int `tdf:"pitchtolerance,omitempty"`
	AimRate    int     `tdf:"aimrate,omitempty"`
	HoldTime   int     `tdf:"holdtime,omitempty"`

	MinBarrelAngle float64 `tdf:"minbarrelangle,omitempty"` // Assuming float, degrees

	// Visuals.
	Color             int     `tdf:"color,omitempty"`
	Color2            int     `tdf:"color2,omitempty"`
	SmokeTrail        int     `tdf:"smoketrail,omitempty"`
	SmokeDelay        float64 `tdf:"smokedelay,omitempty"`
	StartSmoke        int     `tdf:"startsmoke,omitempty"`
	EndSmoke          int     `tdf:"endsmoke,omitempty"`
	BeamWeapon        int     `tdf:"beamweapon,omitempty"`
	ExplosionGAF      string  `tdf:"explosiongaf,omitempty"`
	ExplosionArt      string  `tdf:"explosionart,omitempty"`
	WaterExplosionGAF string  `tdf:"waterexplosiongaf,omitempty"`
	WaterExplosionArt string  `tdf:"waterexplosionart,omitempty"`
	LavaExplosionGAF  string  `tdf:"lavaexplosiongaf,omitempty"`
	LavaExplosionArt  string  `tdf:"lavaexplosionart,omitempty"`
	Propeller         int     `tdf:"propeller,omitempty"`
	ShakeMagnitude    int     `tdf:"shakemagnitude,omitempty"`
	ShakeDuration     float64 `tdf:"shakeduration,omitempty"`

	// Sounds.
	SoundStart   string `tdf:"soundstart,omitempty"`
	SoundWater   string `tdf:"soundwater,omitempty"`
	SoundTrigger int    `tdf:"soundtrigger,omitempty"`

	// Per-target-category damage values: [DAMAGE]{ default=10; corpyro=2; }.
	Damage map[string]int `tdf:"damage,omitempty"`
}

// Weapon satisfies the shared common.Weapon interface via its embedded base.
var _ common.Weapon = (*Weapon)(nil)
