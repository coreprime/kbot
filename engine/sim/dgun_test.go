package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
)

// dgunMeta builds the ARM disintegrator's shipped stat block: a slow flying
// "dgun" ball, big blast, huge damage, noexplode (keeps flying), commandfire.
func dgunMeta() WeaponMeta {
	return WeaponMeta{
		Name:           "ARM_DISINTEGRATOR",
		Present:        true,
		CommandFire:    true,
		NoExplode:      true,
		Model:          "dgun",
		Range:          fixed.FromInt(240),
		VelocityWU:     fixed.FromInt(200),
		AreaOfEffectWU: fixed.FromInt(48),
		FlightTimeSec:  fixed.FromInt(4),
		DamageDefault:  5500,
		Damage:         fixed.FromInt(5500),
		EdgeEffectiveness: 0.5,
	}
}

func victimMeta() *UnitMeta {
	m := &UnitMeta{Name: "victim", CanMove: true, MaxHealth: fixed.FromInt(300)}
	m.FootprintX, m.FootprintZ = 2, 2
	return m
}

// TestDGunDisintegratesChainIncludingFriendlies pins the D-gun behaviour: a
// disintegrator fired down a line of units — friendly and enemy interleaved —
// keeps flying (noexplode) and disintegrates the whole chain, the splash of
// each detonation catching friendlies too. Fired near the floor it must still
// travel and kill, not fizzle into terrain.
func TestDGunDisintegratesChainIncludingFriendlies(t *testing.T) {
	w := New(Config{Seed: 3})

	// Shooter on side 0 at the origin, muzzle just above the floor.
	shooter := w.AddUnit("com", victimMeta(), nil, fixed.Vec2{}, 0, 0)

	// A line of victims straight down +Z, alternating enemy(1)/friend(0),
	// spaced so consecutive blasts overlap the chain.
	type vic struct {
		id   uint32
		side int
	}
	var victims []vic
	sides := []int{1, 0, 1, 0} // enemy, friend, enemy, friend — a packed chain
	for i, side := range sides {
		z := fixed.FromInt(60 + 20*i)
		id := w.AddUnit("v", victimMeta(), nil, fixed.Vec2{Z: z}, 0, side)
		victims = append(victims, vic{id: id, side: side})
	}

	// Fire the disintegrator near the floor: muzzle low, aim at the far end of
	// the line at ground level.
	wm := dgunMeta()
	anchor := fixed.Vec3{Y: fixed.FromInt(6)}
	target := fixed.Vec3{Z: fixed.FromInt(60 + 20*3), Y: fixed.FromInt(4)}
	p := w.makeProjectile(shooter, 0, 2, wm, anchor, target, -1)
	w.nextProjID++
	w.projectiles = append(w.projectiles, p)

	for i := 0; i < 200 && len(w.projectiles) > 0; i++ {
		w.Step(nil)
	}

	// The shooter itself is excluded from its own blast and survives.
	if s := w.UnitByID(shooter); s == nil || s.Dead {
		t.Fatalf("shooter should not disintegrate itself")
	}
	// Every unit in the chain — enemy and friendly alike — is disintegrated.
	for _, v := range victims {
		u := w.UnitByID(v.id)
		if u == nil || !u.Dead {
			side := "enemy"
			if v.side == 0 {
				side = "friendly"
			}
			t.Fatalf("%s victim %d survived the D-gun chain (health %v)", side, v.id, healthOf(u))
		}
	}
}

func healthOf(u *Unit) float64 {
	if u == nil {
		return -1
	}
	return u.Health.Float()
}

// TestDGunNearFloorDoesNotFizzle pins the near-floor case: with terrain
// installed, a disintegrator fired low along the ground must keep travelling
// and disintegrate its target rather than clipping into the slope and dying
// on the first tick below grade (which the terrain-block clip does to a normal
// shot). The noexplode sweep is exempt from that clip.
func TestDGunNearFloorDoesNotFizzle(t *testing.T) {
	w := New(Config{Seed: 5})
	w.SetTerrain(testTerrain(60, 60, 0, func(_, _ int) uint8 { return 0 }))

	shooter := w.AddUnit("com", victimMeta(), nil, fixed.Vec2{X: fixed.FromInt(120), Z: fixed.FromInt(120)}, 0, 0)
	// Enemy well down the line, both at ground level.
	enemy := w.AddUnit("v", victimMeta(), nil, fixed.Vec2{X: fixed.FromInt(120), Z: fixed.FromInt(220)}, 0, 1)

	wm := dgunMeta()
	// Muzzle right at the floor and the aim point at the floor — a normal shot
	// would clip terrain almost immediately.
	anchor := fixed.Vec3{X: fixed.FromInt(120), Y: fixed.FromInt(2), Z: fixed.FromInt(120)}
	target := fixed.Vec3{X: fixed.FromInt(120), Y: fixed.Zero, Z: fixed.FromInt(220)}
	p := w.makeProjectile(shooter, enemy, 2, wm, anchor, target, -1)
	w.nextProjID++
	w.projectiles = append(w.projectiles, p)

	for i := 0; i < 200 && len(w.projectiles) > 0; i++ {
		w.Step(nil)
	}
	if u := w.UnitByID(enemy); u == nil || !u.Dead {
		t.Fatalf("near-floor D-gun failed to disintegrate its target (health %v)", healthOf(u))
	}
}
