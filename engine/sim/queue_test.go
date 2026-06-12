package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// TestQueuedMovesRunInSequence proves a shift-queued waypoint chain executes
// leg by leg: the unit drives to the first point, and only on arrival arms the
// next queued destination.
func TestQueuedMovesRunInSequence(t *testing.T) {
	w := New(Config{Seed: 1})
	id := w.AddUnit("m", testMeta("m"), nil, fixed.Vec2{}, 0, 0)
	first := fixed.Vec2{X: fixed.FromInt(80)}
	second := fixed.Vec2{X: fixed.FromInt(80), Z: fixed.FromInt(80)}
	w.ApplyOrder(order.Move([]uint32{id}, first))
	w.ApplyOrder(order.MoveQueued([]uint32{id}, second))

	u := w.UnitByID(id)
	if len(u.queue) != 1 {
		t.Fatalf("queued move not stored: queue=%d", len(u.queue))
	}
	if u.moveTarget != first {
		t.Fatalf("queued move replaced the active leg")
	}
	sawSecondLeg := false
	for i := 0; i < 1200; i++ {
		w.Step(nil)
		if u.hasMove && u.moveTarget == second {
			sawSecondLeg = true
		}
	}
	if !sawSecondLeg {
		t.Fatalf("second leg never armed; pos=(%v,%v) queue=%d", u.loco.Pos.X.Float(), u.loco.Pos.Z.Float(), len(u.queue))
	}
	if u.hasMove || u.IsMoving || len(u.queue) != 0 {
		t.Fatalf("unit should have finished the chain: hasMove=%v queue=%d", u.hasMove, len(u.queue))
	}
	if u.loco.Pos.DistTo(second) > fixed.FromInt(20) {
		t.Fatalf("unit did not reach the final waypoint: (%v,%v)", u.loco.Pos.X.Float(), u.loco.Pos.Z.Float())
	}
}

// TestQueuedAttackAfterMove proves a queued attack waits for the move leg, and
// a queued move waits for that attack's target to die before arming.
func TestQueuedAttackAfterMove(t *testing.T) {
	w := New(Config{Seed: 2})
	atk := w.AddUnit("atk", testMeta("atk"), nil, fixed.Vec2{}, 0, 0)
	prey := w.AddUnit("prey", testMeta("prey"), nil, fixed.Vec2{X: fixed.FromInt(140)}, 0, 1)
	w.ApplyOrder(order.Stance([]uint32{prey}, order.MoveHold, order.FireHold))
	rally := fixed.Vec2{Z: fixed.FromInt(60)}
	home := fixed.Vec2{X: fixed.FromInt(-60)}
	w.ApplyOrder(order.Move([]uint32{atk}, rally))
	w.ApplyOrder(order.AttackQueued([]uint32{atk}, prey))
	w.ApplyOrder(order.MoveQueued([]uint32{atk}, home))

	u := w.UnitByID(atk)
	if u.hasAttack {
		t.Fatalf("queued attack armed before the move completed")
	}
	for i := 0; i < 2000 && !w.UnitByID(prey).Dead; i++ {
		w.Step(nil)
	}
	if !w.UnitByID(prey).Dead {
		t.Fatalf("queued attack never killed the target; hasAttack=%v queue=%d", u.hasAttack, len(u.queue))
	}
	// Target death completes the attack; the final queued move arms next tick.
	for i := 0; i < 1200 && (u.hasMove || len(u.queue) > 0); i++ {
		w.Step(nil)
	}
	if u.loco.Pos.DistTo(home) > fixed.FromInt(20) {
		t.Fatalf("unit did not return home after the kill: (%v,%v)", u.loco.Pos.X.Float(), u.loco.Pos.Z.Float())
	}
}

// TestUnqueuedOrderClearsQueue proves a plain (non-shift) order wipes any
// queued chain, and Stop does the same.
func TestUnqueuedOrderClearsQueue(t *testing.T) {
	w := New(Config{Seed: 3})
	id := w.AddUnit("m", testMeta("m"), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(100)}))
	w.ApplyOrder(order.MoveQueued([]uint32{id}, fixed.Vec2{X: fixed.FromInt(200)}))
	w.ApplyOrder(order.MoveQueued([]uint32{id}, fixed.Vec2{X: fixed.FromInt(300)}))
	u := w.UnitByID(id)
	if len(u.queue) != 2 {
		t.Fatalf("expected 2 queued, got %d", len(u.queue))
	}
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{Z: fixed.FromInt(50)}))
	if len(u.queue) != 0 {
		t.Fatalf("plain move should clear the queue, got %d", len(u.queue))
	}
	w.ApplyOrder(order.MoveQueued([]uint32{id}, fixed.Vec2{X: fixed.FromInt(200)}))
	w.ApplyOrder(order.Stop([]uint32{id}))
	if len(u.queue) != 0 || u.hasMove {
		t.Fatalf("stop should clear queue + move, got queue=%d hasMove=%v", len(u.queue), u.hasMove)
	}
}

// TestQueuedOrderOnIdleUnitAppliesImmediately proves shift-clicking an idle
// unit acts like a plain order rather than parking the command forever.
func TestQueuedOrderOnIdleUnitAppliesImmediately(t *testing.T) {
	w := New(Config{Seed: 4})
	id := w.AddUnit("m", testMeta("m"), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.MoveQueued([]uint32{id}, fixed.Vec2{X: fixed.FromInt(90)}))
	u := w.UnitByID(id)
	if !u.hasMove || len(u.queue) != 0 {
		t.Fatalf("queued order on idle unit should apply immediately: hasMove=%v queue=%d", u.hasMove, len(u.queue))
	}
}

// TestQueueSurvivesExportRestore proves the shift-queue rides a join snapshot.
func TestQueueSurvivesExportRestore(t *testing.T) {
	w := New(Config{Seed: 5})
	id := w.AddUnit("m", testMeta("m"), nil, fixed.Vec2{}, 0, 0)
	prey := w.AddUnit("prey", testMeta("prey"), nil, fixed.Vec2{X: fixed.FromInt(900)}, 0, 1)
	w.ApplyOrder(order.Stance([]uint32{prey}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(100)}))
	w.ApplyOrder(order.AttackQueued([]uint32{id}, prey))
	w.ApplyOrder(order.MoveQueued([]uint32{id}, fixed.Vec2{X: fixed.FromInt(200)}))
	u := w.UnitByID(id)
	if len(u.queue) != 2 {
		t.Fatalf("setup: queue=%d", len(u.queue))
	}

	spawn := func(name string) (*UnitMeta, Binding) { return testMeta(name), nil }
	w2 := New(Config{Seed: 5, Spawn: spawn})
	w2.Restore(w.Tick(), w.ExportUnits(), nil)
	u2 := w2.UnitByID(id)
	if u2 == nil || len(u2.queue) != 2 {
		t.Fatalf("restore dropped the queue: %v", u2)
	}
	if u2.queue[0].kind != order.KindAttack || u2.queue[1].target.X != fixed.FromInt(200) {
		t.Fatalf("restored queue mangled: %+v", u2.queue)
	}
}
