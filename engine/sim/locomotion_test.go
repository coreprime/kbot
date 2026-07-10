package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
)

// TestAimPullIn pins the waypoint corner-cutting rule (locomotion spec §1.2):
// within 80 wu the aim IS the waypoint; beyond it the aim slides from the
// waypoint toward the next one by pull = min(dist-80wu, |tgt-next|), and a
// next waypoint closer than ~1 wu (0xffff raw) disables the slide.
func TestAimPullIn(t *testing.T) {
	pos := fixed.Vec2{}
	wu := func(v int) fixed.Fixed { return fixed.FromInt(v) }

	// dist exactly 80 wu: the spec's condition is strictly d > 0x500000.
	tgt := fixed.Vec2{Z: wu(80)}
	next := fixed.Vec2{Z: wu(96)}
	if got := aimPullIn(pos, tgt, next, tgt.Sub(pos).Len()); got != tgt {
		t.Fatalf("at exactly 80 wu the aim must be the waypoint, got %+v", got)
	}

	// 100 wu out with the next waypoint one cell beyond: pull = min(20, 16)
	// = 16 wu, sliding the aim exactly onto the next waypoint.
	tgt = fixed.Vec2{Z: wu(100)}
	next = fixed.Vec2{Z: wu(116)}
	if got := aimPullIn(pos, tgt, next, tgt.Sub(pos).Len()); got != next {
		t.Fatalf("pull-in should reach the next waypoint (116 wu), got %+v", got)
	}

	// 200 wu out, next 60 wu past the waypoint: pull = min(120, 60) = 60 —
	// capped at the full leg, never beyond the next waypoint.
	tgt = fixed.Vec2{Z: wu(200)}
	next = fixed.Vec2{Z: wu(260)}
	if got := aimPullIn(pos, tgt, next, tgt.Sub(pos).Len()); got != next {
		t.Fatalf("pull is capped at |tgt-next|, got %+v", got)
	}

	// Degenerate next (≤ 0xffff away from the waypoint): no slide.
	tgt = fixed.Vec2{Z: wu(100)}
	next = fixed.Vec2{Z: wu(100) + fixed.Fixed(0xffff)}
	if got := aimPullIn(pos, tgt, next, tgt.Sub(pos).Len()); got != tgt {
		t.Fatalf("a sub-wu next leg must not pull, got %+v", got)
	}
}

// TestBlockedSlide pins the blocked-step law (§1.3): a step into an illegal
// cell does not stop or revert the unit — the position clamps to within half
// a cell (0x7ffff) of the current cell's centre per axis, the blocked bit
// raises (walk tier 0), and speed caps at maxvelocity/2.
func TestBlockedSlide(t *testing.T) {
	w := New(Config{Seed: 1})
	// Flat field with an impassable wall at cell x=10.
	w.SetTerrain(testTerrain(20, 20, 0, func(cx, _ int) uint8 {
		if cx >= 10 {
			return 200
		}
		return 0
	}))
	m := testMeta("tank")
	m.MaxSlope = 15
	id := w.AddUnit("tank", m, nil, fixed.Vec2{X: fixed.FromInt(9*16 + 8), Z: fixed.FromInt(5*16 + 8)}, 0, 0)
	u := w.UnitByID(id)
	// Aim straight into the wall at speed: heading 16384 = +X.
	u.loco.setHeading(fixed.FromInt(16384))
	u.loco.Speed = m.MaxVelocity // 1.2 wu/frame

	for i := 0; i < 12; i++ {
		w.integrateGroundPosition(u)
	}
	if !u.loco.Blocked {
		t.Fatal("pressing an illegal cell must raise the blocked bit")
	}
	// Cell 9 centre is x = 9*16+8 = 152 wu; the clamp box is ±0x7ffff.
	centre := fixed.FromInt(9*16 + 8)
	if u.loco.Pos.X < centre-slideHalfCell || u.loco.Pos.X > centre+slideHalfCell {
		t.Fatalf("slide must pin x within half a cell of the current centre, got %v", u.loco.Pos.X.Float())
	}
	if half := fixed.Fixed(int64(m.MaxVelocity) >> 1); u.loco.Speed > half {
		t.Fatalf("blocked speed cap is maxvelocity/2 = %v, got %v", half, u.loco.Speed)
	}
	if u.walkTier() != 0 {
		t.Fatalf("a blocked slide forces walk tier 0, got %d", u.walkTier())
	}
}

// TestCommandedSpeedClamp pins the movement-math side of TA:K's squad speed
// matching (§1.4-2): a commanded speed clamps the candidate speed below the
// unit's own limits. No squad layer exists to set it yet — the order-layer
// block will — but the velocity law must already honour it.
func TestCommandedSpeedClamp(t *testing.T) {
	w := New(Config{Seed: 1})
	m := testMeta("walker")
	id := w.AddUnit("walker", m, nil, fixed.Vec2{}, 0, 0)
	u := w.UnitByID(id)
	u.commandedSpeed = fixed.Fixed(30000) // below the 1.2 wu/frame cap

	for i := 0; i < 10; i++ {
		w.updateGroundVelocity(u, m.Accel)
	}
	if u.loco.Speed != u.commandedSpeed {
		t.Fatalf("speed must clamp to the commanded speed 30000, got %d", int64(u.loco.Speed))
	}
}

// TestWalkTiers pins the §7 walk-animation tier rule: tier 0 at full rest or
// blocked, tier 1 while moving (turning in place included), tiers 2/3 above
// the strict MoveRate1/2 thresholds — which default to 2×maxvelocity, so a
// stock unit never leaves tier 1.
func TestWalkTiers(t *testing.T) {
	w := New(Config{Seed: 1})
	m := testMeta("walker")
	id := w.AddUnit("walker", m, nil, fixed.Vec2{}, 0, 0)
	u := w.UnitByID(id)

	if got := u.walkTier(); got != 0 {
		t.Fatalf("at rest tier = 0, got %d", got)
	}
	u.loco.Turn = 475 // pivot in place
	if got := u.walkTier(); got != 1 {
		t.Fatalf("turning in place counts as moving (tier 1), got %d", got)
	}
	u.loco.Turn = 0
	u.loco.Speed = m.MaxVelocity // at cap: below the default 2×maxvel thresholds
	if got := u.walkTier(); got != 1 {
		t.Fatalf("stock thresholds keep tier 1 at cap, got %d", got)
	}
	// FBI-declared thresholds: strictly-above comparisons.
	m.MoveRate1 = fixed.Fixed(30000)
	m.MoveRate2 = fixed.Fixed(60000)
	u.loco.Speed = fixed.Fixed(30000)
	if got := u.walkTier(); got != 1 {
		t.Fatalf("speed == moverate1 stays tier 1 (strict >), got %d", got)
	}
	u.loco.Speed = fixed.Fixed(30001)
	if got := u.walkTier(); got != 2 {
		t.Fatalf("speed just above moverate1 is tier 2, got %d", got)
	}
	u.loco.Speed = fixed.Fixed(60001)
	if got := u.walkTier(); got != 3 {
		t.Fatalf("speed above moverate2 is tier 3, got %d", got)
	}
	u.loco.Blocked = true
	if got := u.walkTier(); got != 0 {
		t.Fatalf("blocked forces tier 0 at any speed, got %d", got)
	}
}

// TestTAKSlopeFactors pins TA:K's truncated 16.16 slope factors against the
// defining computation trunc(pct << 16 × 0.01): the engine converts each
// table percent through one float ×0.01 with truncation toward zero.
func TestTAKSlopeFactors(t *testing.T) {
	for i, pct := range SlopeSpeedPct {
		want := int32(int64(pct) << 16 / 100)
		if takSlopeFactorFx[i] != want {
			t.Fatalf("band %d: factor %d, want trunc(%d<<16/100) = %d", i-5, takSlopeFactorFx[i], pct, want)
		}
	}
}
