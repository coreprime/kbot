package games

import (
	"math"
	"strings"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/gamedata/tak"
	"github.com/coreprime/kbot/formats/tdf"
)

// EnrichCombatMeta fills the exact-combat fields on an already-built stat
// block: per-target [DAMAGE] tables, firing-cycle conversions (tick-domain
// reload/burst figures, spray/accuracy angles), the TA:K behavior-class
// flags, veterancy identity keys, and the death-blast weapons. It re-reads
// the same FBI bytes UnitMetaFromFBI parsed, so callers layer it on without
// disturbing the base pipeline.
func EnrichCombatMeta(m *sim.UnitMeta, fbi []byte, resolve WeaponResolver) {
	if m == nil {
		return
	}
	var u ta.Unit
	if err := tdf.Unmarshal(fbi, &u); err == nil {
		enrichTA(m, &u.Info, resolve)
	}
	var ku tak.Unit
	if err := tdf.Unmarshal(fbi, &ku); err == nil {
		enrichTAK(m, &ku)
	}
}

// tickTrunc converts a seconds figure to whole 30 Hz ticks the way the
// engines do at parse: the value is a single-precision float, multiplied by
// 30, truncated toward zero (so 1.9 s → 56 ticks, not 57 — the float32
// representation of 1.9 sits just under it).
func tickTrunc(seconds float64) int {
	return int(float32(seconds) * 30)
}

// foldDamageTable splits a [DAMAGE] map into the case-folded default and the
// per-target table with lower-cased keys (retail files mix key casing;
// duplicate case variants resolve to the smallest original key so the result
// never depends on map iteration order). The default key itself never enters
// the table.
func foldDamageTable[V int | float64](damage map[string]V) (def V, table map[string]V) {
	var defKey string
	keyFor := map[string]string{}
	for k, v := range damage {
		lk := strings.ToLower(k)
		if lk == "default" {
			if defKey == "" || k < defKey {
				defKey, def = k, v
			}
			continue
		}
		if prev, ok := keyFor[lk]; ok && prev < k {
			continue
		}
		if table == nil {
			table = map[string]V{}
		}
		keyFor[lk] = k
		table[lk] = v
	}
	return def, table
}

// minBarrelSin converts the TDF minbarrelangle (degrees) to the sine the arc
// solver gates on, applying the engines' −11.25° default when the field is
// absent.
func minBarrelSin(deg float64) float64 {
	if deg == 0 {
		deg = -11.25
	}
	return math.Sin(deg * math.Pi / 180)
}

func enrichTA(m *sim.UnitMeta, info *ta.UnitInfo, resolve WeaponResolver) {
	obj := strings.TrimSpace(info.ObjectName)
	if obj == "" {
		obj = strings.TrimSpace(info.UnitName)
	}
	if obj == "" {
		obj = m.Name
	}
	m.ObjectName = strings.ToLower(obj)
	// Splash bounding box from the unit's OWN FBI footprint (the movement
	// class may later replace the locomotion footprint with a larger one,
	// which must not inflate the body splash measures distance to). TA:K
	// units typically declare no footprint at all and present a point.
	m.CombatBoxSet = true
	m.CombatBoxHalfX = fixed.FromInt(info.FootprintX * 4)
	m.CombatBoxHalfZ = fixed.FromInt(info.FootprintZ * 4)
	if resolve == nil {
		return
	}
	// Death blasts: explodeas (ordinary death) and selfdestructas (Ctrl+D)
	// resolve to real weapon sections; their default damage, areaofeffect
	// and edge drive the shared splash math.
	m.Explode = blastFromRef(info.ExplodeAs, resolve)
	m.SelfD = blastFromRef(info.SelfDestructAs, resolve)
	for i, ref := range []string{info.Weapon1, info.Weapon2, info.Weapon3} {
		wm := &m.Weapons[i]
		if !wm.Present {
			continue
		}
		key := strings.ToUpper(strings.TrimSpace(ref))
		sec, ok := resolve(key)
		if !ok {
			continue
		}
		def, table := foldDamageTable(sec.Damage)
		wm.DamageDefault = def
		wm.DamageTable = table
		wm.EdgeEffectiveness = sec.EdgeEffectiveness
		wm.ReloadTicks = tickTrunc(sec.ReloadTime)
		wm.BurstRateTicks = tickTrunc(sec.BurstRate)
		wm.RandomDecayTicks = tickTrunc(sec.RandomDecay)
		wm.SprayAngle = int32(sec.SprayAngle)
		wm.Accuracy = int32(sec.Accuracy)
		wm.Turret = sec.Turret != 0
		wm.CommandFire = sec.CommandFire != 0
		wm.NoExplode = sec.NoExplode != 0
		wm.EnergyShot = fixed.FromFloat(sec.EnergyPerShot)
		wm.MetalShot = fixed.FromInt(sec.MetalPerShot)
		wm.MinBarrelSin = minBarrelSin(sec.MinBarrelAngle)
		// TA weapons never splash their own shooter.
		wm.SelfSplash = false
		// Stockpile / anti-nuke (specials.md §6.1): coverage is the raw wu
		// square-box half-extent; interceptor/targetable/stockpile are flags.
		wm.Stockpile = sec.Stockpile != 0
		wm.Targetable = sec.Targetable != 0
		wm.Interceptor = sec.Interceptor != 0
		wm.CoverageWU = sec.Coverage
		wm.Paralyzer = sec.Paralyzer != 0
	}
}

func enrichTAK(m *sim.UnitMeta, ku *tak.Unit) {
	if cat := strings.TrimSpace(ku.Info.DamageCategory); cat != "" {
		m.DamageCategory = strings.ToLower(cat)
	}
	if ku.Info.ExperiencePoints > 0 {
		m.ExperiencePoints = ku.Info.ExperiencePoints
	} else if hasTAKWeapon(ku) || m.DamageCategory != "" {
		// The engine's parse default for TA:K units — the level divisor a
		// unit without an explicit figure still carries.
		m.ExperiencePoints = 666
	}
	if ku.ExplodeAs != nil {
		def, _ := foldDamageTable(ku.ExplodeAs.Damage)
		m.Explode = sim.Blast{
			Damage: fixed.FromInt(int(def)),
			AoE:    fixed.FromInt(ku.ExplodeAs.AreaOfEffect),
			Edge:   fixed.FromFloat(ku.ExplodeAs.EdgeEffectiveness),
		}
	}
	for i, sec := range []*tak.Weapon{ku.Weapon1, ku.Weapon2, ku.Weapon3} {
		wm := &m.Weapons[i]
		if sec == nil || !wm.Present {
			continue
		}
		def, table := foldDamageTable(sec.Damage)
		wm.DamageDefault = int(def)
		if table != nil {
			wm.DamageMult = table
		}
		wm.EdgeEffectiveness = sec.EdgeEffectiveness
		wm.ReloadTicks = tickTrunc(sec.ReloadTime)
		wm.MinBarrelSin = minBarrelSin(0)
		// TA:K applies a shooter's own splash to the shooter — no exclusion.
		wm.SelfSplash = true
		// Spell weapons consume the firer's unit-private mana (§7.1); the
		// figure is veteran-discounted at consume time.
		wm.ManaPerShot = sec.ManaPerShot
		switch strings.ToLower(strings.TrimSpace(sec.Type)) {
		case "melee":
			// Instant contact behavior: no projectile entity, damage
			// resolves through the detonation path at the swing's contact
			// frame, paced by the shared-stream swing gate.
			wm.Instant = true
			wm.Melee = true
		case "line of sight", "remote effect":
			// Effect-emitter classes: no flight, resolve at the aim point.
			wm.Instant = true
		}
		// Spell subtypes: mindcontrol/turntostone/turntofrozen share the
		// per-hit conversion stick-chance roll (§2.2); paralyzer stuns.
		switch strings.ToLower(strings.TrimSpace(sec.SubType)) {
		case "mindcontrol", "turntostone", "turntofrozen":
			wm.MindControl = true
		case "paralyze", "paralyzer":
			wm.Paralyzer = true
		}
	}
}

func hasTAKWeapon(ku *tak.Unit) bool {
	return ku.Weapon1 != nil || ku.Weapon2 != nil || ku.Weapon3 != nil
}

// blastFromRef resolves a death-blast weapon reference into its splash stat
// block; an empty / unknown ref yields a zero (visual-only) blast.
func blastFromRef(ref string, resolve WeaponResolver) sim.Blast {
	key := strings.ToUpper(strings.TrimSpace(ref))
	if key == "" || key == "NONE" {
		return sim.Blast{}
	}
	sec, ok := resolve(key)
	if !ok {
		return sim.Blast{}
	}
	def, _ := foldDamageTable(sec.Damage)
	return sim.Blast{
		Damage: fixed.FromInt(def),
		AoE:    fixed.FromInt(sec.AreaOfEffect),
		Edge:   fixed.FromFloat(sec.EdgeEffectiveness),
	}
}
