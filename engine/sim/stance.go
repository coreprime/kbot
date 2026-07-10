package sim

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// Standing orders. Every unit carries a move mode and a fire mode (seeded
// from its FBI standingmoveorder/standingfireorder, adjustable through a
// Stance order):
//
//	Fire modes  — Hold Fire never auto-engages; Return Fire engages only
//	once damaged, then keeps fighting while enemies remain in reach;
//	Fire at Will engages anything its acquisition range sees.
//	Move modes  — Hold Position never moves itself; Maneuver chases within
//	a leash of its post and walks back when combat ends; Roam chases until
//	the target is destroyed and wanders off its post while idle.
//
// stepStance runs before stepAttack each tick: it acquires autonomous
// targets, enforces the Maneuver leash, sends finished fighters home, and
// schedules Roam's idle wander. Explicit player orders always outrank it —
// it only ever acts on units with nothing in flight (or on engagements it
// started itself, tagged autoEngaged).
//
// FIDELITY SEAM — acquisition model. This is the minimal model firing
// correctness needs: deterministic nearest-enemy within reach, explicit
// orders sticky over autonomous picks. The engines' full acquisition is
// richer and remains unimplemented here: TA staggers each unit's scan to
// ~once a second on a per-player round-robin, scores candidates with
// rand(d^2) draws (stochastically nearest), buckets targets through the
// per-slot badTargetCategory masks (deprioritized, not excluded), honours
// shootme/noChaseCategory/kamikaze special cases, and gates everything on
// the vision/radar layers (cloaked units untargetable, radar dots only with
// a targeting facility); TA:K paces its re-scan by shared-stream RNG draws.
// Those pieces land with the vision/LOS subsystem — until then this scan is
// omniscient and draw-free, a documented divergence.

// Convenience aliases so the sim reads the same names the order package
// defines.
const (
	MoveHold     = uint8(order.MoveHold)
	MoveManeuver = uint8(order.MoveManeuver)
	MoveRoam     = uint8(order.MoveRoam)

	FireHold   = uint8(order.FireHold)
	FireReturn = uint8(order.FireReturn)
	FireAtWill = uint8(order.FireAtWill)
)

// returnFireWindowMs is how long after taking damage a Return Fire unit
// keeps acquiring fresh targets. Each new hit (and each live engagement)
// refreshes the stamp, so a brawl doesn't stand down mid-fight.
const returnFireWindowMs int64 = 8000

// maneuverLeashWU bounds how far past its weapon range a Maneuver unit will
// chase from its post; roamWanderWU is how far an idle Roamer strolls.
var (
	maneuverLeashWU = fixed.FromInt(160)
	roamWanderWU    = fixed.FromInt(280)
)

// roamWanderBaseMs/JitterMs pace the idle wander decisions.
const (
	roamWanderBaseMs   int64 = 8000
	roamWanderJitterMs int   = 8000
)

// weaponRange returns the unit's slot-0 engagement range (the figure the
// chase logic already keys on), with the same fallback.
func weaponRange(u *Unit) fixed.Fixed {
	r := u.Meta.Weapons[0].Range
	if r <= 0 {
		r = fixed.FromInt(220)
	}
	return r
}

// armed reports whether the unit carries any weapon.
func armed(u *Unit) bool {
	for i := range u.Meta.Weapons {
		if u.Meta.Weapons[i].Present {
			return true
		}
	}
	return false
}

// acquisitionRange is how far the unit looks for autonomous prey: weapon
// range for Hold Position (it will not step toward anything), stretched for
// the mobile stances.
func acquisitionRange(u *Unit) fixed.Fixed {
	r := weaponRange(u)
	if !u.Meta.CanMove {
		return r
	}
	switch u.moveMode {
	case MoveManeuver:
		return r + maneuverLeashWU
	case MoveRoam:
		return r.Mul(fixed.FromInt(3))
	default:
		return r
	}
}

// stepStance drives the autonomous side of the standing orders for one unit.
func (w *World) stepStance(u *Unit) {
	if u.Meta == nil || !armed(u) || u.Meta.IsBuilder && u.buildState != buildIdle {
		return
	}
	// A live engagement: keep Return Fire's window open while fighting, and
	// rein in an autonomous chase that has pulled a Maneuver unit past its
	// leash.
	if u.hasAttack {
		if u.fireMode == FireReturn {
			u.provokedMs = w.simMs
		}
		if u.autoEngaged && u.Meta.CanMove && u.moveMode == MoveManeuver {
			if t := w.units[u.attackTarget]; t != nil && !t.Dead {
				if t.loco.Pos.DistTo(u.homePos) > weaponRange(u)+maneuverLeashWU {
					w.standDown(u)
				}
			}
		}
		return
	}
	// Idle (no attack). Send a finished autonomous fighter back to its post,
	// or let a Roamer wander, before looking for new prey.
	if !u.hasMove && len(u.queue) == 0 {
		if u.autoEngaged {
			u.autoEngaged = false
			if u.Meta.CanMove && u.moveMode == MoveManeuver &&
				u.loco.Pos.DistTo(u.homePos) > fixed.FromInt(12) {
				u.hasMove = true
				u.moveTarget = u.homePos
				u.clearPath()
			}
		} else if u.Meta.CanMove && u.moveMode == MoveRoam && u.fireMode != FireHold {
			w.stepRoamWander(u)
		}
	}
	// Autonomous acquisition. Player moves are not diverted — only an idle
	// or patrolling unit hunts on its own.
	if u.hasMove && !u.curIsPatrol {
		return
	}
	// A manually-ordered weapon slot (force-fire) is an explicit player
	// order: auto-targeting never steals it — a slot holding its ordered
	// target keeps it until the player clears it.
	for i := range u.weapons {
		if u.weapons[i].hasTarget && u.weapons[i].source == "manual" {
			return
		}
	}
	switch u.fireMode {
	case FireHold:
		return
	case FireReturn:
		if w.simMs-u.provokedMs > returnFireWindowMs || u.provokedMs == 0 {
			return
		}
	}
	// Maneuver only acquires prey its leash actually lets it reach —
	// without the filter it would engage, hit the leash check next tick,
	// stand down, and oscillate forever instead of resuming its patrol. A
	// patroller leashes off its current spot on the route, not its spawn.
	homeLimit := fixed.Fixed(0)
	if u.Meta.CanMove && u.moveMode == MoveManeuver {
		homeLimit = weaponRange(u) + maneuverLeashWU
		if u.curIsPatrol {
			u.homePos = u.loco.Pos
		}
	}
	if t := w.nearestEnemy(u, acquisitionRange(u), homeLimit); t != nil {
		// A patrol leg yields to the engagement; the patrol queue resumes
		// when the attack completes (the leg re-queues from the move state).
		if u.curIsPatrol {
			u.enqueue(queuedCommand{kind: order.KindPatrol, target: u.moveTarget})
			u.hasMove = false
			u.curIsPatrol = false
		}
		u.hasAttack = true
		u.attackTarget = t.ID
		u.autoEngaged = true
	}
}

// standDown clears an autonomous engagement (leash break, Hold Fire flip)
// and resumes whatever the unit had queued — a patrol route interrupted by
// the engagement, queued waypoints — so it never wedges idle with work
// pending.
func (w *World) standDown(u *Unit) {
	u.hasAttack = false
	u.attackTarget = 0
	u.autoEngaged = false
	u.hasMove = false
	for slot := range u.weapons {
		s := &u.weapons[slot]
		if s.hasTarget && s.source == "attack" {
			w.clearWeaponSlot(u, slot)
		}
	}
	w.advanceQueue(u)
}

// nearestEnemy scans the field for the closest live enemy within reach. A
// nonzero homeLimit additionally requires the candidate to sit within that
// distance of the unit's post (the Maneuver leash pre-filter).
// Deterministic: stable insertion order, strict-less distance comparison.
func (w *World) nearestEnemy(u *Unit, within, homeLimit fixed.Fixed) *Unit {
	var best *Unit
	var bestDist fixed.Fixed
	for _, id := range w.order {
		o := w.units[id]
		if o == nil || o == u || o.Dead || o.Side == u.Side || o.underConstruction() ||
			o.carriedBy != 0 {
			continue
		}
		d := u.loco.Pos.DistTo(o.loco.Pos)
		if d > within {
			continue
		}
		if homeLimit > 0 && o.loco.Pos.DistTo(u.homePos) > homeLimit {
			continue
		}
		if best == nil || d < bestDist {
			best = o
			bestDist = d
		}
	}
	return best
}

// stepRoamWander schedules and issues a Roamer's idle wander: every so often
// (deterministically jittered off the world rng) it strolls to a random
// point within roamWanderWU of its post.
func (w *World) stepRoamWander(u *Unit) {
	if u.wanderAtMs == 0 {
		u.wanderAtMs = w.simMs + roamWanderBaseMs + int64(w.rng.Range(0, roamWanderJitterMs))
		return
	}
	if w.simMs < u.wanderAtMs {
		return
	}
	u.wanderAtMs = w.simMs + roamWanderBaseMs + int64(w.rng.Range(0, roamWanderJitterMs))
	ang := int32(w.rng.Range(0, int(fixed.FullCircle)))
	distWU := fixed.FromInt(w.rng.Range(40, roamWanderWU.Int()))
	sin, cos := fixed.SinCos(ang)
	u.hasMove = true
	u.moveTarget = fixed.Vec2{
		X: u.homePos.X + sin.Mul(distWU),
		Z: u.homePos.Z + cos.Mul(distWU),
	}
}