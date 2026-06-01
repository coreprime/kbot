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

// TestVLaunchAscendsThenHits models ARMMH's vertical-launch rocket: it must
// climb a real ascent before pitching over, and its wide homing turn must not
// leave it orbiting the target forever — it should detonate within its blast
// radius. Guards the turn-radius units (no 65536/2π factor collapses the ascent
// to one tick) and the steered-shot proximity capture.
func TestVLaunchAscendsThenHits(t *testing.T) {
	w := New(Config{Seed: 5})
	wm := WeaponMeta{
		Name:           "rocket",
		Range:          fixed.FromInt(670),
		Model:          "armmhmsl",
		VelocityWU:     fixed.FromInt(400),
		AccelerationWU: fixed.FromInt(40),
		TurnRateAng:    24384,
		AreaOfEffectWU: fixed.FromInt(80),
		Damage:         fixed.FromInt(300),
		VLaunch:        true,
		Present:        true,
	}
	anchor := fixed.Vec3{}
	target := fixed.Vec3{X: fixed.FromInt(300)}
	p := w.makeProjectile(1, 2, 0, wm, anchor, target, -1)

	maxY := fixed.Zero
	for i := 0; i < 400 && !p.dead; i++ {
		p.stepProjectile(fixed.Zero)
		if p.pos.Y > maxY {
			maxY = p.pos.Y
		}
	}
	if maxY < fixed.FromInt(100) {
		t.Fatalf("vlaunch missile never ascended (peak Y = %v); ascent phase collapsed", maxY.Float())
	}
	if !p.dead || !p.hit {
		t.Fatalf("vlaunch missile did not detonate on target (dead=%v hit=%v) — likely orbiting", p.dead, p.hit)
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

// cannonMeta is a unit whose single weapon is a model-less ballistic shell — no
// 3DO mesh, no beam flag. Before model-less shots were tracked these resolved
// instantly at fire time; now they fly the projectile subsystem like a missile.
func cannonMeta(name string) *UnitMeta {
	m := &UnitMeta{
		Name:        name,
		CanMove:     true,
		MaxVelocity: fixed.FromFloat(1.2),
		TurnRate:    fixed.FromInt(600),
		Accel:       fixed.FromFloat(0.1),
		BrakeRate:   fixed.FromFloat(0.2),
	}
	m.Weapons[0] = WeaponMeta{
		Name:           "cannon",
		Range:          fixed.FromInt(400),
		ReloadMs:       900,
		Burst:          1,
		Damage:         fixed.FromInt(50),
		Present:        true,
		VelocityWU:     fixed.FromInt(260),
		AreaOfEffectWU: fixed.FromInt(24),
		Ballistic:      true,
	}
	return m
}

// TestModelLessShotFliesAndRestores proves a cannon shell with no 3DO model now
// flies as a tracked projectile (so true ballistics + a late joiner can restore
// it) rather than hitting instantly, and that the in-flight shell survives an
// export/restore round-trip into a fresh world.
func TestModelLessShotFliesAndRestores(t *testing.T) {
	w := New(Config{Seed: 21})
	atk := w.AddUnit("atk", cannonMeta("atk"), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", cannonMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(260)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	var snapTick uint64
	var projos []RestoredProjectile
	for i := 0; i < 300; i++ {
		w.Step(nil)
		if len(w.projectiles) > 0 {
			snapTick = w.Tick()
			projos = w.ExportProjectiles()
			break
		}
	}
	if len(projos) == 0 {
		t.Fatal("model-less cannon never spawned a tracked projectile")
	}
	if projos[0].Model != "" {
		t.Fatalf("expected a model-less projectile, got model %q", projos[0].Model)
	}

	// The shell must restore into a fresh world so a late joiner sees it mid-air.
	client := New(Config{Seed: 21})
	client.Restore(snapTick, nil, projos)
	if len(client.projectiles) != len(projos) {
		t.Fatalf("restored projectile count = %d, want %d", len(client.projectiles), len(projos))
	}
}
