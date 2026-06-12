package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// TestAttackOutOfRangeClosesDistance pins the chase contract: an attack order
// on a target beyond weapon range walks the unit toward the prey, stops once
// inside range (it must not climb on top of the target), and kills it.
func TestAttackOutOfRangeClosesDistance(t *testing.T) {
	w := New(Config{Seed: 7})
	atk := w.AddUnit("atk", testMeta("atk"), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(600)}, 0, 1)
	w.ApplyOrder(order.Stance([]uint32{def}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	u := w.UnitByID(atk)
	rngF := u.Meta.Weapons[0].Range // 200 in testMeta

	moved := false
	stoppedInRange := false
	for i := 0; i < 4000 && !w.UnitByID(def).Dead; i++ {
		w.Step(nil)
		if u.IsMoving {
			moved = true
		}
		dist := u.loco.Pos.DistTo(w.UnitByID(def).loco.Pos)
		if !u.hasMove && dist <= rngF {
			stoppedInRange = true
			// Once parked, the unit must not creep onto the target.
			if dist < fixed.FromInt(40) {
				t.Fatalf("attacker overran the target: dist=%v", dist.Float())
			}
		}
	}
	if !moved {
		t.Fatalf("attacker never walked toward the out-of-range target")
	}
	if !stoppedInRange {
		t.Fatalf("attacker never stopped inside weapon range")
	}
	if !w.UnitByID(def).Dead {
		t.Fatalf("attacker never killed the target; dist=%v hp=%v",
			u.loco.Pos.DistTo(w.UnitByID(def).loco.Pos).Float(), w.UnitByID(def).Health.Float())
	}
}

// TestAttackRechasesFleeingTarget pins pursuit of a moving prey: when the
// target walks back out of range mid-engagement, the attacker resumes the
// chase at the prey's CURRENT position rather than its stale one.
func TestAttackRechasesFleeingTarget(t *testing.T) {
	w := New(Config{Seed: 8})
	// A pea-shooter attacker: the prey must survive long enough to flee out
	// of range, or the engagement ends before any chase can happen.
	weak := testMeta("atk")
	weak.Weapons[0].Damage = fixed.FromInt(1)
	atk := w.AddUnit("atk", weak, nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(150)}, 0, 1)
	w.ApplyOrder(order.Stance([]uint32{def}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	u := w.UnitByID(atk)
	d := w.UnitByID(def)
	// Let the engagement settle (in range from the start: 150 < 200).
	for i := 0; i < 40; i++ {
		w.Step(nil)
	}
	if u.hasMove {
		t.Fatalf("attacker should hold position while the target is in range")
	}
	// Prey flees far beyond range; the attacker must take up the chase.
	w.ApplyOrder(order.Move([]uint32{def}, fixed.Vec2{X: fixed.FromInt(900)}))
	rechased := false
	for i := 0; i < 3000 && !d.Dead; i++ {
		w.Step(nil)
		// The chase re-targets the prey's live position each tick; the prey
		// then takes its own step, so compare within one tick of prey travel.
		if u.hasMove && u.moveTarget.DistTo(d.loco.Pos) < fixed.FromInt(5) {
			rechased = true
		}
	}
	if !rechased {
		t.Fatalf("attacker never resumed the chase after the target fled")
	}
	if !d.Dead {
		t.Fatalf("attacker never caught the fleeing target; atk=(%v,%v) def=(%v,%v)",
			u.loco.Pos.X.Float(), u.loco.Pos.Z.Float(), d.loco.Pos.X.Float(), d.loco.Pos.Z.Float())
	}
}
