package sim

import "github.com/coreprime/kbot/engine/fixed"

// atkPhase enumerates the phases an aircraft cycles through while engaging.
// A gunship alternates approach/strafe; a fixed-wing aircraft alternates
// approach/egress, flying a fly-by pass then arcing out to a turn-around point.
type atkPhase uint8

const (
	atkApproach atkPhase = iota
	atkStrafe
	atkEgress
)

// turnToward rotates the heading toward want (a TA-angle) at the unit's FBI
// turn rate, never snapping past it. Mirrors locomotion.js _turnToward.
func turnToward(st *locoState, want fixed.Fixed, m *UnitMeta, dtSec fixed.Fixed) {
	dh := shortestArcFx(want - st.Heading)
	step := m.turnRatePerSec().Mul(dtSec)
	if dh.Abs() > step {
		st.Heading += fixed.FromInt(dh.Sign()).Mul(step)
	} else {
		st.Heading = want
	}
}

// flyForward turns toward want and drives forward along the heading at the
// unit's (ramped) max speed — the "always flying" motion fixed-wing aircraft
// and closing gunships use. Mirrors locomotion.js _flyForward.
func flyForward(st *locoState, want fixed.Fixed, m *UnitMeta, dtSec fixed.Fixed) {
	turnToward(st, want, m, dtSec)
	target := m.maxSpeed()
	s := st.Speed
	if s < target {
		s = fixed.Min(target, s+m.accel().Mul(dtSec))
	} else {
		s = fixed.Max(target, s-m.brake().Mul(dtSec))
	}
	st.Speed = s
	sin, cos := headingVec(st.Heading)
	st.Pos.X += sin.Mul(s.Mul(dtSec))
	st.Pos.Z += cos.Mul(s.Mul(dtSec))
}

// attackManeuver flies an aircraft's attack pattern around the engagement at
// (tx, tz), using its weapon range for the standoff and fly-by geometry. It
// mutates the unit's locomotion and persistent maneuver fields in place,
// mirroring locomotion.js attackManeuver. Two flavours:
//
//   - Hover gunship (IsHover): close to within range, then strafe an arc
//     left/right around the target at standoff while always facing it.
//   - Fixed-wing: fly straight at the target, overshoot, then arc out to a
//     wide turn-around point and come back (alternating sides => figure-eight).
//     A bomber (bomberMode) holds heading through the drop window so its bomb
//     string lays on a straight line, banking away only once it has cleared the
//     far edge (target + passthrough).
func (u *Unit) attackManeuver(tx, tz, rangeF, dtSec fixed.Fixed, bomberMode bool, passthrough fixed.Fixed) {
	st := &u.loco
	dx := tx - st.Pos.X
	dz := tz - st.Pos.Z
	dist := fixed.Vec2{X: dx, Z: dz}.Len()
	bearing := fixed.FromInt(int(fixed.Atan2(dx, dz)))

	if u.Meta.IsHover {
		standoff := fixed.Max(fixed.FromInt(24), rangeF.Mul(fixed.FromFloat(0.6)))
		if dist > rangeF {
			// Out of range — close in head-on.
			u.atkPhase = atkApproach
			flyForward(st, bearing, u.Meta, dtSec)
			return
		}
		// In range — strafe an arc around the target, nose always on it.
		if u.atkPhase != atkStrafe {
			u.atkPhase = atkStrafe
			// Lock the side we arrived from.
			u.sweepCenter = fixed.FromInt(int(fixed.Atan2(st.Pos.X-tx, st.Pos.Z-tz)))
			u.sweepPhase = 0
		}
		u.sweepPhase += dtSec.Mul(fixed.FromFloat(0.8 * taAnglesPerRadian))
		sinPhase := fixed.Sin(int32(u.sweepPhase.Int()))
		ang := u.sweepCenter + sinPhase.Mul(fixed.FromFloat(0.7*taAnglesPerRadian)) // +/-40 deg sweep
		sinAng, cosAng := fixed.SinCos(int32(ang.Int()))
		desX := tx + standoff.Mul(sinAng)
		desZ := tz + standoff.Mul(cosAng)
		mdx := desX - st.Pos.X
		mdz := desZ - st.Pos.Z
		md := fixed.Vec2{X: mdx, Z: mdz}.Len()
		eps := fixed.FromFloat(1e-3)
		step := fixed.Min(md, u.Meta.maxSpeed().Mul(dtSec))
		if md > eps {
			st.Pos.X += mdx.Div(md).Mul(step)
			st.Pos.Z += mdz.Div(md).Mul(step)
			st.Speed = u.Meta.maxSpeed()
		} else {
			st.Speed = 0
		}
		turnToward(st, bearing, u.Meta, dtSec) // face the target while strafing
		return
	}

	// Fixed-wing fly-by.
	egressDist := fixed.Max(fixed.FromInt(30), rangeF.Mul(fixed.FromFloat(0.4)))
	if bomberMode {
		egressDist = fixed.FromInt(30)
	}
	if u.atkPhase != atkEgress {
		u.atkPhase = atkApproach
		// Hold heading inside the drop zone (bomber + within passthrough of the
		// target); steer to the target bearing everywhere else.
		want := bearing
		if bomberMode && dist <= passthrough {
			want = st.Heading
		}
		flyForward(st, want, u.Meta, dtSec)
		// Past-target test: forward . (target - pos) negative => crossed the aim
		// point. Bombers also wait until clear of the far drop-zone edge.
		sinH, cosH := headingVec(st.Heading)
		dot := sinH.Mul(dx) + cosH.Mul(dz)
		pastTarget := dot < 0
		var triggerEgress bool
		if bomberMode {
			triggerEgress = pastTarget && dist >= passthrough
		} else {
			triggerEgress = dist < egressDist
		}
		if triggerEgress {
			u.atkPhase = atkEgress
			sx := cosH
			sz := -sinH
			if u.flybySide == 0 {
				u.flybySide = 1
			}
			u.flybySide = -u.flybySide
			lead := fixed.Max(fixed.FromInt(180), rangeF.Mul(fixed.FromFloat(1.2)))
			lat := fixed.Max(fixed.FromInt(120), rangeF.Mul(fixed.FromFloat(0.7))).Mul(fixed.FromInt(int(u.flybySide)))
			u.egX = tx + sinH.Mul(lead) + sx.Mul(lat)
			u.egZ = tz + cosH.Mul(lead) + sz.Mul(lat)
		}
		return
	}
	// Egress: fly to the turn-around point, then come back for another run.
	ex := u.egX - st.Pos.X
	ez := u.egZ - st.Pos.Z
	flyForward(st, fixed.FromInt(int(fixed.Atan2(ex, ez))), u.Meta, dtSec)
	if (fixed.Vec2{X: ex, Z: ez}).Len() < fixed.FromInt(40) {
		u.atkPhase = atkApproach
	}
}
