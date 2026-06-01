package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// scoutMeta mirrors the synthetic demo unit: a mobile, weaponless unit, enough
// to exercise surface locomotion under resync.
func scoutMeta() *UnitMeta {
	return &UnitMeta{
		Name:        "scout",
		CanMove:     true,
		MaxVelocity: fixed.FromFloat(1.6),
		TurnRate:    fixed.FromFloat(1000),
		Accel:       fixed.FromFloat(0.12),
		BrakeRate:   fixed.FromFloat(0.25),
	}
}

func scoutSpawn(name string) (*UnitMeta, Binding) {
	if name != "scout" {
		return nil, nil
	}
	return scoutMeta(), nil
}

// TestRestoreResumesMidMove proves a world rebuilt from ExportUnits is
// bit-identical to the original — including a unit caught mid-move — and stays
// in lockstep as both worlds step forward. This is the property a late-joining
// client relies on to resync to the authority without drift.
func TestRestoreResumesMidMove(t *testing.T) {
	authority := New(Config{Seed: 7, Spawn: scoutSpawn})
	id := authority.AddUnit("scout", scoutMeta(), nil, fixed.Vec2{X: fixed.FromInt(200), Z: fixed.FromInt(200)}, 0, 0)
	authority.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(800), Z: fixed.FromInt(800)}))

	// Advance far enough that the unit is turning and accelerating, not at rest.
	for i := 0; i < 20; i++ {
		authority.Step(nil)
	}

	snapTick := authority.Tick()
	exported := authority.ExportUnits()
	if len(exported) != 1 || !exported[0].HasMove || exported[0].Speed == 0 {
		t.Fatalf("expected a moving unit in the export, got %+v", exported)
	}

	// Rebuild a fresh world from the export, as a resyncing client would.
	client := New(Config{Seed: 7, Spawn: scoutSpawn})
	client.Restore(snapTick, exported)

	if client.Tick() != snapTick {
		t.Fatalf("restored tick = %d, want %d", client.Tick(), snapTick)
	}
	if got, want := client.Hash(), authority.Hash(); got != want {
		t.Fatalf("hash mismatch immediately after restore: client=%d authority=%d", got, want)
	}

	// Both worlds must evolve identically with no further orders.
	for i := 0; i < 60; i++ {
		authority.Step(nil)
		client.Step(nil)
		if got, want := client.Hash(), authority.Hash(); got != want {
			t.Fatalf("hash diverged %d ticks after restore: client=%d authority=%d", i+1, got, want)
		}
	}
}
