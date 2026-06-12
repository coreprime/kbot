package sim

import "github.com/coreprime/kbot/engine/fixed"

// Yardmap-based structure collision. A standing structure occupies the
// rectangle of its FBI footprint (8-wu map squares), refined by its YardMap:
// each cell is permanently blocked, always passable, or passable only while
// the structure's yard is open (a factory's exit channel). The rectangle
// rotates with the unit's heading, so a turned building collides true to its
// silhouette, and movers test against cells rather than a single circle —
// which is what lets a kbot drive through an open factory.

// yardCell is one footprint square's occupancy class.
type yardCell uint8

const (
	yardPassable yardCell = iota // never blocks
	yardSolid                    // always blocks
	yardOpenable                 // blocks only while the yard is closed
)

// yardSquareWU is the side of one footprint square in world units.
var yardSquareWU = fixed.FromInt(8)

// ParseYardMap converts an FBI YardMap string into a row-major fz×fx cell
// grid. Whitespace separates rows visually but cells are consumed in reading
// order; a string shorter than the footprint pads with solid cells, and an
// empty string yields nil (callers treat a nil grid as fully solid).
//
// Cell codes follow the TA convention: o/w/g/f and friends are ground the
// structure occupies, c (and the water/geo C/G variants) opens with the
// yard, y/Y never blocks.
func ParseYardMap(s string, fx, fz int) []yardCell {
	if fx <= 0 || fz <= 0 {
		return nil
	}
	cells := make([]yardCell, 0, fx*fz)
	for _, ch := range s {
		if len(cells) == fx*fz {
			break
		}
		switch ch {
		case ' ', '\t', '\r', '\n':
			continue
		case 'y', 'Y':
			cells = append(cells, yardPassable)
		case 'c', 'C', 'G':
			cells = append(cells, yardOpenable)
		default:
			cells = append(cells, yardSolid)
		}
	}
	if len(cells) == 0 {
		return nil
	}
	for len(cells) < fx*fz {
		cells = append(cells, yardSolid)
	}
	return cells
}

// hasYard reports whether the unit collides as a footprint rectangle: a
// standing (immobile, surface) structure with a footprint. Mobile units stay
// on the circle model.
func hasYard(u *Unit) bool {
	return u.Meta != nil && !u.Meta.CanMove && !u.Meta.IsAircraft &&
		u.Meta.FootprintX > 0 && u.Meta.FootprintZ > 0
}

// yardCellAt returns the occupancy class of grid cell (cx, cz). A structure
// without a parsed YardMap is solid everywhere.
func yardCellAt(m *UnitMeta, cx, cz int) yardCell {
	if cx < 0 || cz < 0 || cx >= m.FootprintX || cz >= m.FootprintZ {
		return yardPassable
	}
	if len(m.Yard) != m.FootprintX*m.FootprintZ {
		return yardSolid
	}
	return m.Yard[cz*m.FootprintX+cx]
}

// yardCellBlocks reports whether the structure's cell (cx, cz) blocks
// movement right now, honouring the open/closed yard state.
func yardCellBlocks(s *Unit, cx, cz int) bool {
	switch yardCellAt(s.Meta, cx, cz) {
	case yardSolid:
		return true
	case yardOpenable:
		return !s.yardOpen
	}
	return false
}

// yardLocal transforms a world point into the structure's footprint frame:
// origin at the unit centre, +z out the front (the facing factoryPad and
// rolloff use), axes following the unit's heading. This is what makes a
// rotated structure collide along its turned silhouette.
func yardLocal(s *Unit, p fixed.Vec2) fixed.Vec2 {
	sin, cos := fixed.SinCos(int32(s.Heading()))
	d := p.Sub(s.loco.Pos)
	return fixed.Vec2{
		X: d.X.Mul(cos) - d.Z.Mul(sin),
		Z: d.X.Mul(sin) + d.Z.Mul(cos),
	}
}

// yardHalfExtents returns the footprint rectangle's half sides in wu.
func yardHalfExtents(m *UnitMeta) (hx, hz fixed.Fixed) {
	return fixed.FromInt(m.FootprintX * 4), fixed.FromInt(m.FootprintZ * 4)
}

// yardCircleOverlaps reports whether a body circle at world point p with
// radius r touches any currently-blocking cell of the structure. Shared by
// the hard separation pass and clear-ground searches (rolloff, drop spots).
func yardCircleOverlaps(s *Unit, p fixed.Vec2, r fixed.Fixed) bool {
	push, hit := yardResolve(s, p, r)
	_ = push
	return hit
}

// yardResolve computes the minimal world-space push that moves a body circle
// (centre p, radius r) out of the structure's blocking cells. hit is false
// when the circle is clear. A centre caught inside a blocked cell is ejected
// the short way out of the whole footprint rectangle, so nothing tunnels in
// or gets squeezed deeper.
func yardResolve(s *Unit, p fixed.Vec2, r fixed.Fixed) (push fixed.Vec2, hit bool) {
	hx, hz := yardHalfExtents(s.Meta)
	l := yardLocal(s, p)
	if l.X.Abs() > hx+r || l.Z.Abs() > hz+r {
		return fixed.Vec2{}, false
	}
	// Cell range the circle can touch.
	cx0 := (l.X - r + hx).Div(yardSquareWU).Int()
	cx1 := (l.X + r + hx).Div(yardSquareWU).Int()
	cz0 := (l.Z - r + hz).Div(yardSquareWU).Int()
	cz1 := (l.Z + r + hz).Div(yardSquareWU).Int()
	fx, fz := s.Meta.FootprintX, s.Meta.FootprintZ
	clampi := func(v, lo, hi int) int {
		if v < lo {
			return lo
		}
		if v > hi {
			return hi
		}
		return v
	}
	cx0, cx1 = clampi(cx0, 0, fx-1), clampi(cx1, 0, fx-1)
	cz0, cz1 = clampi(cz0, 0, fz-1), clampi(cz1, 0, fz-1)

	var best fixed.Vec2
	var bestDepth fixed.Fixed = -1
	for cz := cz0; cz <= cz1; cz++ {
		for cx := cx0; cx <= cx1; cx++ {
			if !yardCellBlocks(s, cx, cz) {
				continue
			}
			minX := yardSquareWU.Mul(fixed.FromInt(cx)) - hx
			maxX := minX + yardSquareWU
			minZ := yardSquareWU.Mul(fixed.FromInt(cz)) - hz
			maxZ := minZ + yardSquareWU
			// Closest point on the cell to the circle centre. The overlap
			// gate compares squared distances exactly — the fixed sqrt can
			// round a tangent contact down a hair, and that phantom hit
			// would cancel move orders via the arrival relax.
			qx := fixed.Clamp(l.X, minX, maxX)
			qz := fixed.Clamp(l.Z, minZ, maxZ)
			d := fixed.Vec2{X: l.X - qx, Z: l.Z - qz}
			if d.X.Mul(d.X)+d.Z.Mul(d.Z) >= r.Mul(r) {
				continue
			}
			dist := d.Len()
			var dir fixed.Vec2
			var depth fixed.Fixed
			if dist > fixed.FromFloat(0.05) {
				dir = fixed.Vec2{X: d.X.Div(dist), Z: d.Z.Div(dist)}
				depth = r - dist
			} else {
				// Centre inside the cell: eject the short way out of the
				// whole rectangle so the push converges in one direction.
				dir, depth = yardEject(l, hx, hz)
				depth += r
			}
			if depth > bestDepth {
				bestDepth = depth
				best = fixed.Vec2{X: dir.X.Mul(depth), Z: dir.Z.Mul(depth)}
			}
		}
	}
	if bestDepth < 0 {
		return fixed.Vec2{}, false
	}
	// Rotate the local push back into world axes (inverse of yardLocal).
	sin, cos := fixed.SinCos(int32(s.Heading()))
	return fixed.Vec2{
		X: best.X.Mul(cos) + best.Z.Mul(sin),
		Z: best.Z.Mul(cos) - best.X.Mul(sin),
	}, true
}

// yardEject picks the shortest axis-aligned exit from the footprint
// rectangle for a point inside it.
func yardEject(l fixed.Vec2, hx, hz fixed.Fixed) (dir fixed.Vec2, depth fixed.Fixed) {
	dxPos := hx - l.X // distance to the +x edge
	dxNeg := l.X + hx
	dzPos := hz - l.Z
	dzNeg := l.Z + hz
	dir = fixed.Vec2{X: fixed.One}
	depth = dxPos
	if dxNeg < depth {
		dir, depth = fixed.Vec2{X: -fixed.One}, dxNeg
	}
	if dzPos < depth {
		dir, depth = fixed.Vec2{Z: fixed.One}, dzPos
	}
	if dzNeg < depth {
		dir, depth = fixed.Vec2{Z: -fixed.One}, dzNeg
	}
	return dir, depth
}

// stepYards refreshes every structure's yard state for this tick. A yard is
// open while the structure is working its pad (producing or about to) or
// while any live surface unit stands within its footprint — the latter so a
// closing yard never traps the unit rolling out of it.
func (w *World) stepYards() {
	for _, id := range w.order {
		s := w.units[id]
		if s == nil || s.Dead || !hasYard(s) {
			continue
		}
		open := s.buildState != buildIdle || len(s.prodQueue) > 0 ||
			portValue(s, cobPortYardOpen) != 0
		if !open {
			hx, hz := yardHalfExtents(s.Meta)
			for _, oid := range w.order {
				o := w.units[oid]
				if o == nil || o == s || !collidable(o) || !o.Meta.CanMove {
					continue
				}
				l := yardLocal(s, o.loco.Pos)
				if l.X.Abs() < hx && l.Z.Abs() < hz {
					open = true
					break
				}
			}
		}
		s.yardOpen = open
	}
}