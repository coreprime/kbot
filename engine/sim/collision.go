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
// footprint (UnitMeta.collisionRadius).
//
// Divergent stand-in: neither engine has body circles, push-apart or tangent
// steering — occupancy is one unit id per 16 wu footprint cell, and a mover
// whose next cell is claimed takes the locomotion blocked-slide. This whole
// layer is scheduled to be replaced by footprint cell claims with the
// passability block; the avoidance behaviours then re-emerge from the slide
// plus the order layer.

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
	return u != nil && !u.Dead && u.Meta != nil && !u.Meta.IsAircraft &&
		u.carriedBy == 0
}

// canBePushed reports whether separation may move the unit: structures and
// under-construction frames hold their ground.
func canBePushed(u *Unit) bool {
	return u.Meta.CanMove && !u.underConstruction()
}

// steeringRadius is the clearance avoidance keeps from an obstacle's
// centre. A closed structure detours around its WHOLE footprint rectangle
// (circumradius), not the inscribed body circle — with the smaller radius
// the tangent point lands inside the building's corner and the mover
// grinds against the wall.
func steeringRadius(o *Unit) fixed.Fixed {
	if hasYard(o) {
		hx, hz := yardHalfExtents(o.Meta)
		return fixed.Vec2{X: hx, Z: hz}.Len()
	}
	return o.Meta.collisionRadius()
}

// avoidanceTarget returns the point stepMovement should steer toward: the
// unit's move target, or a tangent point beside the nearest unit sitting on
// the straight-line path to it. A blocker parked ON the destination is not
// orbited — the mover heads straight in and the crowded-arrival relax in
// stepCollisions completes the order.
func (w *World) avoidanceTarget(u *Unit, goal fixed.Vec2) fixed.Vec2 {
	target := goal
	if u.Meta.IsAircraft {
		return target
	}
	// When a global path is driving, it already routes around every static
	// structure with clearance — so only DYNAMIC units (other movers) need
	// local detours here. Skipping the yard-detour avoids the path and the
	// local steerer fighting over the same building.
	pathDriving := len(u.path) > 0
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
		// An open yard is transparent only to traffic actually USING it —
		// a unit inside driving out through the channel, or one whose
		// destination is inside (pad approach). Everyone else still
		// detours around the footprint: an open factory's side walls are
		// as solid as a closed one's.
		if hasYard(o) {
			// Path is handling static structures — ignore them here.
			if pathDriving {
				continue
			}
			if o.yardOpen && (yardContainsPoint(o, u.loco.Pos) || yardContainsPoint(o, target)) {
				continue
			}
		}
		oRad := steeringRadius(o)
		od := o.loco.Pos.Sub(u.loco.Pos)
		t := od.X.Mul(nx) + od.Z.Mul(nz) // projection along the path ray
		if t <= 0 || t > lookahead {
			continue
		}
		lx := od.X - nx.Mul(t)
		lz := od.Z - nz.Mul(t)
		lat := fixed.Vec2{X: lx, Z: lz}.Len()
		if lat >= ur+oRad+fixed.FromInt(4) {
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
	bRad := steeringRadius(blocker)
	if dist-blockT < ur+bRad+fixed.FromInt(6) {
		return target
	}
	// Structures route around their footprint rectangle's CORNERS — a
	// side tangent at the centreline wedges movers on the corners, where
	// the yard pushback cancels their step forever. Units (circles) keep
	// the cheap side tangent.
	if hasYard(blocker) {
		if p, ok := w.yardDetour(u, blocker, target); ok {
			return p
		}
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
	clear := ur + bRad + avoidSideMarginWU
	return fixed.Vec2{
		X: blocker.loco.Pos.X + nz.Mul(side).Mul(clear),
		Z: blocker.loco.Pos.Z - nx.Mul(side).Mul(clear),
	}
}

// yardDetour routes a mover around a structure's expanded footprint
// rectangle via its corners: pick the corner waypoint minimizing the
// pos→corner→target path among corners the mover can reach without
// cutting back through the rectangle (and can legally stand on). The
// wedge-recovery flip (stall detector) selects the runner-up corner so a
// mover pinned against one corner tries the route around the other side.
func (w *World) yardDetour(u, s *Unit, target fixed.Vec2) (fixed.Vec2, bool) {
	hx, hz := yardHalfExtents(s.Meta)
	ur := u.Meta.collisionRadius()
	pad := ur + avoidSideMarginWU
	ex, ez := hx+pad, hz+pad
	lp := yardLocal(s, u.loco.Pos)
	lt := yardLocal(s, target)
	// The crossing decision tests the rect inflated by the unit's body
	// radius: a centreline that grazes the corner gap still drags the
	// hull through the wall.
	if !segmentCrossesRect(lp, lt, hx+ur, hz+ur) {
		return fixed.Vec2{}, false
	}
	corners := [4]fixed.Vec2{{X: ex, Z: ez}, {X: ex, Z: -ez}, {X: -ex, Z: -ez}, {X: -ex, Z: ez}}
	// Crossing tests run against the TRUE footprint, not the expanded
	// rect: legs may cut through the padding ring (a mover pressed against
	// a wall starts inside it), just never through the building itself.
	inEx := hx
	inEz := hz
	best, second := -1, -1
	var bestCost, secondCost fixed.Fixed
	for i, c := range corners {
		if segmentCrossesRect(lp, c, inEx, inEz) {
			continue // the leg to this corner cuts through the building
		}
		world := yardToWorld(s, c)
		// The corner AND the walk to it must be terrain-legal — a corridor
		// pinched by a cliff or shoreline rules its whole flank out.
		if w.terrain != nil && !w.legLegal(u, world) {
			continue
		}
		cost := lp.DistTo(c) + c.DistTo(lt)
		// A corner whose EXIT leg still crosses the building needs a
		// second corner after it — cost in the extra side length so a
		// straight-exit corner always wins over parking on a corner that
		// can't see the target.
		if segmentCrossesRect(c, lt, inEx, inEz) {
			cost += ex + ez
		}
		switch {
		case best == -1 || cost < bestCost:
			second, secondCost = best, bestCost
			best, bestCost = i, cost
		case second == -1 || cost < secondCost:
			second, secondCost = i, cost
		}
	}
	if best == -1 {
		return fixed.Vec2{}, false
	}
	pick := best
	if u.avoidFlip && second != -1 {
		pick = second
	}
	return yardToWorld(s, corners[pick]), true
}

// legLegal samples the straight walk from the unit to p (every ~20wu plus
// the endpoint) against terrain legality, so route candidates that thread
// an impassable corridor are rejected before the unit wedges in them.
func (w *World) legLegal(u *Unit, p fixed.Vec2) bool {
	if !w.canStand(u.Meta, p) {
		return false
	}
	d := p.Sub(u.loco.Pos)
	l := d.Len()
	step := fixed.FromInt(20)
	if l <= step {
		return w.canTraverse(u.Meta, u.loco.Pos, p)
	}
	n := l.Div(step).Int()
	prev := u.loco.Pos
	for i := 1; i <= n; i++ {
		t := fixed.FromInt(i).Mul(step).Div(l)
		q := fixed.Vec2{X: u.loco.Pos.X + d.X.Mul(t), Z: u.loco.Pos.Z + d.Z.Mul(t)}
		if !w.canTraverse(u.Meta, prev, q) {
			return false
		}
		prev = q
	}
	return w.canTraverse(u.Meta, prev, p)
}

// yardToWorld is the inverse of yardLocal: structure-local → world.
func yardToWorld(s *Unit, l fixed.Vec2) fixed.Vec2 {
	sin, cos := fixed.SinCos(int32(s.Heading()))
	return fixed.Vec2{
		X: s.loco.Pos.X + l.X.Mul(cos) + l.Z.Mul(sin),
		Z: s.loco.Pos.Z - l.X.Mul(sin) + l.Z.Mul(cos),
	}
}

// segmentCrossesRect reports whether the segment a→b (in rect-local space)
// passes through the axis-aligned rectangle |x|<ex, |z|<ez — a standard
// slab clip.
func segmentCrossesRect(a, b fixed.Vec2, ex, ez fixed.Fixed) bool {
	// Both endpoints inside is trivially a crossing.
	inside := func(p fixed.Vec2) bool { return p.X.Abs() < ex && p.Z.Abs() < ez }
	if inside(a) || inside(b) {
		return true
	}
	d := b.Sub(a)
	tmin := fixed.Fixed(0)
	tmax := fixed.FromInt(1)
	// Liang–Barsky against the four slabs: each entry encodes q*t <= p.
	type slab struct{ q, p fixed.Fixed }
	slabs := [4]slab{
		{q: -d.X, p: a.X + ex}, // x >= -ex
		{q: d.X, p: ex - a.X},  // x <= ex
		{q: -d.Z, p: a.Z + ez}, // z >= -ez
		{q: d.Z, p: ez - a.Z},  // z <= ez
	}
	for _, sl := range slabs {
		if sl.q == 0 {
			if sl.p < 0 {
				return false
			}
			continue
		}
		t := sl.p.Div(sl.q)
		if sl.q < 0 {
			if t > tmin {
				tmin = t
			}
		} else {
			if t < tmax {
				tmax = t
			}
		}
		if tmin > tmax {
			return false
		}
	}
	return true
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
// Structure-vs-mobile pairs resolve against the structure's yardmap cells
// instead of a circle, so footprints (and their rotation) collide true.
func (w *World) separate(a, b *Unit) {
	ay, by := hasYard(a), hasYard(b)
	switch {
	case ay && by:
		return // standing structures never overlap-resolve each other
	case ay:
		w.separateFromYard(b, a)
		return
	case by:
		w.separateFromYard(a, b)
		return
	}
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

// separateFromYard pushes a mobile body out of a structure's blocking yard
// cells. The structure holds its ground; only the mover shifts.
func (w *World) separateFromYard(m, s *Unit) {
	if !canBePushed(m) {
		return
	}
	r := m.Meta.collisionRadius()
	push, hit := yardResolve(s, m.loco.Pos, r)
	if !hit {
		return
	}
	m.loco.Pos.X += push.X
	m.loco.Pos.Z += push.Z
	// Park-beside-it arrival only applies when the destination itself sits
	// in the structure's blocked cells — a mover grazing a wall on its way
	// PAST the building must keep its order.
	if yardCircleOverlaps(s, m.moveTarget, r) {
		hx, hz := yardHalfExtents(s.Meta)
		w.relaxArrival(m, s, r+fixed.Max(hx, hz))
	}
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
