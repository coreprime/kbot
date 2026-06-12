package sim

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// Transports. A unit whose FBI declares transport capacity (the Atlas's
// single sling, the Bear's deck) accepts Load orders: it moves into pickup
// range of the target, attaches it (the passenger rides the transporter,
// inert and untargetable), and an Unload order sets the cargo down on clear
// ground around the drop point. Repeat Loads queue more passengers up to
// the slot count; passengers detach in load order.

// transportPickupWU pads the pickup range past the pair's body radii.
var transportPickupWU = fixed.FromInt(24)

// transportApproachWU / transportApproachSpeed slow a transport down when
// it nears its pickup or drop point — at cruise speed a hover transport's
// turn radius overshoots the target and it circles for laps.
var (
	transportApproachWU    = fixed.FromInt(160)
	transportApproachSpeed = fixed.FromInt(70)
)

// isTransport reports whether the unit can carry passengers.
func isTransport(u *Unit) bool {
	return u.Meta != nil && u.Meta.TransportSlots > 0 && u.Meta.CanMove
}

// loadable reports whether a unit can be picked up by the transport: alive,
// finished, mobile ground stock (no aircraft, ships or buildings), not
// already aboard something, and small enough to be plausible cargo.
func loadable(t, cargo *Unit) bool {
	return cargo != nil && !cargo.Dead && cargo != t && !cargo.underConstruction() &&
		cargo.carriedBy == 0 && cargo.Meta != nil && cargo.Meta.CanMove &&
		!cargo.Meta.IsAircraft && !cargo.Meta.IsShip && !cargo.Meta.IsSub
}

// applyLoad handles a Load order on one transport: the first target becomes
// the active pickup, further ones queue behind it (bounded by free slots
// plus pending pickups).
func (w *World) applyLoad(t *Unit, targetID uint32) {
	if !isTransport(t) {
		return
	}
	cargo := w.units[targetID]
	if !loadable(t, cargo) {
		return
	}
	pending := 0
	if t.loadTarget != 0 {
		pending = 1
	}
	for _, c := range t.queue {
		if c.kind == order.KindLoad {
			pending++
		}
	}
	if len(t.carrying)+pending >= t.Meta.TransportSlots {
		return
	}
	if t.loadTarget == 0 && !t.hasUnload {
		t.loadTarget = targetID
		t.hasMove = false
		t.hasAttack = false
	} else {
		t.enqueue(queuedCommand{kind: order.KindLoad, targetUnit: targetID})
	}
}

// applyUnload points the transport at a drop site. It runs after any queued
// pickups complete (or immediately when nothing is pending).
func (w *World) applyUnload(t *Unit, at fixed.Vec2) {
	if !isTransport(t) || len(t.carrying)+boolInt(t.loadTarget != 0) == 0 {
		return
	}
	if t.loadTarget != 0 {
		t.enqueue(queuedCommand{kind: order.KindUnload, target: at})
		return
	}
	t.hasUnload = true
	t.unloadAt = at
	t.hasMove = false
	t.hasAttack = false
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// stepTransport drives one transport's load/unload jobs and pins its cargo
// to the carrier. Runs before movement each tick.
func (w *World) stepTransport(u *Unit) {
	if !isTransport(u) {
		return
	}
	if u.loadTarget != 0 {
		cargo := w.units[u.loadTarget]
		if !loadable(u, cargo) {
			u.loadTarget = 0
			w.advanceQueue(u)
		} else {
			reach := u.Meta.collisionRadius() + cargo.Meta.collisionRadius() + transportPickupWU
			dist := u.loco.Pos.DistTo(cargo.loco.Pos)
			if dist > reach {
				u.hasMove = true
				u.moveTarget = cargo.loco.Pos
				if dist < transportApproachWU && u.loco.Speed > transportApproachSpeed {
					u.loco.Speed = transportApproachSpeed
				}
			} else {
				// Attach: the passenger stops being an actor until set down.
				u.hasMove = false
				cargo.carriedBy = u.ID
				w.stopUnit(cargo.ID)
				u.carrying = append(u.carrying, cargo.ID)
				u.loadTarget = 0
				if u.binding != nil && u.binding.HasScript("BeginTransport") {
					u.binding.Start("BeginTransport", int(cargo.PosY.Int()))
				}
				w.advanceQueue(u)
			}
		}
	} else if u.hasUnload {
		dist := u.loco.Pos.DistTo(u.unloadAt)
		if dist > fixed.FromInt(32) {
			u.hasMove = true
			u.moveTarget = u.unloadAt
			if dist < transportApproachWU && u.loco.Speed > transportApproachSpeed {
				u.loco.Speed = transportApproachSpeed
			}
		} else {
			u.hasMove = false
			u.hasUnload = false
			w.dropCargo(u)
			w.advanceQueue(u)
		}
	}
}

// pinCargo runs after movement so passengers ride this tick's carrier pose,
// not last tick's.
func (w *World) pinCargo() {
	for _, id := range w.order {
		if c := w.units[id]; c != nil && !c.Dead && c.carriedBy != 0 {
			w.rideCarrier(c)
		}
	}
}

// ridderHangWU is how far below an air transport its sling cargo hangs;
// deck cargo on surface transports rides slightly above the hull line.
var (
	riderHangWU = fixed.FromInt(14)
	riderDeckWU = fixed.FromInt(6)
)

// rideCarrier pins a passenger to its carrier's position each tick.
func (w *World) rideCarrier(c *Unit) {
	t := w.units[c.carriedBy]
	if t == nil || t.Dead {
		// Carrier destroyed: the cargo is dropped where it was (TA kills
		// sling cargo with the Atlas; surviving the drop is the kinder rule
		// and keeps the sim simpler).
		c.carriedBy = 0
		c.PosY = 0
		return
	}
	c.loco.Pos = t.loco.Pos
	c.loco.Heading = t.loco.Heading
	c.loco.Speed = 0
	if t.Meta.IsAircraft {
		y := t.PosY - riderHangWU
		if y < 0 {
			y = 0
		}
		c.PosY = y
	} else {
		c.PosY = t.PosY + riderDeckWU
	}
}

// dropCargo sets every passenger down on clear ground around the transport,
// fanned by the same ring search factory rolloff uses.
func (w *World) dropCargo(t *Unit) {
	for _, id := range t.carrying {
		c := w.units[id]
		if c == nil || c.Dead {
			continue
		}
		c.carriedBy = 0
		c.PosY = 0
		spot := w.rolloffSpot(t, c)
		c.loco.Pos = spot
		c.homePos = spot
		if t.binding != nil && t.binding.HasScript("EndTransport") {
			t.binding.Start("EndTransport")
		}
	}
	t.carrying = nil
}