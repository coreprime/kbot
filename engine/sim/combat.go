package sim

import (
	"math"

	"github.com/coreprime/kbot/engine/fixed"
)

// Combat damage resolution — the shared detonation math both engines run when
// a shot lands, transplanted onto the sandbox's substrate:
//
//   - base damage from the per-target [DAMAGE] table (TA: absolute override
//     keyed by victim objectname; TA:K: fractional multiplier of the default
//     keyed by victim damagecategory),
//   - the shared quadratic splash falloff e + (1−e)(1 − d/r)² against the
//     distance from the blast point to the victim's bounding box,
//   - the areaofeffect < 17 single-target shortcut,
//   - attacker/defender veterancy scaling (TA: ±% ladders off the kill
//     counter; TA:K: ×vet / ÷vet multipliers off experience level),
//   - truncation toward zero at each stage the engines truncate.

// splashSingleTargetWU: detonations whose areaofeffect is below this run the
// single-victim path (full damage to the direct hit, nothing else) instead of
// the area scan — both engines share the threshold.
const splashSingleTargetWU = 17

// taVetLevel is the TA veterancy level for the damage/defense/reload ladders:
// kills/5, capped at 5.
func taVetLevel(u *Unit) int {
	if u == nil {
		return 0
	}
	l := u.kills / 5
	if l > 5 {
		l = 5
	}
	return l
}

// takVetMul is the TA:K veteran multiplier 1.0 + 0.1·level, where level =
// xp / own experiencepoints (integer division), capped at 10. Units with no
// experiencepoints figure never level.
func takVetMul(u *Unit) float64 {
	return 1.0 + 0.1*float64(takLevel(u))
}

// baseTableDamage resolves the weapon's [DAMAGE] figure against one victim.
// TA: a per-objectname entry REPLACES the default outright. TA:K: a
// per-damagecategory entry MULTIPLIES the default (fractional retail values).
// Weapons that never went through the combat enrichment fall back to the
// legacy flat Damage figure.
func baseTableDamage(wm *WeaponMeta, victim *UnitMeta) float64 {
	if wm.DamageMult != nil {
		base := float64(wm.DamageDefault)
		if victim != nil && victim.DamageCategory != "" {
			if mul, ok := wm.DamageMult[victim.DamageCategory]; ok {
				base *= mul
			}
		}
		return base
	}
	if victim != nil && victim.ObjectName != "" {
		if v, ok := wm.DamageTable[victim.ObjectName]; ok {
			return float64(v)
		}
	}
	if wm.DamageDefault > 0 {
		return float64(wm.DamageDefault)
	}
	// Legacy path: metas built without enrichment carry only the flat figure.
	return wm.Damage.Float()
}

// blastAABBDist is the splash distance metric: per-axis gap from the blast
// point to the victim's box (see UnitMeta.aabbHalf), then Euclidean length,
// truncated to whole world units the way the engines shift the 16.16 length
// down before the float divide.
func blastAABBDist(blast fixed.Vec3, t *Unit) int {
	hx, hy, hz := t.Meta.aabbHalf()
	p := t.Pos()
	gap := func(d, h fixed.Fixed) float64 {
		if d < 0 {
			d = -d
		}
		d -= h
		if d < 0 {
			return 0
		}
		return d.Float()
	}
	gx := gap(blast.X-p.X, hx)
	gy := gap(blast.Y-p.Y, hy)
	gz := gap(blast.Z-p.Z, hz)
	return int(math.Sqrt(gx*gx + gy*gy + gz*gz))
}

// splashWeight is the shared falloff: 1.0 when the blast touches the box,
// e + (1−e)(1 − d/r)² between there and the rim.
func splashWeight(d, r int, edge float64) float64 {
	if d <= 0 {
		return 1.0
	}
	t := float64(d)/float64(r) - 1.0
	return (1.0-edge)*t*t + edge
}

// weaponDamagePoints runs the full per-victim pipeline and returns whole
// damage points (≥ 0). weight is the splash falloff multiplier (1.0 for
// direct hits).
func weaponDamagePoints(wm *WeaponMeta, attacker, victim *Unit, weight float64) int {
	var victimMeta *UnitMeta
	if victim != nil {
		victimMeta = victim.Meta
	}
	base := baseTableDamage(wm, victimMeta)
	if wm.DamageMult != nil {
		// TA:K: one float chain — table × falloff × attacker vet ÷ defender
		// vet — truncated once at the end. The engines' CRT-rand damage
		// jitter is omitted: its half-range is an unresolved constant, and
		// the sandbox favours a derivable zero-jitter reading over guessing
		// a width (revisit when the magnitude is pinned).
		dmg := base * weight * takVetMul(attacker)
		if dv := takVetMul(victim); dv > 0 {
			dmg /= dv
		}
		if dmg <= 0 {
			return 0
		}
		return int(dmg)
	}
	// TA: truncate the falloff product first (the engines' ftol), then the
	// two integer veterancy ladders in attacker-then-defender order.
	dmg := int(base * weight)
	dmg = dmg * (100 + 6*taVetLevel(attacker)) / 100
	dmg = dmg * (25 - taVetLevel(victim)) * 4 / 100
	if dmg < 0 {
		return 0
	}
	return dmg
}

// applyWeaponHit routes one victim's resolved damage into the world, carrying
// the attacker attribution that feeds kill credit. Special weapon classes
// divert off the HP-damage path: a paralyzer accumulates a stun tick count on
// the victim's Paralyze order (specials.md §7.2), and a mind-control weapon
// rolls the veterancy-scaled stick chance and, on success, queues an ownership
// conversion under the attacker (specials.md §2.2).
func (w *World) applyWeaponHit(attackerID uint32, wm *WeaponMeta, victim *Unit, weight float64) {
	attacker := w.units[attackerID]
	pts := weaponDamagePoints(wm, attacker, victim, weight)
	if wm.Paralyzer {
		if pts > 0 {
			w.applyParalyze(victim, pts)
		}
		return
	}
	if wm.MindControl {
		w.tryMindControl(attacker, victim, weight)
		return
	}
	if pts <= 0 {
		return
	}
	w.ApplyDamage(attackerID, victim.ID, fixed.FromInt(pts))
}

// detonateWeapon applies a landed shot's damage: the sub-17 wu single-target
// shortcut against the direct-hit victim, or the area scan with quadratic
// falloff, bounding-box distance, and the per-game shooter rule (TA excludes
// the firing unit from its own blast; TA:K does not).
func (w *World) detonateWeapon(ownerID, directHitID uint32, wm *WeaponMeta, blast fixed.Vec3) {
	aoe := wm.AreaOfEffectWU.Int()
	if aoe < splashSingleTargetWU {
		if directHitID == 0 {
			return
		}
		if t := w.units[directHitID]; t != nil && !t.Dead && t.carriedBy == 0 {
			w.applyWeaponHit(ownerID, wm, t, 1.0)
		}
		return
	}
	r := aoe / 2
	for _, id := range w.order {
		t := w.units[id]
		if t == nil || t.Dead || t.carriedBy != 0 || t.Meta == nil {
			continue
		}
		if !wm.SelfSplash && t.ID == ownerID {
			continue
		}
		d := blastAABBDist(blast, t)
		if d > r {
			continue
		}
		w.applyWeaponHit(ownerID, wm, t, splashWeight(d, r, wm.EdgeEffectiveness))
	}
}

// solveBallisticLaunch runs the closed-form launch-elevation solve for an
// unpowered gravity-arc shot: given horizontal distance h, height drop dy
// (shooter minus target), muzzle speed v and gravity g (any consistent
// units), it returns the low arc's (horizontalSpeed, verticalSpeed) as
// fractions scaled to v, and ok=false when no arc reaches — which doubles as
// the ballistic fire gate, exactly as the engines treat an unsolvable arc as
// out of range. Where both arcs solve, the LOW arc is taken: the sibling
// engine provably prefers it and the shared low-arc reading is the sandbox's
// documented resolution of the open root-preference question.
//
// Derivation: with r = (v·cosθ)², the intercept condition reduces to
// D = h⁴·(v⁴ + 2·g·dy·v² − g²·h²); roots r± = ((g·dy + v²)·h² ± √D) /
// (2·(dy² + h²)); the +√D root is the flatter (low) arc. cosθ = √r/v.
// Arc acceptance: sinθ must clear sin(minbarrelangle).
func solveBallisticLaunch(h, dy, v, g, minBarrelSin float64) (vh, vy float64, ok bool) {
	if h <= 0 || v <= 0 || g <= 0 {
		return 0, 0, false
	}
	v2 := v * v
	h2 := h * h
	disc := h2 * h2 * (v2*v2 + 2*g*dy*v2 - g*g*h2)
	if disc < 0 {
		return 0, 0, false
	}
	r := ((g*dy+v2)*h2 + math.Sqrt(disc)) / (2 * (dy*dy + h2))
	if r < 0 || r > v2 {
		return 0, 0, false
	}
	vh = math.Sqrt(r)
	vy = math.Sqrt(v2 - r)
	if vy/v < minBarrelSin {
		return 0, 0, false
	}
	return vh, vy, true
}

// scaledReloadTicks is the reload counter the slot reloads to after a shot:
// the parsed tick count scaled by the attacker's veterancy discount
// (−6 %/level, up to −30 %) and its damage-state penalty (up to +20 % at zero
// health), both integer-truncated in the engines' order. The TA:K reload
// jitter (a CRT-rand uniform of unresolved half-range) is deliberately
// omitted — the sandbox takes the derivable zero-jitter reading until the
// width is pinned.
func scaledReloadTicks(u *Unit, wm *WeaponMeta) int {
	base := wm.ReloadTicks
	if base <= 0 {
		// Metas built without enrichment: derive from the millisecond figure.
		base = wm.ReloadMs * TickHz / 1000
		if base <= 0 {
			base = 22 // legacy 750 ms fallback on the tick axis
		}
	}
	hpNum, hpDen := unitHPRatio(u)
	rl := (100 - 6*taVetLevel(u)) * base / 100
	rl = rl * (120 - 20*hpNum/hpDen) / 100
	if rl < 0 {
		rl = 0
	}
	return rl
}

// unitHPRatio returns the unit's hit points as an integer pair (hp, maxhp) on
// the FBI maxdamage scale, for the integer-division ladders. Units without a
// maxdamage figure report their percent bar over 100.
func unitHPRatio(u *Unit) (hp, maxhp int) {
	if u == nil {
		return 1, 1
	}
	if u.Meta != nil && u.Meta.MaxHealth > 0 {
		maxhp = u.Meta.MaxHealth.Int()
		hp = u.Health.Mul(u.Meta.MaxHealth).Div(fixed.FromInt(100)).Int()
	} else {
		maxhp = 100
		hp = u.Health.Int()
	}
	if maxhp <= 0 {
		maxhp = 1
	}
	if hp < 0 {
		hp = 0
	}
	if hp > maxhp {
		hp = maxhp
	}
	return hp, maxhp
}

// turretSpread is the accuracy-path spread bound for one turret shot:
// accuracy + 0x800 − (hp<<11)/maxhp — at full health the base cancels
// exactly, so a healthy accuracy-0 weapon shoots true and draws nothing —
// then divided by kills/12 once that quotient reaches 2 (the uncapped
// veteran accuracy consumer).
func turretSpread(u *Unit, wm *WeaponMeta) int32 {
	hp, maxhp := unitHPRatio(u)
	spread := int(wm.Accuracy) + 0x800 - (hp<<11)/maxhp
	if u != nil {
		if v := u.kills / 12; v >= 2 {
			spread /= v
		}
	}
	if spread < 0 {
		spread = 0
	}
	return int32(spread)
}
