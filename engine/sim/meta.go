package sim

import "github.com/coreprime/kbot/engine/fixed"

// UnitMeta is the FBI-derived stat block a unit type carries into the
// simulation. Floats from the parsed FBI are converted to fixed-point exactly
// once, here at the asset boundary, so the tick loop only ever sees integers.
type UnitMeta struct {
	Name string

	CanMove     bool
	MaxVelocity fixed.Fixed // world-units per frame (30 Hz)
	TurnRate    fixed.Fixed // TA-angle per frame
	Accel       fixed.Fixed // world-units per frame^2
	BrakeRate   fixed.Fixed // world-units per frame^2

	IsAircraft     bool
	IsHover        bool
	IsShip         bool
	IsSub          bool
	IsHovercraft   bool
	CruiseAltitude fixed.Fixed

	// Terrain limits (FBI maxslope / maxwaterdepth / minwaterdepth, in
	// height units): the steepest cell delta the unit climbs, the deepest
	// water a surface unit wades, the shallowest water a ship needs.
	MaxSlope      int
	MaxWaterDepth int
	MinWaterDepth int

	IsBuilder bool
	OnOffable bool
	// ActivateWhenBuilt — the unit's Activate script runs the moment its
	// construction completes (FBI activatewhenbuilt; ARM Solar's panels).
	ActivateWhenBuilt bool

	// Construction stats. BuildTime is the unit's own build-effort points
	// (FBI buildtime — how long IT takes to construct); WorkerTime is the
	// builder's effort output per second (FBI workertime); BuildDistance is
	// how close (wu) a mobile builder must stand to its construction site.
	BuildTime     fixed.Fixed
	WorkerTime    int
	BuildDistance fixed.Fixed

	// FootprintX/Z are the FBI footprint in map squares; collisionRadius
	// derives the body circle the collision/avoidance passes use.
	FootprintX int
	FootprintZ int

	// TransportSlots — how many units this transport carries (0 = not a
	// transport).
	TransportSlots int

	// Yard is the parsed YardMap occupancy grid (row-major FootprintZ rows ×
	// FootprintX cols). Nil means the whole footprint is solid. Only standing
	// structures collide by yard; mobile units stay on the circle model.
	Yard []yardCell

	// Resource prices, drained over the unit's build (TA metal+energy,
	// TA:K mana). Pools are infinite in the sandbox; the drain feeds the
	// per-side usage stats only.
	CostMetal  fixed.Fixed
	CostEnergy fixed.Fixed
	CostMana   fixed.Fixed

	// Default standing orders the unit spawns with (FBI standingmoveorder /
	// standingfireorder, already resolved to the game defaults — Maneuver /
	// Fire at Will — when the FBI is silent).
	StandMove uint8
	StandFire uint8

	// Death blasts: the resolved explodeas weapon (ordinary death) and
	// selfdestructas weapon (Ctrl+D). Damage is absolute per-shot, AoE the
	// blast diameter in world units, Edge the damage fraction left at the
	// rim. A zero-damage blast deals no splash (visual only).
	Explode Blast
	SelfD   Blast

	// Economy contributions per second while the unit stands (generation)
	// and the storage capacity it adds to its side's pools. The sandbox
	// never gates on stock — these feed the economy bar's accounting only.
	MakeMetal   fixed.Fixed
	MakeEnergy  fixed.Fixed
	MakeMana    fixed.Fixed
	StoreMetal  fixed.Fixed
	StoreEnergy fixed.Fixed
	StoreMana   fixed.Fixed

	// MaxHealth is the unit's absolute hit points (FBI maxdamage). The sim's
	// health bar stays on a 0..100 scale; ApplyDamage divides each weapon's
	// absolute damage by this to land TDF-faithful percentage hits. Zero
	// means unknown — damage then applies at face value, the legacy scale.
	MaxHealth fixed.Fixed

	Weapons [3]WeaponMeta
}

// Blast is one resolved death-explosion weapon's stat block.
type Blast struct {
	Damage fixed.Fixed
	AoE    fixed.Fixed
	Edge   fixed.Fixed
}

// WeaponMeta holds the per-slot weapon stats the engine acts on.
type WeaponMeta struct {
	Name     string
	Range    fixed.Fixed // world units
	ReloadMs int         // milliseconds between shots
	Burst    int         // shots per burst (>=1)
	Damage   fixed.Fixed // per shot
	Present  bool

	// Tolerance is the weapon's firing arc in TA-angle units (65536 = full
	// turn); 0 = no arc constraint. Aircraft aim by pointing the whole airframe
	// (no rotating turret), so the body heading must be within tolerance of the
	// target bearing before the weapon may open fire.
	Tolerance int32

	// Ballistic / projectile fields. Every weapon except an instant-hit beam
	// flies a tracked projectile through the subsystem and applies its damage on
	// detonation — a missile/rocket/bomb carries a 3DO mesh, while a cannon shell
	// or EMG bolt flies the same flight path with no model. Tracking the
	// model-less shots is what lets a late joiner restore in-flight cannon/EMG
	// fire, not just missiles. All rates derive from the weapon TDF.
	Model           string      // 3DO projectile model; empty = model-less shot
	BeamWeapon      bool        // instant-hit beam (lasers): never flies
	VelocityWU      fixed.Fixed // top speed, world units/sec
	StartVelocityWU fixed.Fixed // launch speed; 0 = top speed (no ramp)
	AccelerationWU  fixed.Fixed // ramp to top speed, wu/s^2; 0 = instant
	TurnRateAng     int32       // homing turn rate, TA-angle/sec; 0 = unguided
	FlightTimeSec   fixed.Fixed // self-destruct timer; 0 = derive from range/vel
	AreaOfEffectWU  fixed.Fixed // blast diameter for detonation damage
	Dropped         bool        // gravity bomb: released with no thrust
	VLaunch         bool        // vertical launch: climbs then homes
	Tracks          bool        // guided: homes on the target
	SelfProp        bool        // self-propelled (with Tracks + turn rate, homes)
	Ballistic       bool        // unpowered arc under gravity
}

// flies reports whether the weapon launches a tracked projectile the sim flies
// to its target. Only an instant-hit beam (laser) skips the flight path; every
// other weapon — model missile, model-less cannon shell, EMG bolt — travels
// through the projectile subsystem and resolves damage on detonation. Tracking
// the model-less shots authoritatively is what lets them survive a join/restore.
func (w WeaponMeta) flies() bool {
	return !w.BeamWeapon
}

// collisionRadius derives the unit's body circle from its FBI footprint
// (squares of 16 world units; the radius is half the wider side). Units with
// no footprint get a small vehicle-sized default.
func (m *UnitMeta) collisionRadius() fixed.Fixed {
	f := m.FootprintX
	if m.FootprintZ > f {
		f = m.FootprintZ
	}
	if f <= 0 {
		return fixed.FromInt(12)
	}
	return fixed.Clamp(fixed.FromInt(f*8), fixed.FromInt(10), fixed.FromInt(96))
}

// movement-rate conversions. TA simulates locomotion at 30 Hz, so an FBI
// per-frame rate becomes a per-second rate by multiplying by 30. These mirror
// locomotion.js exactly, in fixed-point.
const taMoveHz = 30

func (m *UnitMeta) maxSpeed() fixed.Fixed {
	v := m.MaxVelocity
	if v <= 0 {
		v = fixed.One
	}
	return v.Mul(fixed.FromInt(taMoveHz))
}

// turnRatePerSec returns the turn rate in TA-angle units per second.
func (m *UnitMeta) turnRatePerSec() fixed.Fixed {
	t := m.TurnRate
	if t <= 0 {
		t = fixed.FromInt(600)
	}
	return t.Mul(fixed.FromInt(taMoveHz))
}

func (m *UnitMeta) accel() fixed.Fixed {
	a := m.Accel
	if a <= 0 {
		a = fixed.FromFloat(0.05)
	}
	v := a.Mul(fixed.FromInt(taMoveHz * taMoveHz))
	return fixed.Clamp(v, fixed.FromInt(8), fixed.FromInt(240))
}

func (m *UnitMeta) brake() fixed.Fixed {
	b := m.BrakeRate
	if b <= 0 {
		b = fixed.FromFloat(0.1)
	}
	v := b.Mul(fixed.FromInt(taMoveHz * taMoveHz))
	return fixed.Clamp(v, fixed.FromInt(12), fixed.FromInt(400))
}
