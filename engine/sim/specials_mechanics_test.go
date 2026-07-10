package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// spellMeta builds a TA:K caster whose weapon 0 is a mana-priced spell (a
// projectile-flying Line-of-Sight bolt). The private pool spawns empty; a test
// seats it via SetPrivateMana.
func spellMeta(name string, manaPerShot float64) *UnitMeta {
	m := &UnitMeta{
		Name:        name,
		CanMove:     true,
		MaxVelocity: fixed.FromFloat(1.2),
		TurnRate:    fixed.FromInt(600),
		Accel:       fixed.FromFloat(0.1),
		BrakeRate:   fixed.FromFloat(0.2),
		MaxHealth:   fixed.FromInt(100),
		MaxMana:     500,
	}
	m.Weapons[0] = WeaponMeta{
		Name: "spell", Range: fixed.FromInt(300), ReloadMs: 1000, Burst: 1,
		Damage: fixed.FromInt(25), Present: true,
		DamageDefault: 25, ReloadTicks: 30, VelocityWU: fixed.FromInt(400),
		AreaOfEffectWU: fixed.FromInt(8), ManaPerShot: manaPerShot,
	}
	return m
}

// TestSpellDebitsPrivateMana pins the TA:K spell drain (specials.md §7.1): a
// caster with mana casts and its private pool drops by the veteran-discounted
// ManaPerShot; a caster with an empty pool never fires.
func TestSpellDebitsPrivateMana(t *testing.T) {
	w := New(Config{Seed: 90, Economy: EconomyTAK})
	caster := w.AddUnit("caster", spellMeta("caster", 60), nil, fixed.Vec2{}, 0, 0)
	prey := w.AddUnit("prey", spellMeta("prey", 0), nil, fixed.Vec2{X: fixed.FromInt(120)}, 1, 1)
	w.SetPrivateMana(caster, 200)
	w.ApplyOrder(order.FireAtUnit(caster, 0, prey))

	start := w.PrivateMana(caster)
	fired := false
	for i := 0; i < 60 && !fired; i++ {
		w.Step(nil)
		if w.PrivateMana(caster) < start {
			fired = true
		}
	}
	if !fired {
		t.Fatalf("caster with mana never cast: pool still %v", w.PrivateMana(caster))
	}
	// The drain equals the (level-0) ManaPerShot: 60. Recharge is 0 (no
	// ManaRechargeTick), so the post-cast pool is exactly start-60 until the
	// next reload.
	if got := start - w.PrivateMana(caster); got < 59 || got > 61 {
		t.Fatalf("spell drained %v mana, want ~60", got)
	}
}

// TestEmptyCasterCannotCast pins the aim gate (specials.md §7.1): a caster
// whose private pool is below the spell cost never fires and its target is
// untouched.
func TestEmptyCasterCannotCast(t *testing.T) {
	w := New(Config{Seed: 91, Economy: EconomyTAK})
	caster := w.AddUnit("caster", spellMeta("caster", 60), nil, fixed.Vec2{}, 0, 0)
	prey := w.AddUnit("prey", spellMeta("prey", 0), nil, fixed.Vec2{X: fixed.FromInt(120)}, 1, 1)
	w.SetPrivateMana(caster, 10) // below the 60-mana cost
	w.ApplyOrder(order.FireAtUnit(caster, 0, prey))
	for i := 0; i < 60; i++ {
		w.Step(nil)
	}
	if hp := w.UnitByID(prey).Health; hp < fixed.FromInt(100) {
		t.Fatalf("empty caster still cast: prey HP %v", hp.Float())
	}
	if m := w.PrivateMana(caster); m != 10 {
		t.Fatalf("empty caster spent mana it did not have: pool %v", m)
	}
}

// TestSpellVeteranDiscount pins the veteran discount (specials.md §4.2 c1): a
// level-5 caster (xp = 5·experiencepoints) pays ManaPerShot/(1+0.1·5).
func TestSpellVeteranDiscount(t *testing.T) {
	w := New(Config{Seed: 92, Economy: EconomyTAK})
	m := spellMeta("caster", 60)
	m.ExperiencePoints = 100
	caster := w.AddUnit("caster", m, nil, fixed.Vec2{}, 0, 0)
	w.SetUnitKills(caster, 5) // xp = 500 => level 5 => vet 1.5
	if got := w.SpellManaCost(caster, 0); got < 39.9 || got > 40.1 {
		t.Fatalf("veteran spell cost %v, want 40 (60/1.5)", got)
	}
}

// nukeMeta builds a TA stockpile launcher: weapon 0 is a targetable, straight-
// flying stockpiled shot with a short (5-tick) build interval.
func nukeMeta(name string) *UnitMeta { return nukeMetaReload(name, 5) }

// nukeMetaReload builds a stockpile launcher whose round build interval is
// reloadTicks — a large value keeps the launcher a single-shot for the length
// of an interception test (no rebuild refilling mid-flight).
func nukeMetaReload(name string, reloadTicks int) *UnitMeta {
	m := &UnitMeta{Name: name, MaxHealth: fixed.FromInt(100)}
	m.Weapons[0] = WeaponMeta{
		Name: "nuke", Range: fixed.FromInt(6000), ReloadMs: 200, Burst: 1,
		Damage: fixed.FromInt(500), Present: true, DamageDefault: 500,
		ReloadTicks: reloadTicks, VelocityWU: fixed.FromInt(120), AreaOfEffectWU: fixed.FromInt(64),
		Stockpile: true, Targetable: true,
	}
	return m
}

// interceptorMeta builds a TA anti-nuke: weapon 0 is an interceptor with a
// square coverage box.
func interceptorMeta(name string, coverageWU int) *UnitMeta {
	m := &UnitMeta{Name: name, MaxHealth: fixed.FromInt(100)}
	m.Weapons[0] = WeaponMeta{
		Name: "antinuke", Range: fixed.FromInt(coverageWU), ReloadMs: 200, Burst: 1,
		Damage: fixed.FromInt(10), Present: true, ReloadTicks: 5,
		VelocityWU: fixed.FromInt(400), AreaOfEffectWU: fixed.FromInt(32),
		Interceptor: true, CoverageWU: coverageWU,
	}
	return m
}

// TestStockpileBuildsAndCaps pins the build cadence and 200-round ceiling
// (specials.md §6.1.1): a launcher rolls one round into stock every reload
// interval and saturates at 200.
func TestStockpileBuildsAndCaps(t *testing.T) {
	w := New(Config{Seed: 100})
	nuke := w.AddUnit("nuke", nukeMeta("nuke"), nil, fixed.Vec2{}, 0, 0)
	for i := 0; i < 5; i++ {
		w.Step(nil)
	}
	if got := w.WeaponStock(nuke, 0); got != 1 {
		t.Fatalf("after one 5-tick interval stock=%d, want 1", got)
	}
	for i := 0; i < 5; i++ {
		w.Step(nil)
	}
	if got := w.WeaponStock(nuke, 0); got != 2 {
		t.Fatalf("after two intervals stock=%d, want 2", got)
	}
	w.SetWeaponStock(nuke, 0, 200)
	for i := 0; i < 20; i++ {
		w.Step(nil)
	}
	if got := w.WeaponStock(nuke, 0); got != 200 {
		t.Fatalf("stock exceeded cap: %d", got)
	}
}

// TestNukeLaunchConsumesStock pins the launch/decrement (specials.md §6.1.1):
// a fire order launches a flying projectile and spends one round; an empty
// launcher never fires.
func TestNukeLaunchConsumesStock(t *testing.T) {
	w := New(Config{Seed: 101})
	nuke := w.AddUnit("nuke", nukeMeta("nuke"), nil, fixed.Vec2{}, 0, 0)
	w.SetWeaponStock(nuke, 0, 1)
	w.ApplyOrder(order.FireAtPoint(nuke, 0, fixed.Vec2{X: fixed.FromInt(1500)}))
	launched := false
	for i := 0; i < 20 && !launched; i++ {
		w.Step(nil)
		if len(w.projectiles) > 0 {
			launched = true
		}
	}
	if !launched {
		t.Fatal("stocked launcher never launched a projectile")
	}
	if got := w.WeaponStock(nuke, 0); got != 0 {
		t.Fatalf("launch did not consume stock: %d", got)
	}
}

// TestInterceptorKillsNuke pins the anti-nuke pipeline (specials.md §6.1.2): an
// interceptor holding stock fires at an incoming targetable enemy shot inside
// its square coverage box, spends a round, and detonates the nuke in flight.
func TestInterceptorKillsNuke(t *testing.T) {
	w := New(Config{Seed: 102})
	// A single-shot launcher (huge rebuild interval) fires one nuke down-range;
	// the interceptor sits at x=1000 so the shot flies before entering coverage.
	nuke := w.AddUnit("nuke", nukeMetaReload("nuke", 100000), nil, fixed.Vec2{}, 0, 0)
	inter := w.AddUnit("anti", interceptorMeta("anti", 200), nil, fixed.Vec2{X: fixed.FromInt(1000)}, 1, 1)
	w.SetWeaponStock(nuke, 0, 1)
	w.SetWeaponStock(inter, 0, 1)
	w.ApplyOrder(order.FireAtPoint(nuke, 0, fixed.Vec2{X: fixed.FromInt(5000)}))

	sawFlight := false
	killed := false
	for i := 0; i < 400; i++ {
		w.Step(nil)
		switch {
		case len(w.projectiles) > 0:
			sawFlight = true
		case sawFlight:
			killed = true
		}
		if killed {
			break
		}
	}
	if !sawFlight {
		t.Fatal("nuke never launched / flew")
	}
	if !killed {
		t.Fatal("interceptor never destroyed the incoming nuke")
	}
	if got := w.WeaponStock(inter, 0); got != 0 {
		t.Fatalf("interceptor did not spend a round: stock %d", got)
	}
}

// TestInterceptorIgnoresFriendlyAndUncovered pins the acquisition gates: an
// interceptor never fires at a friendly shot, and never at a shot outside its
// coverage box.
func TestInterceptorIgnoresFriendlyAndUncovered(t *testing.T) {
	// Friendly shot (same side) must be ignored.
	w := New(Config{Seed: 103})
	nuke := w.AddUnit("nuke", nukeMeta("nuke"), nil, fixed.Vec2{}, 0, 0)
	inter := w.AddUnit("anti", interceptorMeta("anti", 400), nil, fixed.Vec2{X: fixed.FromInt(200)}, 0, 0)
	w.SetWeaponStock(nuke, 0, 1)
	w.SetWeaponStock(inter, 0, 1)
	w.ApplyOrder(order.FireAtPoint(nuke, 0, fixed.Vec2{X: fixed.FromInt(1500)}))
	for i := 0; i < 15; i++ {
		w.Step(nil)
	}
	if got := w.WeaponStock(inter, 0); got != 1 {
		t.Fatalf("interceptor fired at a friendly shot: stock %d", got)
	}

	// Enemy shot but interceptor coverage too small to reach it.
	w2 := New(Config{Seed: 104})
	nuke2 := w2.AddUnit("nuke", nukeMeta("nuke"), nil, fixed.Vec2{}, 0, 0)
	inter2 := w2.AddUnit("anti", interceptorMeta("anti", 20), nil, fixed.Vec2{X: fixed.FromInt(2000)}, 1, 1)
	w2.SetWeaponStock(nuke2, 0, 1)
	w2.SetWeaponStock(inter2, 0, 1)
	w2.ApplyOrder(order.FireAtPoint(nuke2, 0, fixed.Vec2{X: fixed.FromInt(1500)}))
	for i := 0; i < 15; i++ {
		w2.Step(nil)
	}
	if got := w2.WeaponStock(inter2, 0); got != 1 {
		t.Fatalf("interceptor fired at an uncovered shot: stock %d", got)
	}
}

// cloakMeta builds a TA cloakable unit: a small per-settle energy drain and an
// optional proximity-decloak radius.
func cloakMeta(name string, cloakCost float32, minCloakDist int) *UnitMeta {
	m := &UnitMeta{
		Name: name, CanMove: true, MaxVelocity: fixed.FromFloat(1.2),
		TurnRate: fixed.FromInt(600), Accel: fixed.FromFloat(0.1), BrakeRate: fixed.FromFloat(0.2),
		MaxHealth: fixed.FromInt(100), CanCloak: true,
		CloakCost: cloakCost, CloakCostMoving: cloakCost, MinCloakDistance: minCloakDist,
	}
	m.Weapons[0] = WeaponMeta{
		Name: "gun", Range: fixed.FromInt(300), ReloadMs: 250, Burst: 1,
		Damage: fixed.FromInt(25), Present: true, DamageDefault: 25, ReloadTicks: 8,
		VelocityWU: fixed.FromInt(400), AreaOfEffectWU: fixed.FromInt(8),
	}
	return m
}

// TestDecloakOnFire pins the fire-break rule (specials.md §5.1): a cloaked TA
// unit is forced visible the moment it fires a weapon.
func TestDecloakOnFire(t *testing.T) {
	w := New(Config{Seed: 110})
	// MinCloakDistance 0 isolates the fire path from proximity.
	shooter := w.AddUnit("shooter", cloakMeta("shooter", 10, 0), nil, fixed.Vec2{}, 0, 0)
	prey := w.AddUnit("prey", cloakMeta("prey", 10, 0), nil, fixed.Vec2{X: fixed.FromInt(250)}, 1, 1)
	w.ApplyOrder(order.Stance([]uint32{prey}, int(MoveHold), int(FireHold)))
	// Hold the shooter's fire so it cloaks (an auto-engagement would decloak it
	// before the settle); a manual FireAtUnit below still fires under Hold Fire.
	w.ApplyOrder(order.Stance([]uint32{shooter}, int(MoveHold), int(FireHold)))
	w.ApplyOrder(order.Cloak([]uint32{shooter}))
	// One settle cloaks it (stationary, energy on hand).
	for i := 0; i < 35; i++ {
		w.Step(nil)
	}
	if !w.Cloaked(shooter) {
		t.Fatal("stationary cloaker never cloaked after a settle")
	}
	// Fire and it must decloak.
	w.ApplyOrder(order.FireAtUnit(shooter, 0, prey))
	decloaked := false
	for i := 0; i < 30 && !decloaked; i++ {
		w.Step(nil)
		if !w.Cloaked(shooter) {
			decloaked = true
		}
	}
	if !decloaked {
		t.Fatal("cloaked unit stayed cloaked through firing")
	}
}

// TestDecloakOnProximity pins the proximity-break rule (specials.md §5.1): a
// cloak-stanced TA unit cannot hold cloak while an enemy is within its
// mincloakdistance, but cloaks freely when the enemy is beyond it.
func TestDecloakOnProximity(t *testing.T) {
	// Enemy inside mincloakdistance (50 < 100): the unit never holds cloak.
	w := New(Config{Seed: 111})
	spy := w.AddUnit("spy", cloakMeta("spy", 10, 100), nil, fixed.Vec2{}, 0, 0)
	near := w.AddUnit("near", cloakMeta("near", 10, 0), nil, fixed.Vec2{X: fixed.FromInt(50)}, 1, 1)
	w.ApplyOrder(order.Stance([]uint32{spy}, int(MoveHold), int(FireHold)))
	w.ApplyOrder(order.Stance([]uint32{near}, int(MoveHold), int(FireHold)))
	w.ApplyOrder(order.Cloak([]uint32{spy}))
	for i := 0; i < 60; i++ {
		w.Step(nil)
		if w.Cloaked(spy) {
			t.Fatalf("unit cloaked with an enemy inside mincloakdistance (tick %d)", i)
		}
	}

	// Enemy beyond mincloakdistance (500 > 100): the unit cloaks normally.
	w2 := New(Config{Seed: 112})
	spy2 := w2.AddUnit("spy", cloakMeta("spy", 10, 100), nil, fixed.Vec2{}, 0, 0)
	far := w2.AddUnit("far", cloakMeta("far", 10, 0), nil, fixed.Vec2{X: fixed.FromInt(500)}, 1, 1)
	w2.ApplyOrder(order.Stance([]uint32{spy2}, int(MoveHold), int(FireHold)))
	w2.ApplyOrder(order.Stance([]uint32{far}, int(MoveHold), int(FireHold)))
	w2.ApplyOrder(order.Cloak([]uint32{spy2}))
	for i := 0; i < 35; i++ {
		w2.Step(nil)
	}
	if !w2.Cloaked(spy2) {
		t.Fatal("unit failed to cloak with the only enemy beyond mincloakdistance")
	}
}
