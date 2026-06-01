package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// missileMeta is a unit whose single weapon flies a guided model projectile,
// exercising the projectile subsystem rather than the hitscan path.
func missileMeta(name string) *UnitMeta {
	m := &UnitMeta{
		Name:        name,
		CanMove:     true,
		MaxVelocity: fixed.FromFloat(1.2),
		TurnRate:    fixed.FromInt(600),
		Accel:       fixed.FromFloat(0.1),
		BrakeRate:   fixed.FromFloat(0.2),
	}
	m.Weapons[0] = WeaponMeta{
		Name:        "missile",
		Range:       fixed.FromInt(400),
		ReloadMs:    750,
		Burst:       1,
		Damage:      fixed.FromInt(40),
		Present:     true,
		Model:       "missile.3do",
		VelocityWU:  fixed.FromInt(300),
		TurnRateAng: halfTurn,
		Tracks:      true,
		SelfProp:    true,
	}
	return m
}

// TestProjectileReachesAndDamages drives a guided missile from one unit at a
// stationary target and confirms the model projectile flies, detonates, and
// applies its damage on arrival (not at fire time).
func TestProjectileReachesAndDamages(t *testing.T) {
	w := New(Config{Seed: 11})
	atk := w.AddUnit("atk", missileMeta("atk"), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", missileMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(250)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	startHP := w.UnitByID(def).Health
	sawProjectile := false
	damaged := false
	for i := 0; i < 200; i++ {
		w.Step(nil)
		if len(w.projectiles) > 0 {
			sawProjectile = true
		}
		if w.UnitByID(def).Health < startHP {
			damaged = true
			break
		}
	}
	if !sawProjectile {
		t.Fatal("no model projectile ever spawned")
	}
	if !damaged {
		t.Fatalf("projectile never damaged the target; hp still %v", w.UnitByID(def).Health.Float())
	}
}

// TestProjectileDeterminism guards that the projectile subsystem keeps the
// world bit-identical across identical runs — projectiles are render state but
// the damage they apply mutates hashed unit state.
func TestProjectileDeterminism(t *testing.T) {
	run := func() uint64 {
		w := New(Config{Seed: 23})
		atk := w.AddUnit("atk", missileMeta("atk"), nil, fixed.Vec2{}, 0, 0)
		w.AddUnit("def", missileMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(250)}, 0, 1)
		def := w.AddUnit("def2", missileMeta("def2"), nil, fixed.Vec2{Z: fixed.FromInt(220)}, 0, 1)
		w.ApplyOrder(order.Attack([]uint32{atk}, def))
		for i := 0; i < 300; i++ {
			w.Step(nil)
		}
		return w.Hash()
	}
	if h1, h2 := run(), run(); h1 != h2 {
		t.Fatalf("projectile sim non-deterministic: %x != %x", h1, h2)
	}
}

// TestProjectileSnapshotExposesFlight confirms in-flight projectiles surface in
// the render snapshot so the renderer can draw the flying mesh.
func TestProjectileSnapshotExposesFlight(t *testing.T) {
	w := New(Config{Seed: 7})
	atk := w.AddUnit("atk", missileMeta("atk"), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", missileMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(300)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	sawInFlight := false
	for i := 0; i < 200; i++ {
		w.Step(nil)
		snap := w.Snapshot()
		if len(snap.Projos) > 0 {
			if snap.Projos[0].Kind != "missile.3do" {
				t.Fatalf("projectile kind = %q, want missile.3do", snap.Projos[0].Kind)
			}
			sawInFlight = true
			break
		}
	}
	if !sawInFlight {
		t.Fatal("snapshot never exposed an in-flight projectile")
	}
}
