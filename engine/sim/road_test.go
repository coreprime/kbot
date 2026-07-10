package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// takRoadBinding is a minimal TA:K script binding: the MoveRate export is one
// of the TA:K-only discriminators motionConvention keys on, so a unit carrying
// it runs the TA:K locomotion dialect (and thus the road/water stat scale).
func takRoadBinding() *recordingBinding {
	return &recordingBinding{scripts: map[string]bool{"MoveRate": true}}
}

// cellZOf maps a waypoint's Z to its terrain row.
func cellZOf(p fixed.Vec2) int { return p.Z.Div(fixed.FromInt(16)).Int() }

// TestTAKUnitFasterOnRoad pins the road speed boost: two identical TA:K units
// run the same straight lane, one over a road strip and one cross-country. The
// road unit reads its roadmultiplier as the kinematic-stat scale, cruises at a
// higher cap, and outruns the plain unit.
func TestTAKUnitFasterOnRoad(t *testing.T) {
	w := New(Config{Seed: 101})
	const W, H = 90, 30
	terr := testTerrain(W, H, 0, func(_, _ int) uint8 { return 10 })
	road := make([]uint8, W*H)
	for cz := 4; cz <= 6; cz++ { // road band under the road unit's lane
		for cx := 0; cx < W; cx++ {
			road[cz*W+cx] = 1
		}
	}
	terr.Road = road
	w.SetTerrain(terr)

	mk := func(zc int) uint32 {
		m := testMeta("tak")
		m.MaxSlope = 40
		id := w.AddUnit("tak", m, takRoadBinding(),
			fixed.Vec2{X: fixed.FromInt(40), Z: fixed.FromInt(zc*16 + 8)}, 0, 0)
		w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
		w.ApplyOrder(order.Move([]uint32{id},
			fixed.Vec2{X: fixed.FromInt((W - 4) * 16), Z: fixed.FromInt(zc*16 + 8)}))
		return id
	}
	roadID := mk(5)
	plainID := mk(20)
	for i := 0; i < 200; i++ {
		w.Step(nil)
	}
	ru := w.UnitByID(roadID)
	pu := w.UnitByID(plainID)

	// Both still cruising (goal is far), and the road unit is faster and ahead.
	if ru.loco.Speed <= pu.loco.Speed {
		t.Fatalf("road unit not faster: road speed=%v plain speed=%v",
			ru.loco.Speed.Float(), pu.loco.Speed.Float())
	}
	// The boost is the 1.2 roadmultiplier, so the cruise speed should clear the
	// plain cap by a clear margin (well over 10%).
	if ru.loco.Speed.Float() < pu.loco.Speed.Float()*1.1 {
		t.Fatalf("road speed boost too small: road=%v plain=%v",
			ru.loco.Speed.Float(), pu.loco.Speed.Float())
	}
	if ru.loco.Pos.X <= pu.loco.Pos.X {
		t.Fatalf("road unit not ahead: road x=%v plain x=%v",
			ru.loco.Pos.X.Float(), pu.loco.Pos.X.Float())
	}
}

// TestPathPrefersRoad pins the A* road-cost discount: a road running a few rows
// off the straight line makes a slightly longer road route cheaper than the
// direct cross-country one, so the router dips onto the road.
func TestPathPrefersRoad(t *testing.T) {
	w := New(Config{Seed: 102})
	const W, H = 44, 44
	w.SetTerrain(testTerrain(W, H, 0, func(_, _ int) uint8 { return 10 }))
	m := testMeta("m")
	m.MaxSlope = 40
	from := fixed.Vec2{X: fixed.FromInt(2*16 + 8), Z: fixed.FromInt(20*16 + 8)}
	to := fixed.Vec2{X: fixed.FromInt(40*16 + 8), Z: fixed.FromInt(20*16 + 8)}

	// Without any road raster the route hugs the straight row-20 line.
	plain := w.findPath(m, from, to)
	if len(plain) == 0 {
		t.Fatal("cross-country path not found")
	}
	dev := 0
	for _, wp := range plain {
		d := cellZOf(wp) - 20
		if d < 0 {
			d = -d
		}
		if d > dev {
			dev = d
		}
	}
	if dev > 1 {
		t.Fatalf("cross-country path wandered %d rows off the straight line", dev)
	}

	// Lay a road four rows below the straight line and re-path.
	for cx := 0; cx < W; cx++ {
		if !w.SetRoadCell(cx, 24, true) {
			t.Fatalf("SetRoadCell(%d,24) failed", cx)
		}
	}
	roadPath := w.findPath(m, from, to)
	onRoad := 0
	for _, wp := range roadPath {
		if cellZOf(wp) == 24 {
			onRoad++
		}
	}
	if onRoad == 0 {
		t.Fatalf("A* did not route onto the road (0 road-row waypoints of %d)", len(roadPath))
	}
}

// TestTAIgnoresRoadSpeed pins that roads are a TA:K-only effect: a TA unit (no
// TA:K script binding) reads no road multiplier, so its cruise speed on an
// all-road map matches its speed cross-country and never picks up the boost.
func TestTAIgnoresRoadSpeed(t *testing.T) {
	run := func(onRoad bool) fixed.Fixed {
		w := New(Config{Seed: 103})
		const W, H = 90, 20
		terr := testTerrain(W, H, 0, func(_, _ int) uint8 { return 10 })
		if onRoad {
			r := make([]uint8, W*H)
			for i := range r {
				r[i] = 1
			}
			terr.Road = r
		}
		w.SetTerrain(terr)
		m := testMeta("ta")
		m.MaxSlope = 40
		id := w.AddUnit("ta", m, nil,
			fixed.Vec2{X: fixed.FromInt(40), Z: fixed.FromInt(10*16 + 8)}, 0, 0)
		w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
		w.ApplyOrder(order.Move([]uint32{id},
			fixed.Vec2{X: fixed.FromInt((W - 4) * 16), Z: fixed.FromInt(10*16 + 8)}))
		for i := 0; i < 150; i++ {
			w.Step(nil)
		}
		return w.UnitByID(id).loco.Speed
	}
	off := run(false)
	on := run(true)
	if off != on {
		t.Fatalf("TA unit speed changed by road: off=%v on=%v", off.Float(), on.Float())
	}
	// And the cruise sits at the plain maxvelocity (1.2), never the 1.44 a road
	// boost would produce.
	if on.Float() >= 1.3 {
		t.Fatalf("TA unit picked up a road boost: cruise speed=%v", on.Float())
	}
}
