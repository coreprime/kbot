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
	CruiseAltitude fixed.Fixed

	IsBuilder bool
	OnOffable bool

	// Construction stats. BuildTime is the unit's own build-effort points
	// (FBI buildtime — how long IT takes to construct); WorkerTime is the
	// builder's effort output per second (FBI workertime); BuildDistance is
	// how close (wu) a mobile builder must stand to its construction site.
	BuildTime     fixed.Fixed
	WorkerTime    int
	BuildDistance fixed.Fixed

	// MaxHealth is the unit's absolute hit points (FBI maxdamage). The sim's
	// health bar stays on a 0..100 scale; ApplyDamage divides each weapon's
	// absolute damage by this to land TDF-faithful percentage hits. Zero
	// means unknown — damage then applies at face value, the legacy scale.
	MaxHealth fixed.Fixed

	Weapons [3]WeaponMeta
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
