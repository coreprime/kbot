package sim

import "github.com/coreprime/kbot/engine/fixed"

// locoState is the mutable motion state stepped each tick. Heading is a
// fractional TA-angle (the integer part feeds fixed.SinCos); speed is in
// world-units per second.
type locoState struct {
	Pos     fixed.Vec2
	Heading fixed.Fixed // TA-angle, fractional
	Speed   fixed.Fixed // wu/sec
}

// angle helpers in fixed TA-angle units.
var (
	fxFullCircle = fixed.FromInt(int(fixed.FullCircle))
	fxHalfCircle = fixed.FromInt(int(fixed.HalfCircle))
	fxQuarter    = fixed.FromInt(int(fixed.QuarterCircle))
	fxPivot      = fixed.FromInt(27306) // ~150 degrees in TA-angle units
	// radians per TA-angle unit, for the turn-radius reachability test only.
	radPerAngle = fixed.FromFloat(6.283185307179586 / 65536.0)
)

// shortestArcFx maps a fixed TA-angle delta into (-HalfCircle, +HalfCircle].
func shortestArcFx(a fixed.Fixed) fixed.Fixed {
	for a > fxHalfCircle {
		a -= fxFullCircle
	}
	for a <= -fxHalfCircle {
		a += fxFullCircle
	}
	return a
}

// headingVec returns the forward unit vector for a heading: (sin, cos), matching
// the engine convention heading 0 = +Z.
func headingVec(heading fixed.Fixed) (sin, cos fixed.Fixed) {
	return fixed.SinCos(int32(heading.Int()))
}

// stepSurfaceLocomotion advances one tick of drive-and-steer movement toward
// the target. It mutates st in place and reports whether the unit arrived and
// whether it is still moving. Ported from locomotion.js.
func stepSurfaceLocomotion(st *locoState, target fixed.Vec2, m *UnitMeta, dtSec fixed.Fixed) (arrived, moving bool) {
	const arriveDistF = 0.5
	arriveDist := fixed.FromFloat(arriveDistF)

	d := target.Sub(st.Pos)
	dist := d.Len()

	maxSpeed := m.maxSpeed()
	accel := m.accel()
	brake := m.brake()
	turn := m.turnRatePerSec()
	speed := st.Speed

	// Inside the arrival radius: bleed off momentum and glide to a stop.
	if dist < arriveDist {
		speed = fixed.Max(0, speed-brake.Mul(dtSec))
		st.Speed = speed
		if speed <= fixed.FromFloat(0.05) {
			st.Speed = 0
			return true, false
		}
		glide := fixed.Min(dist, speed.Mul(dtSec))
		sin, cos := headingVec(st.Heading)
		st.Pos.X += sin.Mul(glide)
		st.Pos.Z += cos.Mul(glide)
		return false, true
	}

	// Steer toward the target at the FBI turn rate (rate-limited).
	want := fixed.FromInt(int(fixed.Atan2(d.X, d.Z)))
	dh := shortestArcFx(want - st.Heading)
	turnStep := turn.Mul(dtSec)
	if dh.Abs() > turnStep {
		st.Heading += fixed.FromInt(dh.Sign()).Mul(turnStep)
	} else {
		st.Heading = want
	}

	// Forward thrust scale: full within 90 degrees of the target, fading to
	// zero by ~150 degrees so a unit pivots in place for a target behind it.
	adh := dh.Abs()
	face := fixed.One
	switch {
	case adh >= fxPivot:
		face = 0
	case adh > fxQuarter:
		face = fixed.One - (adh - fxQuarter).Div(fxPivot-fxQuarter)
	}

	// Brake into the target: cap desired speed to what we can still decel from.
	brakeCap := (fixed.FromInt(2).Mul(brake).Mul(dist - arriveDist)).Sqrt()
	desired := fixed.Min(maxSpeed.Mul(face), brakeCap)

	// Turn-radius reachability: if the turn circle is wider than the distance
	// to the target the unit can never bend onto it, so slow down to fit.
	turnRad := turn.Mul(radPerAngle)
	if adh > fixed.FromFloat(0.35*65536.0/6.283185307179586) && turnRad > fixed.FromFloat(1e-4) {
		if desired.Div(turnRad) > dist {
			desired = fixed.Min(desired, turnRad.Mul(dist).Mul(fixed.FromFloat(0.9)))
		}
	}

	// Ramp actual speed toward desired under accel/brake.
	if speed < desired {
		speed = fixed.Min(desired, speed+accel.Mul(dtSec))
	} else {
		speed = fixed.Max(desired, speed-brake.Mul(dtSec))
	}
	st.Speed = speed

	step := fixed.Min(dist, speed.Mul(dtSec))
	sin, cos := headingVec(st.Heading)
	st.Pos.X += sin.Mul(step)
	st.Pos.Z += cos.Mul(step)
	return false, true
}
