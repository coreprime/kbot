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
