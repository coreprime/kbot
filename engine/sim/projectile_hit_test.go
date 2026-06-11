package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
)

// TestStraightProjectileHitsStationaryPoint pins the basic arrival capture:
// a straight powered shot registers its hit at the aim point.
func TestStraightProjectileHitsStationaryPoint(t *testing.T) {
	w := New(Config{Seed: 1})
	wm := WeaponMeta{
		Name: "EMG", Range: fixed.FromInt(180), ReloadMs: 400, Burst: 3,
		Damage: fixed.FromInt(8), Present: true,
		VelocityWU: fixed.FromInt(300), FlightTimeSec: fixed.FromInt(1),
		AreaOfEffectWU: fixed.FromInt(8),
	}
	anchor := fixed.Vec3{Y: fixed.FromInt(12)}
	target := fixed.Vec3{X: fixed.FromInt(80)}
	p := w.makeProjectile(1, 2, 0, wm, anchor, target, -1)
	for i := 0; i < 200 && !p.dead; i++ {
		p.stepProjectile(fixed.Zero)
	}
	t.Logf("dead=%v hit=%v age=%v pos=(%v,%v,%v) target=(%v,%v,%v) speed=%v life=%v",
		p.dead, p.hit, p.ageSec.Float(),
		p.pos.X.Float(), p.pos.Y.Float(), p.pos.Z.Float(),
		p.target.X.Float(), p.target.Y.Float(), p.target.Z.Float(),
		p.speed.Float(), p.lifeSec.Float())
	if !p.hit {
		t.Fatal("straight shot never registered its hit")
	}
}

// TestRealEMGMetaCombat reproduces the Peewee's shipped EMG stats end to end.
// It guards the detonation-snap fix: the EMG travels 7.5 wu per tick but
// blasts only a 4 wu radius, so detonating up to a tick short of the target
// (the old behaviour) never damaged it — units traded fire forever.
func TestRealEMGMetaCombat(t *testing.T) {
	w := New(Config{Seed: 7})
	mk := func() *UnitMeta {
		m := &UnitMeta{
			Name: "armpw", CanMove: true,
			MaxVelocity: fixed.FromFloat(1.25), TurnRate: fixed.FromInt(450),
			Accel: fixed.FromFloat(0.2), BrakeRate: fixed.FromFloat(0.4),
			MaxHealth: fixed.FromInt(250),
		}
		m.Weapons[0] = WeaponMeta{
			Name: "EMG", Range: fixed.FromInt(180), ReloadMs: 400, Burst: 3,
			Damage: fixed.FromInt(8), Present: true, Tolerance: 6000,
			VelocityWU: fixed.FromInt(300), FlightTimeSec: fixed.FromInt(1),
			AreaOfEffectWU: fixed.FromInt(8),
		}
		return m
	}
	atk := w.AddUnit("a", mk(), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("d", mk(), nil, fixed.Vec2{X: fixed.FromInt(80)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))
	fires, hits := 0, 0
	for i := 0; i < 2000 && !w.UnitByID(def).Dead; i++ {
		w.Step(nil)
		for _, ev := range w.Snapshot().Events {
			if ev.Kind == frame.EvFire {
				fires++
			}
			if ev.Kind == frame.EvHit {
				hits++
			}
		}
		if hits == 0 && fires > 0 && len(w.projectiles) > 0 && fires < 3 {
			p := w.projectiles[0]
			t.Logf("proj: pos=(%v,%v,%v) vel=(%v,%v,%v) target=(%v,%v,%v) life=%v aoe=%v",
				p.pos.X.Float(), p.pos.Y.Float(), p.pos.Z.Float(),
				p.vel.X.Float(), p.vel.Y.Float(), p.vel.Z.Float(),
				p.target.X.Float(), p.target.Y.Float(), p.target.Z.Float(),
				p.lifeSec.Float(), p.aoe.Float())
		}
	}
	t.Logf("fires=%d hits=%d defHealth=%v dead=%v", fires, hits, w.UnitByID(def).Health.Float(), w.UnitByID(def).Dead)
	if !w.UnitByID(def).Dead {
		t.Fatal("defender survived with real EMG meta")
	}
}

// TestRealEMGMetaForceFire mirrors the sandbox's force-fire path (KindFire at
// a unit) with the Peewee's shipped stats — the order the Controls panel's
// Primary button issues.
func TestRealEMGMetaForceFire(t *testing.T) {
	w := New(Config{Seed: 9})
	mk := func() *UnitMeta {
		m := &UnitMeta{
			Name: "armpw", CanMove: true,
			MaxVelocity: fixed.FromFloat(1.25), TurnRate: fixed.FromInt(450),
			Accel: fixed.FromFloat(0.2), BrakeRate: fixed.FromFloat(0.4),
			MaxHealth: fixed.FromInt(250),
		}
		m.Weapons[0] = WeaponMeta{
			Name: "EMG", Range: fixed.FromInt(180), ReloadMs: 400, Burst: 3,
			Damage: fixed.FromInt(8), Present: true, Tolerance: 6000,
			VelocityWU: fixed.FromInt(300), FlightTimeSec: fixed.FromInt(1),
			AreaOfEffectWU: fixed.FromInt(8),
		}
		return m
	}
	atk := w.AddUnit("a", mk(), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("d", mk(), nil, fixed.Vec2{X: fixed.FromInt(35)}, 0, 1)
	w.ApplyOrder(order.FireAtUnit(atk, 0, def))
	fires := 0
	for i := 0; i < 2000 && !w.UnitByID(def).Dead; i++ {
		w.Step(nil)
		for _, ev := range w.Snapshot().Events {
			if ev.Kind == frame.EvFire {
				fires++
			}
		}
	}
	t.Logf("fires=%d defHealth=%v dead=%v", fires, w.UnitByID(def).Health.Float(), w.UnitByID(def).Dead)
	if !w.UnitByID(def).Dead {
		t.Fatal("force-fired defender survived")
	}
}
