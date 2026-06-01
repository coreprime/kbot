package session

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/sim"
)

func meta() *sim.UnitMeta {
	return &sim.UnitMeta{
		Name: "u", CanMove: true,
		MaxVelocity: fixed.FromFloat(1.5),
		TurnRate:    fixed.FromInt(800),
		Accel:       fixed.FromFloat(0.1),
		BrakeRate:   fixed.FromFloat(0.2),
	}
}

func TestInputDelaySchedules(t *testing.T) {
	w := sim.New(sim.Config{Seed: 1})
	id := w.AddUnit("u", meta(), nil, fixed.Vec2{}, 0, 0)
	s := New(Config{World: w, InputDelay: 5})
	exec := s.Submit(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(100)}))
	if exec != 6 { // tick 0 + delay 5 + 1
		t.Fatalf("expected exec tick 6, got %d", exec)
	}
	// The unit should not begin moving until the order's execution tick.
	for w.Tick() < 5 {
		s.Step()
		if w.UnitByID(id).IsMoving {
			t.Fatalf("moved before execution tick at %d", w.Tick())
		}
	}
	s.Step() // tick 6 applies the order
	for i := 0; i < 5; i++ {
		s.Step()
	}
	if !w.UnitByID(id).IsMoving {
		t.Errorf("unit should be moving after execution tick")
	}
}

// TestLockstepAgreement is the property that makes hybrid prediction sound: two
// independent sessions that apply the identical command stream at the identical
// ticks reach bit-identical state. One stands in for the server, one for a
// predicting client.
func TestLockstepAgreement(t *testing.T) {
	build := func() (*Session, uint32) {
		w := sim.New(sim.Config{Seed: 7})
		id := w.AddUnit("u", meta(), nil, fixed.Vec2{}, 0, 0)
		w.AddUnit("e", meta(), nil, fixed.Vec2{X: fixed.FromInt(250)}, 0, 1)
		return New(Config{World: w}), id
	}
	server, sid := build()
	client, cid := build()
	if sid != cid {
		t.Fatal("setup mismatch")
	}
	// Identical command stream scheduled at identical ticks on both.
	cmds := []struct {
		tick uint64
		ord  order.Order
	}{
		{3, order.Move([]uint32{sid}, fixed.Vec2{X: fixed.FromInt(120), Z: fixed.FromInt(40)})},
		{40, order.Attack([]uint32{sid}, 2)},
		{120, order.Stop([]uint32{sid})},
	}
	for _, c := range cmds {
		server.ScheduleAt(c.tick, c.ord)
		client.ScheduleAt(c.tick, c.ord)
	}
	for i := 0; i < 300; i++ {
		server.Step()
		client.Step()
		if server.World().Hash() != client.World().Hash() {
			t.Fatalf("desync at tick %d", server.World().Tick())
		}
	}
}
