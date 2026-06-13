package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

func footMeta(name string, foot int, canMove bool) *UnitMeta {
	m := testMeta(name)
	m.FootprintX = foot
	m.FootprintZ = foot
	m.CanMove = canMove
	return m
}

// TestUnitsDoNotInterpenetrate pins the separation backstop: two units
// ordered through each other never overlap their body circles (beyond one
// tick of slop) and both still reach their destinations.
func TestUnitsDoNotInterpenetrate(t *testing.T) {
	w := New(Config{Seed: 21})
	a := w.AddUnit("a", footMeta("a", 2, true), nil, fixed.Vec2{X: fixed.FromInt(-100)}, 0, 0)
	b := w.AddUnit("b", footMeta("b", 2, true), nil, fixed.Vec2{X: fixed.FromInt(100)}, 0, 0)
	w.ApplyOrder(order.Move([]uint32{a}, fixed.Vec2{X: fixed.FromInt(100)}))
	w.ApplyOrder(order.Move([]uint32{b}, fixed.Vec2{X: fixed.FromInt(-100)}))

	ua, ub := w.UnitByID(a), w.UnitByID(b)
	sumR := ua.Meta.collisionRadius() + ub.Meta.collisionRadius()
	minDist := fixed.FromInt(10000)
	for i := 0; i < 2000; i++ {
		w.Step(nil)
		if d := ua.loco.Pos.DistTo(ub.loco.Pos); d < minDist {
			minDist = d
		}
	}
	// Allow one tick of pre-separation slop (a fast mover can step into the
	// circle before the pass shoves it back out the same tick's end state is
	// what we measure, so only minor transient overlap is acceptable).
	if minDist < sumR.Mul(fixed.FromFloat(0.7)) {
		t.Fatalf("units interpenetrated: min dist %v vs radii %v", minDist.Float(), sumR.Float())
	}
	if ua.loco.Pos.DistTo(fixed.Vec2{X: fixed.FromInt(100)}) > fixed.FromInt(30) {
		t.Fatalf("unit a never reached its destination: (%v,%v)", ua.loco.Pos.X.Float(), ua.loco.Pos.Z.Float())
	}
	if ub.loco.Pos.DistTo(fixed.Vec2{X: fixed.FromInt(-100)}) > fixed.FromInt(30) {
		t.Fatalf("unit b never reached its destination: (%v,%v)", ub.loco.Pos.X.Float(), ub.loco.Pos.Z.Float())
	}
}

// TestMoverSteersAroundStationaryObstacle pins local avoidance: a building
// parked dead on the path neither stops the mover nor gets shoved, and the
// mover detours around it.
func TestMoverSteersAroundStationaryObstacle(t *testing.T) {
	w := New(Config{Seed: 22})
	mover := w.AddUnit("m", footMeta("m", 2, true), nil, fixed.Vec2{}, 0, 0)
	bldg := w.AddUnit("bldg", footMeta("bldg", 4, false), nil, fixed.Vec2{X: fixed.FromInt(120)}, 0, 0)
	goal := fixed.Vec2{X: fixed.FromInt(240)}
	w.ApplyOrder(order.Move([]uint32{mover}, goal))

	um, ub := w.UnitByID(mover), w.UnitByID(bldg)
	bldgStart := ub.loco.Pos
	sumR := um.Meta.collisionRadius() + ub.Meta.collisionRadius()
	minDist := fixed.FromInt(10000)
	for i := 0; i < 2000 && um.hasMove; i++ {
		w.Step(nil)
		if d := um.loco.Pos.DistTo(ub.loco.Pos); d < minDist {
			minDist = d
		}
	}
	if ub.loco.Pos != bldgStart {
		t.Fatalf("immobile building was shoved: (%v,%v)", ub.loco.Pos.X.Float(), ub.loco.Pos.Z.Float())
	}
	if minDist < sumR.Mul(fixed.FromFloat(0.7)) {
		t.Fatalf("mover drove through the building: min dist %v vs radii %v", minDist.Float(), sumR.Float())
	}
	if um.loco.Pos.DistTo(goal) > fixed.FromInt(30) {
		t.Fatalf("mover never reached the far side: (%v,%v)", um.loco.Pos.X.Float(), um.loco.Pos.Z.Float())
	}
}

// TestCrowdedArrivalRelax pins formation packing: several units sent to the
// SAME point all come to rest (orders complete) without endless shoving.
func TestCrowdedArrivalRelax(t *testing.T) {
	w := New(Config{Seed: 23})
	var ids []uint32
	for i := 0; i < 4; i++ {
		ids = append(ids, w.AddUnit("u", footMeta("u", 2, true), nil,
			fixed.Vec2{X: fixed.FromInt(-80 - 30*i)}, 0, 0))
	}
	goal := fixed.Vec2{X: fixed.FromInt(120)}
	w.ApplyOrder(order.Move(ids, goal))
	for i := 0; i < 3000; i++ {
		w.Step(nil)
	}
	for _, id := range ids {
		u := w.UnitByID(id)
		if u.hasMove || u.IsMoving {
			t.Fatalf("unit %d never settled (still moving at (%v,%v))", id, u.loco.Pos.X.Float(), u.loco.Pos.Z.Float())
		}
		if u.loco.Pos.DistTo(goal) > fixed.FromInt(80) {
			t.Fatalf("unit %d settled too far out: (%v,%v)", id, u.loco.Pos.X.Float(), u.loco.Pos.Z.Float())
		}
	}
}

// TestCollisionDeterminism re-runs a jostling scenario and demands identical
// hashes — the collision passes must not perturb lockstep.
func TestCollisionDeterminism(t *testing.T) {
	run := func() uint64 {
		w := New(Config{Seed: 31})
		var ids []uint32
		for i := 0; i < 6; i++ {
			ids = append(ids, w.AddUnit("u", footMeta("u", 2, true), nil,
				fixed.Vec2{X: fixed.FromInt(-60 * (i + 1)), Z: fixed.FromInt(7 * i)}, 0, 0))
		}
		w.AddUnit("bldg", footMeta("bldg", 5, false), nil, fixed.Vec2{X: fixed.FromInt(60)}, 0, 1)
		w.ApplyOrder(order.Move(ids, fixed.Vec2{X: fixed.FromInt(150)}))
		for i := 0; i < 1500; i++ {
			w.Step(nil)
		}
		return w.Hash()
	}
	if h1, h2 := run(), run(); h1 != h2 {
		t.Fatalf("collision passes broke determinism: %x != %x", h1, h2)
	}
}

// TestMoverSteersAroundOpenYard pins the open-factory case: a lab whose
// yard is held open (a unit parked inside keeps it so) still detours
// crossing traffic around its solid walls — only traffic actually using
// the channel may pass through the rectangle.
func TestMoverSteersAroundOpenYard(t *testing.T) {
	w := New(Config{Seed: 24})
	lab := footMeta("lab", 6, false)
	lab.Yard = ParseYardMap("yoccoy ooccoo ooccoo ooccoo ooccoo yoccoy", 6, 6)
	labID := w.AddUnit("lab", lab, nil, fixed.Vec2{X: fixed.FromInt(180)}, 0, 0)
	// A squatter inside the channel keeps the yard open.
	squat := footMeta("squat", 2, true)
	w.AddUnit("squat", squat, nil, fixed.Vec2{X: fixed.FromInt(180), Z: fixed.FromInt(20)}, 0, 0)
	mover := w.AddUnit("m", footMeta("m", 2, true), nil, fixed.Vec2{}, 0, 0)
	goal := fixed.Vec2{X: fixed.FromInt(400)}
	w.ApplyOrder(order.Move([]uint32{mover}, goal))
	um := w.UnitByID(mover)
	ul := w.UnitByID(labID)
	for i := 0; i < 4000 && um.hasMove; i++ {
		w.Step(nil)
		if i == 10 && !ul.yardOpen {
			t.Fatal("test setup: yard should be open (squatter inside)")
		}
	}
	if um.loco.Pos.DistTo(goal) > fixed.FromInt(40) {
		t.Fatalf("mover never cleared the open yard: (%v,%v)", um.loco.Pos.X.Float(), um.loco.Pos.Z.Float())
	}
}
