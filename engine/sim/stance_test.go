package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// addStanced spawns an armed mobile test unit and pins its standing orders
// through the supported path (a Stance order — FBI zero values resolve to
// the game defaults at spawn, so explicit Hold must be ordered).
func addStanced(w *World, name string, at fixed.Vec2, side, moveMode, fireMode int) uint32 {
	id := w.AddUnit(name, testMeta(name), nil, at, 0, side)
	w.ApplyOrder(order.Stance([]uint32{id}, moveMode, fireMode))
	return id
}

// TestFireAtWillAutoEngages pins autonomous acquisition: an idle
// fire-at-will unit engages an enemy that strays into reach and kills it
// without any player order.
func TestFireAtWillAutoEngages(t *testing.T) {
	w := New(Config{Seed: 51})
	atk := addStanced(w, "atk", fixed.Vec2{}, 0, int(MoveManeuver), int(FireAtWill))
	prey := addStanced(w, "prey", fixed.Vec2{X: fixed.FromInt(150)}, 1, int(MoveHold), int(FireHold))
	for i := 0; i < 1500 && !w.UnitByID(prey).Dead; i++ {
		w.Step(nil)
	}
	if !w.UnitByID(prey).Dead {
		t.Fatalf("fire-at-will unit never engaged: hasAttack=%v", w.UnitByID(atk).hasAttack)
	}
}

// TestHoldFireNeverEngages pins the passive stance: a hold-fire unit ignores
// an enemy parked inside its weapon range.
func TestHoldFireNeverEngages(t *testing.T) {
	w := New(Config{Seed: 52})
	idle := addStanced(w, "idle", fixed.Vec2{}, 0, int(MoveManeuver), int(FireHold))
	prey := addStanced(w, "prey", fixed.Vec2{X: fixed.FromInt(100)}, 1, int(MoveHold), int(FireHold))
	for i := 0; i < 400; i++ {
		w.Step(nil)
	}
	if w.UnitByID(idle).hasAttack || w.UnitByID(prey).Health < fixed.FromInt(100) {
		t.Fatalf("hold-fire unit engaged: hasAttack=%v preyHP=%v",
			w.UnitByID(idle).hasAttack, w.UnitByID(prey).Health.Float())
	}
}

// TestReturnFireEngagesWhenDamaged pins the reactive stance: a return-fire
// unit sits passive until hit, then fights back until the aggressor is dead.
func TestReturnFireEngagesWhenDamaged(t *testing.T) {
	w := New(Config{Seed: 53})
	def := addStanced(w, "def", fixed.Vec2{}, 0, int(MoveManeuver), int(FireReturn))
	agg := addStanced(w, "agg", fixed.Vec2{X: fixed.FromInt(120)}, 1, int(MoveHold), int(FireHold))
	for i := 0; i < 200; i++ {
		w.Step(nil)
	}
	if w.UnitByID(def).hasAttack {
		t.Fatalf("return-fire unit engaged without provocation")
	}
	w.ApplyDamage(agg, def, fixed.FromInt(10))
	for i := 0; i < 1500 && !w.UnitByID(agg).Dead; i++ {
		w.Step(nil)
	}
	if !w.UnitByID(agg).Dead {
		t.Fatalf("provoked return-fire unit never finished the aggressor")
	}
}

// TestHoldPositionNeverChases pins the static move mode: an attack on prey
// out of range fires nothing and the unit never leaves its spot.
func TestHoldPositionNeverChases(t *testing.T) {
	w := New(Config{Seed: 54})
	atk := addStanced(w, "atk", fixed.Vec2{}, 0, int(MoveHold), int(FireAtWill))
	addStanced(w, "prey", fixed.Vec2{X: fixed.FromInt(500)}, 1, int(MoveHold), int(FireHold))
	start := w.UnitByID(atk).loco.Pos
	for i := 0; i < 600; i++ {
		w.Step(nil)
	}
	if d := w.UnitByID(atk).loco.Pos.DistTo(start); d > fixed.FromInt(2) {
		t.Fatalf("hold-position unit moved %vwu", d.Float())
	}
}

// TestManeuverReturnsHomeAfterCombat pins the leashed mode: the unit chases
// an in-reach enemy, kills it, and walks back to its post.
func TestManeuverReturnsHomeAfterCombat(t *testing.T) {
	w := New(Config{Seed: 55})
	atk := addStanced(w, "atk", fixed.Vec2{}, 0, int(MoveManeuver), int(FireAtWill))
	prey := addStanced(w, "prey", fixed.Vec2{X: fixed.FromInt(300)}, 1, int(MoveHold), int(FireHold))
	u := w.UnitByID(atk)
	for i := 0; i < 2500 && !w.UnitByID(prey).Dead; i++ {
		w.Step(nil)
	}
	if !w.UnitByID(prey).Dead {
		t.Fatalf("maneuver unit never killed in-reach prey (dist 300, acq range+leash)")
	}
	// Give stepStance a few ticks to issue the return move, then wait for it
	// to play out.
	for i := 0; i < 20; i++ {
		w.Step(nil)
	}
	for i := 0; i < 2500 && (u.hasMove || u.IsMoving); i++ {
		w.Step(nil)
	}
	if d := u.loco.Pos.DistTo(fixed.Vec2{}); d > fixed.FromInt(20) {
		t.Fatalf("maneuver unit never returned home: %vwu out", d.Float())
	}
}

// TestRoamWandersWhileIdle pins Roam's idle behaviour: with no enemies, the
// unit strolls away from its post on its own.
func TestRoamWandersWhileIdle(t *testing.T) {
	w := New(Config{Seed: 56})
	id := addStanced(w, "u", fixed.Vec2{}, 0, int(MoveRoam), int(FireAtWill))
	u := w.UnitByID(id)
	moved := false
	for i := 0; i < 40*40 && !moved; i++ {
		w.Step(nil)
		if u.IsMoving {
			moved = true
		}
	}
	if !moved {
		t.Fatalf("roam unit never wandered in 40s")
	}
}

// TestPatrolLoops pins the patrol contract: two patrol points cycle — the
// unit revisits the first point after completing the second.
func TestPatrolLoops(t *testing.T) {
	w := New(Config{Seed: 57})
	id := addStanced(w, "u", fixed.Vec2{}, 0, int(MoveManeuver), int(FireHold))
	a := fixed.Vec2{X: fixed.FromInt(120)}
	b := fixed.Vec2{X: fixed.FromInt(120), Z: fixed.FromInt(120)}
	w.ApplyOrder(order.Patrol([]uint32{id}, a))
	w.ApplyOrder(order.Patrol([]uint32{id}, b))
	u := w.UnitByID(id)
	visits := 0
	wasNear := false
	for i := 0; i < 40*120 && visits < 3; i++ {
		w.Step(nil)
		near := u.loco.Pos.DistTo(a) < fixed.FromInt(10)
		if near && !wasNear {
			visits++
		}
		wasNear = near
	}
	if visits < 3 {
		t.Fatalf("patrol never looped: revisited point A only %d times", visits)
	}
	if !u.curIsPatrol && len(u.queue) == 0 {
		t.Fatalf("patrol queue drained")
	}
}

// TestPatrolEngagesAndResumes pins patrol+fire-at-will interplay: prey near
// the route is engaged, and the patrol resumes after the kill.
func TestPatrolEngagesAndResumes(t *testing.T) {
	w := New(Config{Seed: 58})
	id := addStanced(w, "u", fixed.Vec2{}, 0, int(MoveManeuver), int(FireAtWill))
	prey := addStanced(w, "prey",
		fixed.Vec2{X: fixed.FromInt(60), Z: fixed.FromInt(60)}, 1, int(MoveHold), int(FireHold))
	a := fixed.Vec2{X: fixed.FromInt(150)}
	b := fixed.Vec2{Z: fixed.FromInt(150)}
	w.ApplyOrder(order.Patrol([]uint32{id}, a))
	w.ApplyOrder(order.Patrol([]uint32{id}, b))
	for i := 0; i < 4000 && !w.UnitByID(prey).Dead; i++ {
		w.Step(nil)
	}
	if !w.UnitByID(prey).Dead {
		t.Fatalf("patroller never engaged prey beside its route")
	}
	u := w.UnitByID(id)
	resumed := false
	for i := 0; i < 4000 && !resumed; i++ {
		w.Step(nil)
		if u.curIsPatrol {
			resumed = true
		}
	}
	if !resumed {
		t.Fatalf("patrol never resumed after combat: queue=%d hasMove=%v", len(u.queue), u.hasMove)
	}
}
