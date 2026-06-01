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

	// Ballistic / projectile fields. A weapon that names a 3DO model (and is
	// not a beam) flies a simulated mesh through the projectile subsystem and
	// applies its damage on detonation; everything else hits instantly at fire
	// time. All rates derive from the weapon TDF.
	Model           string      // 3DO projectile model; empty = no model projectile
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

// hasModelProjectile reports whether the weapon flies a visible mesh the
// projectile simulation owns. Beam weapons hit instantly and never travel.
func (w WeaponMeta) hasModelProjectile() bool {
	return w.Model != "" && !w.BeamWeapon
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
