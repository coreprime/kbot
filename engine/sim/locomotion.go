package sim

import "github.com/coreprime/kbot/engine/fixed"

// Ground locomotion — the engines' exact per-frame movement law
// (locomotion spec §1-§3). One integration per sim frame in wu/frame:
// a bang-bang speed scalar (±accel/brake, never coasting), the pitch-band
// slope-speed cap, the stopping-distance + turn-hardness brake decision on
// 64-bit squares, the 80 wu waypoint pull-in, and the blocked half-speed
// slide. All math is 32-bit 16.16 with 64-bit intermediates.

// locoState is the mutable motion state stepped each tick. Heading is a
// fractional TA-angle held in the engines' int16 wrap convention (the integer
// part feeds the sine table); position and speed are 16.16 values truncated
// to the engines' 32-bit storage width on every store.
type locoState struct {
	Pos     fixed.Vec2
	Heading fixed.Fixed // TA-angle, fractional, int16-wrapped
	Speed   fixed.Fixed // wu per frame, 16.16 (the engines' speed scalar)
	// Turn is the turn applied this frame (s16 angle units) and Blocked the
	// blocked-step bit; both feed the walk-animation tier (§7): turning in
	// place counts as moving, a blocked slide forces tier 0.
	Turn    int32
	Blocked bool
}

// angle helpers in fixed TA-angle units.
var (
	fxFullCircle = fixed.FromInt(int(fixed.FullCircle))
	fxHalfCircle = fixed.FromInt(int(fixed.HalfCircle))
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

// headingVec returns the forward unit vector for a heading: (sin, cos) read
// from the engine sine table, matching the convention heading 0 = +Z.
func headingVec(heading fixed.Fixed) (sin, cos fixed.Fixed) {
	return fixed.SinCos(int32(heading.Int()))
}

// advance integrates one tick of motion along the heading: the engines'
// sine-table decomposition with their exact product rounding, stores wrapped
// to 32 bits. step is the per-tick distance in 16.16 world units. The sandbox
// keeps its own sign convention (heading 0 = +Z, +sin on X); the engines
// negate both components — a render/wire boundary concern, not a sim one.
func (st *locoState) advance(step fixed.Fixed) {
	h := int32(st.Heading.Int())
	st.Pos.X = fixed.Wrap32(st.Pos.X + fixed.SinScaled(h, step))
	st.Pos.Z = fixed.Wrap32(st.Pos.Z + fixed.CosScaled(h, step))
}

// setHeading stores a heading in the int16 wrap convention.
func (st *locoState) setHeading(h fixed.Fixed) {
	st.Heading = fixed.WrapAngleFx(h)
}

// hi32sq is the high dword of the 64-bit square of a 16.16 value — whole-wu²
// resolution. The brake and turn-hardness tests compare only these high
// dwords, which is why braking begins one frame early rather than after an
// overshoot.
func hi32sq(v fixed.Fixed) int64 {
	p := int64(v) * int64(v)
	return p >> 32
}

// setTurnRate applies one frame of turning: clamp the wrapped bearing error
// to ±turnrate and add it to the heading (16-bit wrap). Turning is
// unconditional — a target behind the unit turns at full rate while the
// turn-hardness brake test holds speed down; there is no separate pivot
// state, and the heading snaps to the bearing once |err| ≤ turnrate.
func (w *World) setTurnRate(u *Unit, err int32) {
	st := &u.loco
	if err == 0 {
		st.Turn = 0
		return
	}
	tr := w.turnPerFrame(u)
	t := err
	if t > tr {
		t = tr
	} else if t < -tr {
		t = -tr
	}
	st.Turn = t
	st.setHeading(st.Heading + fixed.FromInt(int(t)))
}

// turnPerFrame is the per-frame turn clamp for this unit: the raw FBI
// turnrate under the TA dialect; the TA:K dialect applies its >>3 scale and
// the in-water stat multiplier (motion_convention.go).
func (w *World) turnPerFrame(u *Unit) int32 {
	tr := int32(u.Meta.TurnRate.Int())
	return u.motionConvention().turnPerFrame(tr, w.takStatScale(u))
}

// pullInRadius is the waypoint corner-cutting distance: beyond 80 wu of the
// current waypoint the unit aims short of it, toward the next one. TA uses
// the fixed 0x500000; TA:K uses 5 cells normally — the same 80 wu — and 1
// cell in formation mode (no squad/formation layer exists in the sandbox yet,
// so the formation variant waits on it).
const pullInRadius = fixed.Fixed(0x500000)

// aimPullIn slides the steering aim from the current waypoint toward the next
// one when the waypoint is still far away, so paths corner-cut smoothly
// instead of visiting every waypoint exactly.
func aimPullIn(pos, tgt, next fixed.Vec2, dist fixed.Fixed) fixed.Vec2 {
	if dist <= pullInRadius {
		return tgt
	}
	tn := tgt.Sub(next)
	toNext := tn.Len()
	if toNext <= fixed.Fixed(0xffff) {
		return tgt
	}
	pull := fixed.Min(dist-pullInRadius, toNext)
	return fixed.Vec2{
		X: fixed.Wrap32(tgt.X - tn.X.Div(toNext).Mul(pull)),
		Z: fixed.Wrap32(tgt.Z - tn.Z.Div(toNext).Mul(pull)),
	}
}

// brakeStopDist is the exact kinematic stopping distance v²/(2b) as a 16.16
// wu quantity: (speed² >> 16) divided by twice the brake rate. A unit with no
// brake rate reports 0 (it can always "stop"), a sandbox guard for malformed
// FBIs — the engines divide unconditionally and stock mobiles always declare
// one.
func brakeStopDist(speed, brake fixed.Fixed) fixed.Fixed {
	if brake <= 0 {
		return 0
	}
	num := fixed.Fixed((int64(speed) * int64(speed)) >> 16)
	return num.Div(fixed.Wrap32(brake << 1))
}

// stepGroundToward runs one frame of the ground movement law with a live
// steering target: steer + accel-vs-brake decision, velocity update, position
// integration. next, when non-nil, is the following waypoint for the pull-in.
func (w *World) stepGroundToward(u *Unit, tgt fixed.Vec2, next *fixed.Vec2) {
	st := &u.loco
	m := u.Meta

	d := tgt.Sub(st.Pos)
	dist := d.Len()
	aim := tgt
	if next != nil {
		aim = aimPullIn(st.Pos, tgt, *next, dist)
	}
	da := aim.Sub(st.Pos)
	distAim := dist
	if aim != tgt {
		distAim = da.Len()
	}
	bearing := fixed.Atan2(da.X, da.Z)
	err := fixed.WrapAngle(bearing - int32(st.Heading.Int()))
	w.setTurnRate(u, err)

	// Accelerate only when the unit is not turning too hard for the distance
	// (dist ≥ 2·speed·|err|/turnrate, tested as 4·turnQty² < dist²(aim)) AND
	// can still stop in time (brakeDist² < dist² against the true waypoint).
	// Everything else brakes — there is no coast state.
	delta := fixed.Wrap32(-m.BrakeRate)
	tr := int64(w.turnPerFrame(u))
	if tr < 1 {
		tr = 1
	}
	aerr := int64(err)
	if aerr < 0 {
		aerr = -aerr
	}
	// 64-bit product truncated to the engines' i32 result width.
	turnQty := fixed.Fixed(int32((int64(st.Speed) * aerr) / tr))
	bd := brakeStopDist(st.Speed, m.BrakeRate)
	if 4*hi32sq(turnQty) < hi32sq(distAim) && hi32sq(bd) < hi32sq(dist) {
		delta = m.Accel
	}
	w.updateGroundVelocity(u, delta)
	w.integrateGroundPosition(u)
}

// stepGroundIdle runs one frame with no steering target: turn rate 0 and
// -brakerate every frame until the ≥0 clamp brings the unit to rest — there
// is no instant stop. Position keeps integrating while speed drains, so a
// stopped order coasts through its brake ramp.
func (w *World) stepGroundIdle(u *Unit) {
	st := &u.loco
	st.Turn = 0
	if st.Speed == 0 {
		st.Blocked = false
		return
	}
	w.updateGroundVelocity(u, fixed.Wrap32(-u.Meta.BrakeRate))
	w.integrateGroundPosition(u)
}

// updateGroundVelocity applies this frame's ±delta to the speed scalar and
// clamps it: never below 0, and never above the slope-band cap (which only
// ever clamps DOWN — cresting a hill does not add speed; the unit must
// re-accelerate after any cap dip).
func (w *World) updateGroundVelocity(u *Unit, delta fixed.Fixed) {
	st := &u.loco
	m := u.Meta
	conv := u.motionConvention()
	scale := w.takStatScale(u)

	sp := fixed.Wrap32(st.Speed + conv.scaleStat(delta, scale))
	if sp < 0 {
		sp = 0
	}
	// TA:K squad speed-matching seam: a unit in a squad takes its commanded
	// speed from the squad slot and clamps against its own limits (§1.4-2).
	// The sandbox has no squad/formation layer yet; commandedSpeed stays 0
	// until the order-layer block supplies it.
	if u.commandedSpeed > 0 && sp > u.commandedSpeed {
		sp = u.commandedSpeed
	}
	// TA:K gait tiers seam (§1.4-1): motion-status bits 8-10 scale both the
	// candidate speed and the cap — ×0xaac0>>16 (2/3) for state 0x100 and
	// ×0x553f>>16 (1/3) for 0x200. The bits come from the per-cell 3-bit
	// terrain-type codes of the TA:K blocker raster, which lands with the
	// passability block; until then every unit runs the full gait.
	maxv := conv.scaleStat(m.MaxVelocity, scale)
	cap := conv.slopeCap(maxv, u.pitch)
	// Aircraft borrow this integrator as their cruise stand-in (§10.7); the
	// engines' water rules never apply to them.
	if !m.IsAircraft && conv.underwaterHalves(m) && w.unitUnderwater(u) {
		cap = fixed.Fixed((int64(cap) * 0x8000) >> 16)
	}
	if cap < sp {
		sp = cap
	}
	st.Speed = fixed.Wrap32(sp)
}

// slideHalfCell is the blocked-step clamp: half a footprint cell less one
// (0x7ffff ≈ 8 wu), keeping a blocked mover pressed just inside its current
// cell on each axis.
const slideHalfCell = fixed.Fixed(0x7ffff)

// integrateGroundPosition adds the frame's velocity to the position. A step
// that stays inside the current footprint cell always lands (the engines'
// cheap path); a step into an illegal cell does not stop the unit — it
// slides: the position clamps to within half a cell of the CURRENT cell's
// centre on each axis and speed caps at maxvelocity/2, so the unit presses
// against the boundary while steering (and the order layer) resolve it.
// The engines' cell grid is half-cell-rounded ((pos+0x80000)>>20) where the
// sandbox terrain grid floors — an origin-convention gap the occupancy-cell
// block reconciles; the slide clamps to the sandbox cell so the unit stays
// inside ground it legally occupies.
func (w *World) integrateGroundPosition(u *Unit) {
	st := &u.loco
	h := int32(st.Heading.Int())
	nx := fixed.Wrap32(st.Pos.X + fixed.SinScaled(h, st.Speed))
	nz := fixed.Wrap32(st.Pos.Z + fixed.CosScaled(h, st.Speed))
	newPos := fixed.Vec2{X: nx, Z: nz}
	st.Blocked = false
	t := w.terrain
	if t == nil {
		st.Pos = newPos
		return
	}
	ocx, ocz := t.cellAt(st.Pos)
	ncx, ncz := t.cellAt(newPos)
	if ocx == ncx && ocz == ncz {
		st.Pos = newPos
		return
	}
	if w.canTraverse(u.Meta, st.Pos, newPos) {
		st.Pos = newPos
		return
	}
	// Blocked slide.
	st.Blocked = true
	ccx := fixed.FromInt(ocx).Mul(t.CellWU) + t.CellWU.Div(fixed.FromInt(2))
	ccz := fixed.FromInt(ocz).Mul(t.CellWU) + t.CellWU.Div(fixed.FromInt(2))
	st.Pos.X = fixed.Clamp(nx, ccx-slideHalfCell, ccx+slideHalfCell)
	st.Pos.Z = fixed.Clamp(nz, ccz-slideHalfCell, ccz+slideHalfCell)
	half := fixed.Wrap32(u.Meta.MaxVelocity >> 1)
	if st.Speed > half {
		st.Speed = half
	}
}

// waypointConsumeSq is the intermediate-waypoint completion radius: the
// waypoint list consumes a waypoint once the unit is within dist² < 0x1a in
// footprint-cell coordinates (≈5.1 cells ≈ 82 wu).
const waypointConsumeSq = 0x1a

// cellRound maps a 16.16 coordinate onto the engines' footprint-cell axis:
// >>20 with half-cell (+0x80000 = 8 wu) rounding.
func cellRound(v fixed.Fixed) int64 {
	return (int64(v) + 0x80000) >> 20
}

// consumeWaypoints advances the path index past every intermediate waypoint
// already within the consume radius. The final waypoint is never consumed
// here — it completes under the brake law (arrivedFinal).
//
// The line-of-sight gate on each consume is a sandbox stand-in: the engines'
// per-class blocker rasters carry a penalty band (3×3 min-filter demotion
// around obstacles) that keeps routes off walls, so their ~5-cell lookahead
// never cuts a corner through an illegal cell. Until the passability block
// brings that raster, consuming only up to the last waypoint the unit can
// steer at in a straight legal line prevents the lookahead wedging a mover
// into a wall corner; over open ground the gate never bites and the radius
// behaves exactly as the engines'.
func (w *World) consumeWaypoints(u *Unit) {
	for u.pathEligible() && u.pathIdx < len(u.path)-1 {
		wp := u.path[u.pathIdx]
		dcx := cellRound(u.loco.Pos.X) - cellRound(wp.X)
		dcz := cellRound(u.loco.Pos.Z) - cellRound(wp.Z)
		if dcx*dcx+dcz*dcz >= waypointConsumeSq {
			break
		}
		if !w.lineTraversable(u.Meta, u.loco.Pos, u.path[u.pathIdx+1]) {
			break
		}
		u.pathIdx++
	}
}

// lineTraversable walks the straight segment a→b at quarter-cell steps and
// checks every cell transition with the same pairwise rule the mover uses,
// including the diagonal corner rule (both shared orthogonal cells must be
// enterable) so the line cannot thread a cliff corner.
func (w *World) lineTraversable(m *UnitMeta, a, b fixed.Vec2) bool {
	t := w.terrain
	if t == nil {
		return true
	}
	half := t.CellWU.Div(fixed.FromInt(2))
	centre := func(cx, cz int) fixed.Vec2 {
		return fixed.Vec2{X: fixed.FromInt(cx).Mul(t.CellWU) + half, Z: fixed.FromInt(cz).Mul(t.CellWU) + half}
	}
	d := b.Sub(a)
	l := d.Len()
	stepLen := t.CellWU.Div(fixed.FromInt(4))
	n := l.Div(stepLen).Int()
	if n < 1 {
		n = 1
	}
	pcx, pcz := t.cellAt(a)
	for i := 1; i <= n; i++ {
		f := fixed.FromInt(i).Div(fixed.FromInt(n))
		p := fixed.Vec2{X: a.X + d.X.Mul(f), Z: a.Z + d.Z.Mul(f)}
		cx, cz := t.cellAt(p)
		if cx == pcx && cz == pcz {
			continue
		}
		cc := centre(pcx, pcz)
		if cx != pcx && cz != pcz {
			if !w.canTraverse(m, cc, centre(pcx, cz)) || !w.canTraverse(m, cc, centre(cx, pcz)) {
				return false
			}
		}
		if !w.canTraverse(m, cc, centre(cx, cz)) {
			return false
		}
		pcx, pcz = cx, cz
	}
	return true
}

// arrivedFinal decides the final waypoint is complete. The engines' mover has
// no arrival radius — the ground controller's completion condition was not
// located (spec UNKNOWN-1) — so the sandbox completes the order when this
// frame's step reaches the target (dist ≤ speed) or the unit is within 1 wu,
// and lets the no-target brake law bring it to rest, matching the spec'd
// approach-under-brake-law shape.
func arrivedFinal(st *locoState, tgt fixed.Vec2) bool {
	dist := tgt.Sub(st.Pos).Len()
	return dist <= fixed.Max(st.Speed, fixed.One)
}
