package sim

import "github.com/coreprime/kbot/engine/fixed"

// Unit-vs-unit collision and local avoidance. Two cooperating passes keep
// surface units from driving through each other:
//
//   - avoidanceTarget (read in stepMovement) bends a mover's steering target
//     to a tangent point beside the first unit blocking its straight-line
//     path, so traffic flows AROUND obstacles instead of grinding into them.
//   - stepCollisions (after the movement pass) is the hard backstop: any two
//     overlapping bodies are pushed apart, movers shouldering the correction
//     against immobile obstacles (buildings, under-construction frames).
//
// Everything is fixed-point over the stable insertion order — no floats, no
// rng — so the passes are deterministic across server and predicting clients.
// Aircraft fly above it all and are exempt. Body radii derive from the FBI
// footprint (UnitMeta.collisionRadius). Map obstacles are a later layer.

// avoidLookaheadWU caps how far ahead a mover scans for path blockers; beyond
// it terrain steering would dominate anyway and the cost stays bounded.
var avoidLookaheadWU = fixed.FromInt(96)

// avoidSideMarginWU pads the tangent point past the combined body radii so
// the steered arc clears the blocker instead of grazing it back into the
// separation pass.
var avoidSideMarginWU = fixed.FromInt(10)

// collidable reports whether a unit participates in surface collision:
// alive, statted, and not an aircraft.
func collidable(u *Unit) bool {
	return u != nil && !u.Dead && u.Meta != nil && !u.Meta.IsAircraft
}

// canBePushed reports whether separation may move the unit: structures and
// under-construction frames hold their ground.
func canBePushed(u *Unit) bool {
	return u.Meta.CanMove && !u.underConstruction()
}

// avoidanceTarget returns the point stepMovement should steer toward: the
// unit's move target, or a tangent point beside the nearest unit sitting on
// the straight-line path to it. A blocker parked ON the destination is not
// orbited — the mover heads straight in and the crowded-arrival relax in
// stepCollisions completes the order.
func (w *World) avoidanceTarget(u *Unit) fixed.Vec2 {
	target := u.moveTarget
	if u.Meta.IsAircraft {
		return target
	}
	d := target.Sub(u.loco.Pos)
	dist := d.Len()
	if dist < fixed.FromInt(2) {
		return target
	}
	nx := d.X.Div(dist)
	nz := d.Z.Div(dist)
	lookahead := fixed.Min(dist, avoidLookaheadWU)
	ur := u.Meta.collisionRadius()

	var blocker *Unit
	var blockT fixed.Fixed
	for _, id := range w.order {
		o := w.units[id]
		if o == nil || o == u || !collidable(o) {
			continue
		}
		od := o.loco.Pos.Sub(u.loco.Pos)
		t := od.X.Mul(nx) + od.Z.Mul(nz) // projection along the path ray
		if t <= 0 || t > lookahead {
			continue
		}
		lx := od.X - nx.Mul(t)
		lz := od.Z - nz.Mul(t)
		lat := fixed.Vec2{X: lx, Z: lz}.Len()
		if lat >= ur+o.Meta.collisionRadius()+fixed.FromInt(4) {
			continue
		}
		if blocker == nil || t < blockT {
			blocker = o
			blockT = t
		}
	}
	if blocker == nil {
		return target
	}
	// Blocker effectively at the destination: head straight, let the
	// crowded-arrival relax finish the move beside it.
	if dist-blockT < ur+blocker.Meta.collisionRadius()+fixed.FromInt(6) {
		return target
	}
	// Steer for the tangent point on the side OPPOSITE the blocker's lateral
	// offset (pass on the open side); a dead-centre blocker breaks the tie by
	// id parity so two units meeting head-on pick complementary sides.
	od := blocker.loco.Pos.Sub(u.loco.Pos)
	lat := od.X.Mul(nz) - od.Z.Mul(nx) // + = blocker offset toward (nz,-nx)
	side := fixed.FromInt(-1)
	if lat < 0 {
		side = fixed.FromInt(1)
	} else if lat == 0 && (u.ID+blocker.ID)%2 == 1 {
		side = fixed.FromInt(1)
	}
	clear := ur + blocker.Meta.collisionRadius() + avoidSideMarginWU
	return fixed.Vec2{
		X: blocker.loco.Pos.X + nz.Mul(side).Mul(clear),
		Z: blocker.loco.Pos.Z - nx.Mul(side).Mul(clear),
	}
}

// stepCollisions resolves body overlap pairwise in insertion order and
// applies the crowded-arrival relax: a mover shoved against an idle body
// while already close to its destination counts as arrived, so formations
// pack around a shared move point instead of jostling forever.
func (w *World) stepCollisions() {
	n := len(w.order)
	for i := 0; i < n; i++ {
		a := w.units[w.order[i]]
		if !collidable(a) {
			continue
		}
		for j := i + 1; j < n; j++ {
			b := w.units[w.order[j]]
			if !collidable(b) {
				continue
			}
			w.separate(a, b)
		}
	}
}

// separate pushes two overlapping bodies apart along their centre axis.
func (w *World) separate(a, b *Unit) {
	sumR := a.Meta.collisionRadius() + b.Meta.collisionRadius()
	d := b.loco.Pos.Sub(a.loco.Pos)
	// Cheap reject before the sqrt.
	if d.X.Abs() > sumR || d.Z.Abs() > sumR {
		return
	}
	dist := d.Len()
	if dist >= sumR {
		return
	}
	var nx, nz fixed.Fixed
	if dist > fixed.FromFloat(0.05) {
		nx = d.X.Div(dist)
		nz = d.Z.Div(dist)
	} else if (a.ID+b.ID)%2 == 0 {
		// Perfectly stacked bodies: a deterministic axis from id parity.
		nx = fixed.One
	} else {
		nz = fixed.One
	}
	overlap := sumR - dist
	aMoves := canBePushed(a)
	bMoves := canBePushed(b)
	switch {
	case aMoves && bMoves:
		half := overlap.Div(fixed.FromInt(2))
		a.loco.Pos.X -= nx.Mul(half)
		a.loco.Pos.Z -= nz.Mul(half)
		b.loco.Pos.X += nx.Mul(half)
		b.loco.Pos.Z += nz.Mul(half)
	case aMoves:
		a.loco.Pos.X -= nx.Mul(overlap)
		a.loco.Pos.Z -= nz.Mul(overlap)
	case bMoves:
		b.loco.Pos.X += nx.Mul(overlap)
		b.loco.Pos.Z += nz.Mul(overlap)
	}
	w.relaxArrival(a, b, sumR)
	w.relaxArrival(b, a, sumR)
}

// relaxArrival completes u's move order when it is pressing against a body
// that is holding still and the destination is already within the pair's
// combined radii plus slack — the spot is taken; parking beside it IS arrival.
func (w *World) relaxArrival(u, against *Unit, sumR fixed.Fixed) {
	if !u.hasMove || u.hasAttack {
		return
	}
	if against.IsMoving {
		return
	}
	if u.loco.Pos.DistTo(u.moveTarget) > sumR+fixed.FromInt(8) {
		return
	}
	u.hasMove = false
	u.loco.Speed = 0
	w.advanceQueue(u)
}
