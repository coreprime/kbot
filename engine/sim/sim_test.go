package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

func testMeta(name string) *UnitMeta {
	m := &UnitMeta{
		Name:        name,
		CanMove:     true,
		MaxVelocity: fixed.FromFloat(1.2),
		TurnRate:    fixed.FromInt(600),
		Accel:       fixed.FromFloat(0.1),
		BrakeRate:   fixed.FromFloat(0.2),
	}
	m.Weapons[0] = WeaponMeta{Name: "test", Range: fixed.FromInt(200), ReloadMs: 250, Burst: 1, Damage: fixed.FromInt(25), Present: true}
	return m
}

func runScenario(seed uint32) *World {
	w := New(Config{Seed: seed})
	a := w.AddUnit("mover", testMeta("mover"), nil, fixed.Vec2{}, 0, 0)
	b := w.AddUnit("target", testMeta("target"), nil, fixed.Vec2{X: fixed.FromInt(300)}, 0, 1)
	w.ApplyOrder(order.Move([]uint32{a}, fixed.Vec2{X: fixed.FromInt(150), Z: fixed.FromInt(150)}))
	w.ApplyOrder(order.Attack([]uint32{b}, a))
	for i := 0; i < 400; i++ {
		w.Step(nil)
	}
	return w
}

// TestDeterminism is the property the whole engine rests on: identical seed +
// identical orders + fixed ticks produce bit-identical state.
func TestDeterminism(t *testing.T) {
	h1 := runScenario(99).Hash()
	h2 := runScenario(99).Hash()
	if h1 != h2 {
		t.Fatalf("non-deterministic: %x != %x", h1, h2)
	}
}

func TestMovementProgresses(t *testing.T) {
	w := New(Config{Seed: 1})
	id := w.AddUnit("m", testMeta("m"), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(100)}))
	w.Step(nil)
	start := w.UnitByID(id).loco.Pos
	for i := 0; i < 200; i++ {
		w.Step(nil)
	}
	end := w.UnitByID(id).loco.Pos
	if start.DistTo(end) < fixed.FromInt(50) {
		t.Errorf("unit did not move appreciably: %v -> %v", start.X.Float(), end.X.Float())
	}
	// It should arrive near the target and stop moving.
	if w.UnitByID(id).IsMoving {
		t.Errorf("unit should have arrived and stopped, still moving")
	}
}

func TestCombatKills(t *testing.T) {
	w := New(Config{Seed: 5})
	atk := w.AddUnit("atk", testMeta("atk"), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(120)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))
	killed := false
	for i := 0; i < 500 && !killed; i++ {
		w.Step(nil)
		if w.UnitByID(def).Dead {
			killed = true
		}
	}
	if !killed {
		t.Errorf("attacker never killed defender; def hp=%v", w.UnitByID(def).Health.Float())
	}
}

// TestSnapshotCarriesSpeed guards the render-snapshot speed enrichment: a unit
// mid-move reports a positive speed the renderer can drive gait/effects from,
// and a stationary unit reports zero.
func TestSnapshotCarriesSpeed(t *testing.T) {
	w := New(Config{Seed: 3})
	id := w.AddUnit("m", testMeta("m"), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(400)}))
	var sawMoving bool
	for i := 0; i < 60; i++ {
		w.Step(nil)
		snap := w.Snapshot()
		if snap.Units[0].Speed > 0 {
			sawMoving = true
			break
		}
	}
	if !sawMoving {
		t.Fatal("snapshot never reported a positive speed while moving")
	}

	stopped := New(Config{Seed: 3})
	stopped.AddUnit("s", testMeta("s"), nil, fixed.Vec2{}, 0, 0)
	stopped.Step(nil)
	if got := stopped.Snapshot().Units[0].Speed; got != 0 {
		t.Fatalf("idle unit speed = %v, want 0", got.Float())
	}
}
