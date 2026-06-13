package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// TestPathAroundWall pins global pathfinding over terrain: a wall of
// impassable height spanning most of the field, with a gap, forces the unit
// to detour to the gap and back — a route local avoidance (which only ever
// sees the next obstacle) can never find.
func TestPathAroundWall(t *testing.T) {
	w := New(Config{Seed: 71})
	const W, H = 40, 40
	// A vertical wall at x-cell 20, height 200 (impassable), open only for
	// z-cells 6..11 (a gap toward the top). Start + goal sit at mid-height,
	// so the unit must detour UP to the gap and back down.
	w.SetTerrain(testTerrain(W, H, 0, func(cx, cz int) uint8 {
		if cx == 20 && (cz < 6 || cz > 11) {
			return 200
		}
		return 0
	}))
	m := testMeta("walker")
	m.MaxSlope = 30
	id := w.AddUnit("w", m, nil, fixed.Vec2{X: fixed.FromInt(120), Z: fixed.FromInt(320)}, 0, 0)
	w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	goal := fixed.Vec2{X: fixed.FromInt(560), Z: fixed.FromInt(320)}
	w.ApplyOrder(order.Move([]uint32{id}, goal))
	u := w.UnitByID(id)
	wentHigh := false
	for i := 0; i < 6000 && u.hasMove; i++ {
		w.Step(nil)
		if u.loco.Pos.Z < fixed.FromInt(210) { // detoured up toward the gap
			wentHigh = true
		}
	}
	if u.loco.Pos.DistTo(goal) > fixed.FromInt(40) {
		t.Fatalf("walker never reached the far side: (%v,%v)", u.loco.Pos.X.Float(), u.loco.Pos.Z.Float())
	}
	if !wentHigh {
		t.Fatalf("walker did not route through the gap (never detoured up)")
	}
}

// TestPathAroundBuildingLine pins routing around STATIC structures: a wall of
// factories spanning the field with a gap forces a detour the same way.
func TestPathAroundBuildingLine(t *testing.T) {
	w := New(Config{Seed: 72})
	w.SetTerrain(testTerrain(40, 40, 0, func(_, _ int) uint8 { return 10 }))
	// A column of 6x6 factories at x≈320, stacked in z, leaving a gap at the
	// top so the mover must route around.
	lab := footMeta("lab", 6, false)
	lab.Yard = ParseYardMap("oooooo oooooo oooooo oooooo oooooo oooooo", 6, 6)
	for z := 200; z <= 440; z += 96 {
		w.AddUnit("lab", lab, nil, fixed.Vec2{X: fixed.FromInt(320), Z: fixed.FromInt(z)}, 0, 0)
	}
	m := footMeta("m", 2, true)
	m.MaxSlope = 30
	id := w.AddUnit("m", m, nil, fixed.Vec2{X: fixed.FromInt(120), Z: fixed.FromInt(320)}, 0, 0)
	w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	goal := fixed.Vec2{X: fixed.FromInt(520), Z: fixed.FromInt(320)}
	w.ApplyOrder(order.Move([]uint32{id}, goal))
	u := w.UnitByID(id)
	for i := 0; i < 5000 && u.hasMove; i++ {
		w.Step(nil)
	}
	if u.loco.Pos.DistTo(goal) > fixed.FromInt(48) {
		t.Fatalf("mover never cleared the factory line: (%v,%v)", u.loco.Pos.X.Float(), u.loco.Pos.Z.Float())
	}
}
