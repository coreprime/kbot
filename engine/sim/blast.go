package sim

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
)

// Death blasts and self-destruct.
//
// Every unit death detonates its FBI explodeas weapon: splash damage to
// everything inside the blast radius, scaled by the weapon's
// edgeeffectiveness falloff. Ctrl+D arms a 5-second self-destruct that
// detonates the (usually far bigger) selfdestructas weapon instead — the
// classic commander send-off. Chains are natural: a splash kill detonates
// the victim's own blast in turn, bounded by every unit dying at most once.

// selfDestructCountdownMs is TA's fixed 5-second fuse.
const selfDestructCountdownMs int64 = 5000

// stepSelfDestruct fires an armed fuse when its time arrives.
func (w *World) stepSelfDestruct(u *Unit) {
	if u.selfDAtMs == 0 || w.simMs < u.selfDAtMs {
		return
	}
	u.selfDAtMs = 0
	w.killUnit(u, 100, u.Meta.SelfD)
}

// detonateBlast deals one death-blast's splash through the shared detonation
// math: quadratic falloff e + (1−e)(1 − d/r)² against bounding-box distance,
// whole-point truncation, and the sub-17 wu single-target rule (a death blast
// has no direct-hit victim, so a tiny areaofeffect damages nothing). The
// dying unit is already dead and takes nothing; everyone else — allies
// included — takes full splash, exactly like a live detonation.
// Deterministic: stable insertion order, no rng.
func (w *World) detonateBlast(src *Unit, b Blast) {
	anchor := src.Pos()
	w.emit(frame.Event{Kind: frame.EvBlast, UnitID: src.ID, Anchor: anchor, SfxType: b.AoE.Int()})
	if b.Damage <= 0 || b.AoE <= 0 {
		return
	}
	aoe := b.AoE.Int()
	if aoe < splashSingleTargetWU {
		return
	}
	r := aoe / 2
	edge := fixed.Clamp(b.Edge, 0, fixed.One).Float()
	base := b.Damage.Float()
	for _, id := range w.order {
		t := w.units[id]
		if t == nil || t.Dead || t == src || t.carriedBy != 0 || t.Meta == nil {
			continue
		}
		d := blastAABBDist(anchor, t)
		if d > r {
			continue
		}
		if pts := int(base * splashWeight(d, r, edge)); pts > 0 {
			w.ApplyDamage(src.ID, id, fixed.FromInt(pts))
		}
	}
}

// killUnit runs the full death sequence — Killed/Dying scripts, corpse
// bookkeeping, death event — then detonates the given blast. ApplyDamage
// routes lethal hits here with the unit's explodeas; self-destruct passes
// selfdestructas.
func (w *World) killUnit(t *Unit, severity int, b Blast) {
	if t.Dead {
		return
	}
	t.Health = 0
	t.Dead = true
	if t.binding != nil && t.binding.HasScript("Killed") {
		if ab, ok := t.binding.(aimBinding); ok {
			t.killedThread = ab.StartAim("Killed", severity, 0, 0)
			t.corpsePending = true
		} else {
			t.binding.Start("Killed", severity, 0, 0)
			w.emitCorpse(t, 1)
		}
	} else {
		w.emitCorpse(t, 1)
	}
	t.diedAtMs = w.simMs
	if t.binding != nil && t.binding.HasScript("Dying") {
		t.dyingPending = true
		t.binding.Start("Dying", 0)
	}
	anchor := t.Pos()
	anchor.Y += fixed.FromInt(18)
	w.emit(frame.Event{Kind: frame.EvDeath, UnitID: t.ID, Anchor: anchor})
	if t.Meta != nil {
		w.detonateBlast(t, b)
	}
}
