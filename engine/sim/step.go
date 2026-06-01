package sim

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
)

const (
	// TickHz is the simulation rate; one tick is 25ms, matching TA's loop.
	TickHz = 40
	// TickMs is the millisecond duration of a single tick.
	TickMs = 1000 / TickHz
)

// dtSec is the fixed per-tick time step in seconds (0.025).
var dtSec = fixed.FromInt(TickMs).Div(fixed.FromInt(1000))

// defaultHitDamage matches the JS engine's constant for weapons whose TDF
// damage field has not been wired through yet.
var defaultHitDamage = fixed.FromInt(12)

// Runtime is the optional COB script VM the world advances each tick before
// movement, mirroring game-engine.js which ticks the runtime first.
type Runtime interface {
	Tick(ms int64)
}

// Step advances the simulation exactly one fixed tick. It is the only time
// source the world has; callers must invoke it once per TickMs.
func (w *World) Step(rt Runtime) {
	w.tick++
	w.simMs += TickMs
	if rt != nil {
		rt.Tick(w.simMs)
	}
	for _, id := range w.order {
		u := w.units[id]
		if u == nil || u.Dead {
			continue
		}
		w.stepAttack(u)
		w.stepMovement(u)
		w.stepWeapons(u)
	}
}

// stepAttack points the unit at its ordered attack target and decides whether
// to close the distance. A full autonomous target scan lives in the COB layer;
// this drives the explicit Attack order path.
func (w *World) stepAttack(u *Unit) {
	if !u.hasAttack {
		return
	}
	t := w.units[u.attackTarget]
	if t == nil || t.Dead {
		u.hasAttack = false
		u.weapons[0] = weaponSlot{}
		return
	}
	rng := u.Meta.Weapons[0].Range
	if rng <= 0 {
		rng = fixed.FromInt(180)
	}
	dist := u.loco.Pos.DistTo(t.loco.Pos)
	// Close in until within 90% of weapon range, then hold and let the weapon
	// SM fire.
	if dist > rng.Mul(fixed.FromFloat(0.9)) {
		u.hasMove = true
		u.moveTarget = t.loco.Pos
	} else {
		u.hasMove = false
	}
	s := &u.weapons[0]
	s.hasTarget = true
	s.source = "attack"
	s.targetUnit = u.attackTarget
}

// stepMovement integrates one tick of locomotion plus aircraft altitude and
// emits move-start/move-stop. Ported from game-engine.js #stepMovement.
func (w *World) stepMovement(u *Unit) {
	wasMoving := u.IsMoving
	if u.hasMove && u.Meta.CanMove {
		arrived, moving := stepSurfaceLocomotion(&u.loco, u.moveTarget, u.Meta, dtSec)
		u.IsMoving = moving
		if arrived {
			u.hasMove = false
			u.IsMoving = false
		}
	} else {
		u.IsMoving = false
		u.loco.Speed = 0
	}

	if u.Meta.IsAircraft {
		w.stepAltitude(u)
	}

	if u.IsMoving && !wasMoving {
		if u.binding != nil && u.binding.HasScript("StartMoving") {
			u.binding.Start("StartMoving")
		}
		w.emit(frame.Event{Kind: frame.EvMoveStart, UnitID: u.ID})
	} else if !u.IsMoving && wasMoving {
		if u.binding != nil && u.binding.HasScript("StopMoving") {
			u.binding.Start("StopMoving")
		}
		w.emit(frame.Event{Kind: frame.EvMoveStop, UnitID: u.ID})
	}
}

// stepAltitude lifts aircraft to cruise while they have somewhere to be and
// settles them to the ground when idle. Climb/descent rates derive from the
// FBI accel/brake, matching the JS engine.
func (w *World) stepAltitude(u *Unit) {
	hasFireOrder := false
	for i := range u.weapons {
		if u.weapons[i].hasTarget {
			hasFireOrder = true
			break
		}
	}
	airborne := u.IsMoving || hasFireOrder
	cruise := u.Meta.CruiseAltitude
	if cruise <= 0 {
		if u.Meta.IsHover {
			cruise = fixed.FromInt(60)
		} else {
			cruise = fixed.FromInt(100)
		}
	}
	altTarget := fixed.Zero
	if airborne {
		altTarget = cruise
	}
	accel := u.Meta.Accel
	if accel <= 0 {
		accel = fixed.FromFloat(0.1)
	}
	brake := u.Meta.BrakeRate
	if brake <= 0 {
		brake = fixed.FromFloat(0.1)
	}
	climbRate := fixed.Clamp(accel.Mul(fixed.FromInt(100)), fixed.FromInt(12), fixed.FromInt(80))
	descendRate := fixed.Clamp(brake.Mul(fixed.FromInt(10)), fixed.FromInt(8), fixed.FromInt(40))
	cur := u.PosY
	rate := descendRate
	if altTarget > cur {
		rate = climbRate
	}
	step := rate.Mul(dtSec)
	if (altTarget - cur).Abs() <= step {
		u.PosY = altTarget
	} else {
		u.PosY = cur + fixed.FromInt((altTarget - cur).Sign()).Mul(step)
	}
}

// stepWeapons runs each slot's fire cadence: in range + reloaded -> fire and
// apply damage. The full COB aim-thread cycle layers on top of this once the
// script VM is wired; this keeps combat functional headless.
func (w *World) stepWeapons(u *Unit) {
	for slot := range u.weapons {
		s := &u.weapons[slot]
		if !s.hasTarget {
			continue
		}
		wm := u.Meta.Weapons[slot]
		var targetPos fixed.Vec2
		if s.targetUnit != 0 {
			t := w.units[s.targetUnit]
			if t == nil || t.Dead {
				*s = weaponSlot{}
				continue
			}
			targetPos = t.loco.Pos
		} else {
			targetPos = fixed.Vec2{X: s.targetPt.X, Z: s.targetPt.Z}
		}
		rngF := wm.Range
		if rngF <= 0 {
			rngF = fixed.FromInt(180)
		}
		if u.loco.Pos.DistTo(targetPos) > rngF {
			continue
		}
		reload := int64(wm.ReloadMs)
		if reload <= 0 {
			reload = 750
		}
		if w.simMs < s.lastFireMs+reload {
			continue
		}
		s.lastFireMs = w.simMs
		anchor := u.Pos()
		anchor.Y += fixed.FromInt(12)
		w.emit(frame.Event{Kind: frame.EvFire, UnitID: u.ID, Slot: slot, TargetID: s.targetUnit, Anchor: anchor, Weapon: wm.Name})
		if s.targetUnit != 0 {
			dmg := wm.Damage
			if dmg <= 0 {
				dmg = defaultHitDamage
			}
			w.ApplyDamage(u.ID, s.targetUnit, dmg)
		}
		if s.source == "manual" && wm.Burst <= 1 {
			*s = weaponSlot{}
		}
	}
}
