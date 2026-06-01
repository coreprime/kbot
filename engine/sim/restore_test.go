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
	client.Restore(snapTick, exported, authority.ExportProjectiles())

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

// TestRestoreCarriesWeaponState proves the export/restore round-trip preserves a
// unit's standing attack and per-slot weapon orders, the state a late joiner's
// prediction needs to re-engage a weapon caught mid-fire rather than snapping it
// back to its Create-time rest pose.
func TestRestoreCarriesWeaponState(t *testing.T) {
	authority := New(Config{Seed: 3, Spawn: scoutSpawn})
	id := authority.AddUnit("scout", scoutMeta(), nil, fixed.Vec2{X: fixed.FromInt(100), Z: fixed.FromInt(100)}, 0, 0)

	// Plant standing combat state directly: a unit attacking another, with a
	// manual force-fire at a ground point in slot 1.
	u := authority.units[id]
	u.hasAttack = true
	u.attackTarget = 42
	u.weapons[0] = weaponSlot{hasTarget: true, targetUnit: 42, source: "attack", lastFireMs: 5000}
	u.weapons[1] = weaponSlot{
		hasTarget: true,
		targetPt:  fixed.Vec3{X: fixed.FromInt(300), Z: fixed.FromInt(400)},
		source:    "manual",
	}

	exported := authority.ExportUnits()
	if len(exported) != 1 {
		t.Fatalf("expected 1 exported unit, got %d", len(exported))
	}
	ru := exported[0]
	if !ru.HasAttack || ru.AttackTarget != 42 {
		t.Fatalf("attack state not exported: %+v", ru)
	}
	if !ru.Weapons[0].HasTarget || ru.Weapons[0].TargetUnit != 42 || ru.Weapons[0].Source != "attack" {
		t.Fatalf("slot 0 not exported: %+v", ru.Weapons[0])
	}
	if ru.Weapons[0].LastFireMs != 5000 {
		t.Fatalf("slot 0 fire clock not exported: got %d, want 5000", ru.Weapons[0].LastFireMs)
	}
	if !ru.Weapons[1].HasTarget || ru.Weapons[1].Source != "manual" ||
		ru.Weapons[1].TargetPt.X != fixed.FromInt(300) || ru.Weapons[1].TargetPt.Z != fixed.FromInt(400) {
		t.Fatalf("slot 1 not exported: %+v", ru.Weapons[1])
	}

	client := New(Config{Seed: 3, Spawn: scoutSpawn})
	client.Restore(authority.Tick(), exported, nil)

	cu := client.units[id]
	if cu == nil {
		t.Fatalf("restored unit %d missing", id)
	}
	if !cu.hasAttack || cu.attackTarget != 42 {
		t.Fatalf("attack state not restored: hasAttack=%v target=%d", cu.hasAttack, cu.attackTarget)
	}
	if !cu.weapons[0].hasTarget || cu.weapons[0].targetUnit != 42 || cu.weapons[0].source != "attack" {
		t.Fatalf("slot 0 not restored: %+v", cu.weapons[0])
	}
	if cu.weapons[0].lastFireMs != 5000 {
		t.Fatalf("slot 0 fire clock not restored: got %d, want 5000", cu.weapons[0].lastFireMs)
	}
	if !cu.weapons[1].hasTarget || cu.weapons[1].source != "manual" ||
		cu.weapons[1].targetPt.X != fixed.FromInt(300) || cu.weapons[1].targetPt.Z != fixed.FromInt(400) {
		t.Fatalf("slot 1 not restored: %+v", cu.weapons[1])
	}
	// An untargeted slot must stay clear.
	if cu.weapons[2].hasTarget {
		t.Fatalf("slot 2 should be clear, got %+v", cu.weapons[2])
	}
}

// TestRestoreCarriesProjectiles proves an in-flight missile survives the
// export/restore round-trip and that the rebuilt world stays bit-identical as
// both step forward — the missile lands and applies its damage on the same tick
// on the joiner as on the authority. Without it the joiner's sky is empty and
// the target's health diverges the moment the dropped shot would have hit.
func TestRestoreCarriesProjectiles(t *testing.T) {
	combatSpawn := func(name string) (*UnitMeta, Binding) {
		switch name {
		case "hawk":
			return fighterMeta("hawk"), nil
		case "rock":
			return groundMeta("rock"), nil
		}
		return nil, nil
	}

	authority := New(Config{Seed: 3, Spawn: combatSpawn})
	atk := authority.AddUnit("hawk", fighterMeta("hawk"), nil, fixed.Vec2{}, 0, 0)
	authority.AddUnit("rock", groundMeta("rock"), nil, fixed.Vec2{X: fixed.FromInt(500)}, 0, 1)
	authority.ApplyOrder(order.Attack([]uint32{atk}, 2))

	// Fly the fighter until it has lined up and put a missile in the air.
	for i := 0; i < 600 && len(authority.projectiles) == 0; i++ {
		authority.Step(nil)
	}
	if len(authority.projectiles) == 0 {
		t.Fatal("fighter never fired a missile to capture in flight")
	}

	snapTick := authority.Tick()
	units := authority.ExportUnits()
	projos := authority.ExportProjectiles()
	if len(projos) == 0 {
		t.Fatal("expected at least one in-flight projectile to export")
	}

	client := New(Config{Seed: 3, Spawn: combatSpawn})
	client.Restore(snapTick, units, projos)

	if len(client.projectiles) != len(authority.projectiles) {
		t.Fatalf("restored projectile count = %d, want %d", len(client.projectiles), len(authority.projectiles))
	}
	if got, want := client.Hash(), authority.Hash(); got != want {
		t.Fatalf("hash mismatch immediately after restore: client=%d authority=%d", got, want)
	}

	// Step both forward through the missile's impact; health must stay in lockstep,
	// which only holds if the carried projectile detonates identically.
	for i := 0; i < 120; i++ {
		authority.Step(nil)
		client.Step(nil)
		if got, want := client.Hash(), authority.Hash(); got != want {
			t.Fatalf("hash diverged %d ticks after restore: client=%d authority=%d", i+1, got, want)
		}
	}
}
