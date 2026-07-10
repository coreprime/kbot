package sim

import "github.com/coreprime/kbot/engine/fixed"

// Grid pathfinding over the terrain cell grid. Local avoidance (collision.go)
// steers a unit around the dynamic units in front of it, but it cannot solve
// a maze, a spiral hill, or a wall of factories — it only ever sees the next
// obstacle. findPath runs A* over terrain passability (directional slope,
// water, voids) plus static building footprints, returning a smoothed list of
// world-space waypoints the unit follows. Recomputed on a move order and when
// the follower stalls; deterministic, so every client that applies the same
// orders walks the same route.

// pathMaxExpand is the hard ceiling on A* cell expansions — a backstop for
// pathologically huge maps so an unreachable goal can't stall a tick. The
// effective budget is the grid's cell count (each cell is expanded at most
// once via the closed set), clamped to this; it's set well above any real
// TA/TA:K map so a reachable goal across a full-size map is always found.
const pathMaxExpand = 1_000_000

// pathScratch holds the reusable A* working set, sized to the installed
// terrain. Generation stamps (cur) mark which cells were touched this run so
// successive searches need no full clear; only the heap is reset.
type pathScratch struct {
	w, h    int
	cur     uint32
	gen     []uint32 // gen[i]==cur → visited this run; gScore/parent valid
	block   []uint32 // block[i]==cur → a building footprint covers cell i
	closed  []uint32 // closed[i]==cur → already expanded this run (skip on pop)
	gScore  []int32
	parent  []int32
	heap    []pfNode
}

type pfNode struct {
	f, idx int32
}

func (w *World) ensurePathScratch() *pathScratch {
	t := w.terrain
	if t == nil {
		return nil
	}
	ps := w.pathScratch
	if ps == nil || ps.w != t.W || ps.h != t.H {
		n := t.W * t.H
		ps = &pathScratch{
			w: t.W, h: t.H,
			gen:    make([]uint32, n),
			block:  make([]uint32, n),
			closed: make([]uint32, n),
			gScore: make([]int32, n),
			parent: make([]int32, n),
		}
		w.pathScratch = ps
	}
	return ps
}

// ensurePath lazily computes a unit's path to its move target the first time
// it steps (within the per-tick budget), so a move order pays its A* once and
// a big group spreads the cost. A unit whose search found nothing keeps
// pathTried set and steers directly until a stall forces a retry.
func (w *World) ensurePath(u *Unit) {
	if u.pathTried || u.Meta == nil || u.Meta.IsAircraft || w.terrain == nil || !u.pathEligible() {
		return
	}
	if w.pathBudget <= 0 {
		return // try a later tick
	}
	w.pathBudget--
	u.pathTried = true
	u.path = w.findPath(u.Meta, u.loco.Pos, u.moveTarget)
	u.pathIdx = 0
}

// pathEligible reports whether a move should be globally pathed. Chases
// (hasAttack) and transport pickup/drop runs steer DIRECTLY at a target that
// moves every tick — re-running A* on them would thrash and is pointless;
// only fixed-destination Move/Patrol/Build orders path.
func (u *Unit) pathEligible() bool {
	return !u.hasAttack && u.loadTarget == 0 && !u.hasUnload
}

// clearPath drops a unit's route so the next move tick recomputes it. Called
// when a new destination is set or the unit is rerouted.
func (u *Unit) clearPath() {
	u.path = nil
	u.pathIdx = 0
	u.pathTried = false
	u.pathFails = 0
}

// currentGoal is the point the unit should steer toward this tick: the active
// path waypoint, or the final move target when no path (or path exhausted, or
// the move is a direct-steer chase/transport run).
func (u *Unit) currentGoal() fixed.Vec2 {
	if u.pathEligible() && u.pathIdx < len(u.path) {
		return u.path[u.pathIdx]
	}
	return u.moveTarget
}

// goalIsFinal reports whether the current goal is the real destination (no
// path, last waypoint, or a direct-steer move) rather than an intermediate.
func (u *Unit) goalIsFinal() bool {
	if !u.pathEligible() {
		return true
	}
	return u.pathIdx >= len(u.path)-1
}

// findPath returns the smoothed waypoint list from `from` to `to` for a unit
// of meta m, or nil when there is no terrain, the goal is unreachable, or the
// search exceeds its budget (caller then steers directly). The returned list
// excludes the start and ends at `to`.
func (w *World) findPath(m *UnitMeta, from, to fixed.Vec2) []fixed.Vec2 {
	t := w.terrain
	if t == nil || m == nil || m.IsAircraft {
		return nil
	}
	ps := w.ensurePathScratch()
	if ps == nil {
		return nil
	}
	W, H := t.W, t.H
	cell := func(p fixed.Vec2) (int, int) {
		return p.X.Div(t.CellWU).Int(), p.Z.Div(t.CellWU).Int()
	}
	inb := func(cx, cz int) bool { return cx >= 0 && cz >= 0 && cx < W && cz < H }
	idxOf := func(cx, cz int) int32 { return int32(cz*W + cx) }
	half := t.CellWU.Div(fixed.FromInt(2))
	centre := func(cx, cz int) fixed.Vec2 {
		return fixed.Vec2{X: fixed.FromInt(cx).Mul(t.CellWU) + half, Z: fixed.FromInt(cz).Mul(t.CellWU) + half}
	}

	sx, sz := cell(from)
	gx, gz := cell(to)
	if !inb(sx, sz) || !inb(gx, gz) {
		return nil
	}

	// New run: bump the generation (clearing on overflow), reset the heap.
	ps.cur++
	if ps.cur == 0 {
		for i := range ps.gen {
			ps.gen[i] = 0
			ps.block[i] = 0
		}
		ps.cur = 1
	}
	ps.heap = ps.heap[:0]

	// Mark building footprints (inflated by the mover's body radius) blocked,
	// so the route hugs a structure's true silhouette plus clearance and a
	// line of factories reads as one wall. The start cell is force-cleared
	// below so a unit parked against a building can still leave.
	urCells := ur2cells(m.collisionRadius(), t.CellWU)
	for _, id := range w.order {
		o := w.units[id]
		if o == nil || o.Dead || !hasYard(o) {
			continue
		}
		hx, hz := yardHalfExtents(o.Meta)
		minX := (o.loco.Pos.X - hx).Div(t.CellWU).Int() - urCells
		maxX := (o.loco.Pos.X + hx).Div(t.CellWU).Int() + urCells
		minZ := (o.loco.Pos.Z - hz).Div(t.CellWU).Int() - urCells
		maxZ := (o.loco.Pos.Z + hz).Div(t.CellWU).Int() + urCells
		for cz := minZ; cz <= maxZ; cz++ {
			for cx := minX; cx <= maxX; cx++ {
				if inb(cx, cz) {
					ps.block[cz*W+cx] = ps.cur
				}
			}
		}
	}
	blocked := func(cx, cz int) bool { return ps.block[cz*W+cx] == ps.cur }
	// Always let the mover leave its own cell — and, if it is boxed inside an
	// inflated footprint (a structure raised right next to it), the cells
	// immediately around it too, so it can still escape to open ground rather
	// than reporting no path.
	esc := urCells + 1
	for cz := sz - esc; cz <= sz+esc; cz++ {
		for cx := sx - esc; cx <= sx+esc; cx++ {
			if inb(cx, cz) {
				ps.block[cz*W+cx] = ps.cur - 1
			}
		}
	}

	// Snap the goal to the nearest standable, unblocked cell when it lands on
	// a building, in water, or off a cliff — a move onto an illegal spot
	// targets the closest legal ground.
	if blocked(gx, gz) || !w.canStand(m, centre(gx, gz)) {
		ngx, ngz, ok := w.nearestOpenCell(m, gx, gz, blocked, centre, inb)
		if !ok {
			return nil
		}
		gx, gz = ngx, ngz
	}
	goalIdx := idxOf(gx, gz)

	// A*.
	startIdx := idxOf(sx, sz)
	ps.gen[startIdx] = ps.cur
	ps.gScore[startIdx] = 0
	ps.parent[startIdx] = -1
	hpush(ps, pfNode{f: int32(octile(sx, sz, gx, gz)), idx: startIdx})

	dirs := [8][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {1, 1}, {1, -1}, {-1, 1}, {-1, -1}}
	// Expansion budget: every cell is expanded at most once (the closed-set
	// below skips stale heap entries), so the whole grid is the true ceiling.
	// The old fixed cap (140000) was smaller than a large map's cell count, so
	// a reachable goal across a big map (the King of the Hill spiral) gave up
	// early and the unit fell back to direct steering into a cliff.
	cap := W * ps.h
	if cap > pathMaxExpand {
		cap = pathMaxExpand
	}
	expanded := 0
	found := false
	for len(ps.heap) > 0 {
		cur := hpop(ps)
		if cur.idx == goalIdx {
			found = true
			break
		}
		// Skip stale heap entries — a cell already expanded via a cheaper path.
		if ps.closed[cur.idx] == ps.cur {
			continue
		}
		ps.closed[cur.idx] = ps.cur
		expanded++
		if expanded > cap {
			return nil
		}
		ccx := int(cur.idx) % W
		ccz := int(cur.idx) / W
		cg := ps.gScore[cur.idx]
		cc := centre(ccx, ccz)
		for di, d := range dirs {
			nx, nz := ccx+d[0], ccz+d[1]
			if !inb(nx, nz) || blocked(nx, nz) {
				continue
			}
			diag := di >= 4
			if diag {
				// No cutting the corner of a wall: both shared orthogonal
				// cells must be open AND traversable.
				if blocked(ccx+d[0], ccz) || blocked(ccx, ccz+d[1]) {
					continue
				}
				if !w.canTraverse(m, cc, centre(ccx+d[0], ccz)) || !w.canTraverse(m, cc, centre(ccx, ccz+d[1])) {
					continue
				}
			}
			ncentre := centre(nx, nz)
			if !w.canTraverse(m, cc, ncentre) {
				continue
			}
			// Step costs 10/14 with the octile heuristic — the sandbox
			// stand-in pending the passability block, which brings the
			// engines' exact costs (orth 0x10, diag 0x16 TA / 0x17 TA:K,
			// heuristic unresolved) together with the per-class blocker
			// raster and its penalty tier.
			step := int32(10)
			if diag {
				step = 14
			}
			ng := cg + step
			nIdx := idxOf(nx, nz)
			if ps.gen[nIdx] == ps.cur && ps.gScore[nIdx] <= ng {
				continue
			}
			ps.gen[nIdx] = ps.cur
			ps.gScore[nIdx] = ng
			ps.parent[nIdx] = cur.idx
			hpush(ps, pfNode{f: ng + int32(octile(nx, nz, gx, gz)), idx: nIdx})
		}
	}
	if !found {
		return nil
	}

	// Reconstruct the start→goal cell chain and return it DENSE — one
	// waypoint per path cell, the engines' contract (a 64-entry ring in the
	// real pathfinders, unbounded here). There is no smoothing pass: smooth
	// motion is emergent from the mover's 80 wu aim pull-in and its ~5-cell
	// waypoint consume radius, both of which assume adjacent waypoints are
	// never more than a cell apart (a sparse smoothed chain would let the
	// consume radius jump the steering target across a wall corner).
	var chain []fixed.Vec2
	for i := goalIdx; i != -1; i = ps.parent[i] {
		chain = append(chain, centre(int(i)%W, int(i)/W))
		if i == startIdx {
			break
		}
	}
	// chain is goal→start; reverse to start→goal.
	for l, r := 0, len(chain)-1; l < r; l, r = l+1, r-1 {
		chain[l], chain[r] = chain[r], chain[l]
	}
	if w.canStand(m, to) {
		chain[len(chain)-1] = to
	}
	return chain[1:]
}

// nearestOpenCell spirals outward from (gx,gz) for the closest standable,
// unblocked cell — used to snap a goal that landed on a building or in water.
// Divergent stand-in: the engines run a boundary-trace (wall-following)
// fallback here instead; it arrives with the passability block.
func (w *World) nearestOpenCell(m *UnitMeta, gx, gz int, blocked func(cx, cz int) bool, centre func(cx, cz int) fixed.Vec2, inb func(cx, cz int) bool) (int, int, bool) {
	for r := 1; r <= 10; r++ {
		for cz := gz - r; cz <= gz+r; cz++ {
			for cx := gx - r; cx <= gx+r; cx++ {
				if cx != gx-r && cx != gx+r && cz != gz-r && cz != gz+r {
					continue // ring only
				}
				if inb(cx, cz) && !blocked(cx, cz) && w.canStand(m, centre(cx, cz)) {
					return cx, cz, true
				}
			}
		}
	}
	return 0, 0, false
}

// octile is the 8-connected admissible heuristic in step-cost units (orth 10,
// diag 14).
func octile(ax, az, bx, bz int) int {
	dx := ax - bx
	if dx < 0 {
		dx = -dx
	}
	dz := az - bz
	if dz < 0 {
		dz = -dz
	}
	mn, mx := dx, dz
	if mn > mx {
		mn, mx = mx, mn
	}
	return 10*mx + 4*mn // 10*(max-min) + 14*min
}

// ur2cells converts a body radius to a cell-count inflation for footprint
// blocking (round up so a unit never clips a wall it should round).
func ur2cells(r, cellWU fixed.Fixed) int {
	c := r.Div(cellWU).Int()
	if r > fixed.FromInt(c).Mul(cellWU) {
		c++
	}
	if c < 0 {
		c = 0
	}
	return c
}

// ── Binary min-heap on (f, idx) ──────────────────────────────────────
// A node beats another by lower f, ties by lower cell index — a stable,
// deterministic order so every client expands cells identically.

func pfLess(a, b pfNode) bool { return a.f < b.f || (a.f == b.f && a.idx < b.idx) }

func hpush(ps *pathScratch, n pfNode) {
	ps.heap = append(ps.heap, n)
	i := len(ps.heap) - 1
	for i > 0 {
		p := (i - 1) / 2
		if !pfLess(ps.heap[i], ps.heap[p]) {
			break
		}
		ps.heap[i], ps.heap[p] = ps.heap[p], ps.heap[i]
		i = p
	}
}

func hpop(ps *pathScratch) pfNode {
	h := ps.heap
	top := h[0]
	last := len(h) - 1
	h[0] = h[last]
	h = h[:last]
	ps.heap = h
	i := 0
	for {
		l, r := 2*i+1, 2*i+2
		small := i
		if l < len(h) && pfLess(h[l], h[small]) {
			small = l
		}
		if r < len(h) && pfLess(h[r], h[small]) {
			small = r
		}
		if small == i {
			break
		}
		h[i], h[small] = h[small], h[i]
		i = small
	}
	return top
}
