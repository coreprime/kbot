package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// blastMeta arms a unit with explicit death blasts: a modest explodeas and a
// huge selfdestructas, the TA pattern.
func blastMeta(name string) *UnitMeta {
	m := testMeta(name)
	m.MaxHealth = fixed.FromInt(100)
	m.Explode = Blast{Damage: fixed.FromInt(30), AoE: fixed.FromInt(80), Edge: fixed.FromFloat(0.25)}
	m.SelfD = Blast{Damage: fixed.FromInt(400), AoE: fixed.FromInt(200), Edge: fixed.FromFloat(0.5)}
	return m
}

// TestSelfDestructCountdownAndBlast pins Ctrl+D: the fuse runs 5 seconds
// (cancellable), then the unit dies and its selfdestructas splash kills the
// bystander parked inside the blast.
func TestSelfDestructCountdownAndBlast(t *testing.T) {
	w := New(Config{Seed: 61})
	bomb := w.AddUnit("bomb", blastMeta("bomb"), nil, fixed.Vec2{}, 0, 0)
	near := w.AddUnit("near", blastMeta("near"), nil, fixed.Vec2{X: fixed.FromInt(60)}, 0, 1)
	w.ApplyOrder(order.Stance([]uint32{near}, order.MoveHold, order.FireHold))

	// Arm, then disarm: the unit must survive well past the fuse window.
	w.ApplyOrder(order.SelfDestruct([]uint32{bomb}))
	if w.UnitByID(bomb).selfDAtMs == 0 {
		t.Fatalf("fuse did not arm")
	}
	w.ApplyOrder(order.SelfDestruct([]uint32{bomb}))
	for i := 0; i < 40*7; i++ {
		w.Step(nil)
	}
	if w.UnitByID(bomb).Dead {
		t.Fatalf("disarmed unit still detonated")
	}

	// Arm for real: dead within ~5s, and the bystander 60wu out (inside the
	// 100wu blast radius) is splashed to death by the 400-damage charge.
	w.ApplyOrder(order.SelfDestruct([]uint32{bomb}))
	for i := 0; i < 40*6 && !w.UnitByID(bomb).Dead; i++ {
		w.Step(nil)
	}
	if !w.UnitByID(bomb).Dead {
		t.Fatalf("armed unit never detonated")
	}
	if !w.UnitByID(near).Dead {
		t.Fatalf("bystander survived a 400-damage blast at 60wu: hp=%v",
			w.UnitByID(near).Health.Float())
	}
}

// TestExplodeSplashWithEdgeFalloff pins the ordinary death blast: a combat
// kill splashes neighbours, scaled down toward the blast rim, and out-of-
// radius units are untouched.
func TestExplodeSplashWithEdgeFalloff(t *testing.T) {
	w := New(Config{Seed: 62})
	victim := w.AddUnit("victim", blastMeta("victim"), nil, fixed.Vec2{}, 0, 1)
	close := w.AddUnit("close", blastMeta("close"), nil, fixed.Vec2{X: fixed.FromInt(10)}, 0, 1)
	rim := w.AddUnit("rim", blastMeta("rim"), nil, fixed.Vec2{X: fixed.FromInt(38)}, 0, 1)
	far := w.AddUnit("far", blastMeta("far"), nil, fixed.Vec2{X: fixed.FromInt(200)}, 0, 1)
	for _, id := range []uint32{victim, close, rim, far} {
		w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	}
	// Kill the victim outright; its 30-damage / 80wu explodeas detonates.
	w.ApplyDamage(victim, victim, fixed.FromInt(1000))
	if !w.UnitByID(victim).Dead {
		t.Fatalf("victim survived the setup kill")
	}
	hpClose := w.UnitByID(close).Health.Float()
	hpRim := w.UnitByID(rim).Health.Float()
	hpFar := w.UnitByID(far).Health.Float()
	if hpClose >= 100 || hpRim >= 100 {
		t.Fatalf("splash missed in-radius units: close=%v rim=%v", hpClose, hpRim)
	}
	if hpClose >= hpRim {
		t.Fatalf("edge falloff inverted: close=%v rim=%v", hpClose, hpRim)
	}
	if hpFar < 100 {
		t.Fatalf("splash reached beyond the blast radius: far=%v", hpFar)
	}
}
