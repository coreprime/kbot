package sim

import "github.com/coreprime/kbot/engine/fixed"

// Motion conventions — the per-engine dialect of the shared movement
// skeleton, resolved per unit from what its COB exports, the same data-driven
// discrimination weapon_convention.go uses. Both engines run the identical
// bang-bang integrator; the dialects differ in the turn-rate scale, the
// slope-cap arithmetic, the underwater rule, and the walk-animation contract
// (locomotion spec §1.4, §2, §3.4, §7).

// motionConvention is the strategy for one engine's movement dialect. Both
// implementations are stateless singletons.
type motionConvention interface {
	// turnPerFrame is the applied per-frame turn clamp for an FBI turnrate,
	// after the dialect's scale and (TA:K) the in-water stat multiplier.
	turnPerFrame(tr int32, scale fixed.Fixed) int32
	// scaleStat filters a kinematic stat through the dialect's per-unit
	// multiplier (TA:K watermultiplier; identity for TA).
	scaleStat(v, scale fixed.Fixed) fixed.Fixed
	// slopeCap is the pitch-band speed cap in the dialect's exact op order.
	slopeCap(maxv fixed.Fixed, pitch int32) fixed.Fixed
	// underwaterHalves reports whether the fixed ×0.5 underwater cap applies
	// (TA only; canhover|floater exempt — amphibious does NOT).
	underwaterHalves(m *UnitMeta) bool
	// announceTier fires the dialect's walk-contract script calls on a
	// walk-anim tier change (§7).
	announceTier(b Binding, prev, tier int)
	// announceTurn fires the dialect's turn notification (TA:K
	// TurnDirection) on a turn start/stop/sign flip.
	announceTurn(u *Unit)
	// announceFlight fires the dialect's aircraft takeoff/landing pose script
	// on the grounded↔airborne edge: takeoff (airborne=true) opens the flight
	// pose — a TA fighter parts its wings — and landing folds it. The engine
	// drives this off the move-state byte flipping to/from airborne (2), which
	// this edge stands in for.
	announceFlight(b Binding, airborne bool)
}

// motionDialect caches a unit's resolved convention (0 = unresolved).
type motionDialect uint8

const (
	motionUnresolved motionDialect = iota
	motionTA
	motionTAK
)

// motionConvention resolves (and caches) the unit's movement dialect from its
// COB exports: the shared parameterised AimWeapon (the weapon-convention
// discriminator), the engine-called TurnDirection, or the parameterised
// MoveRate — all TA:K-only entry points; no retail TA COB ships any of them.
// Script-less units take the TA dialect.
func (u *Unit) motionConvention() motionConvention {
	if u.motionDialect == motionUnresolved {
		u.motionDialect = motionTA
		if b := u.binding; b != nil &&
			(b.HasScript("AimWeapon") || b.HasScript("TurnDirection") || b.HasScript("MoveRate")) {
			u.motionDialect = motionTAK
		}
	}
	if u.motionDialect == motionTAK {
		return takMotion{}
	}
	return taMotion{}
}

// takStatScale is the TA:K per-unit stat multiplier for the unit's current
// footing: the FBI watermultiplier while it stands in water, the
// roadmultiplier once a road raster exists (world block), 1.0 on dry ground.
// The decompile shows every kinematic stat read filtered through this
// multiply, but the exact operand pairing is UNKNOWN-6 — this implements the
// believed reading. TA units ignore it (scaleStat is identity there).
func (w *World) takStatScale(u *Unit) fixed.Fixed {
	if u.Meta == nil || u.Meta.IsAircraft {
		return fixed.One
	}
	if w.unitUnderwater(u) {
		return u.Meta.waterMult()
	}
	return fixed.One
}

// ── TA dialect ──────────────────────────────────────────────────────

type taMotion struct{}

// turnPerFrame: the raw FBI turnrate is the per-frame clamp.
func (taMotion) turnPerFrame(tr int32, _ fixed.Fixed) int32 { return tr }

func (taMotion) scaleStat(v, _ fixed.Fixed) fixed.Fixed { return v }

// slopeCap: cap = maxvelocity · pct / 100 as one 64-bit multiply-divide.
func (taMotion) slopeCap(maxv fixed.Fixed, pitch int32) fixed.Fixed {
	pct := SlopeSpeedFactor(pitch)
	return fixed.Wrap32(fixed.Fixed((int64(maxv) * int64(pct)) / 100))
}

// underwaterHalves: TA halves the cap underwater unless the unit carries the
// canhover or floater flag; amphibious units are NOT exempt.
func (taMotion) underwaterHalves(m *UnitMeta) bool {
	return !m.CanHover && !m.Floater
}

// announceTier: transition-edged StartMoving/StopMoving plus MoveRate1/2/3
// while moving (§7.1). Stock units default both thresholds to 2×maxvelocity
// and never leave tier 1.
func (taMotion) announceTier(b Binding, prev, tier int) {
	if b == nil {
		return
	}
	if tier == 0 {
		if b.HasScript("StopMoving") {
			b.Start("StopMoving")
		}
		return
	}
	if prev == 0 && b.HasScript("StartMoving") {
		b.Start("StartMoving")
	}
	name := [4]string{"", "MoveRate1", "MoveRate2", "MoveRate3"}[tier]
	if b.HasScript(name) {
		b.Start(name)
	}
}

// announceTurn: TA has no turn notification.
func (taMotion) announceTurn(*Unit) {}

// announceFlight: a TA aircraft's takeoff runs Activate — the activatescr
// door/wing sequence that swings the fighter's wings out to flight pose — and
// its landing runs Deactivate to fold them back. Aircraft carry these scripts
// for exactly this pose change (no factory doors), so the shared activation
// scripts double as the flight pose without a dedicated takeoff export.
func (taMotion) announceFlight(b Binding, airborne bool) {
	if b == nil {
		return
	}
	name := "Deactivate"
	if airborne {
		name = "Activate"
	}
	if b.HasScript(name) {
		b.Start(name)
	}
}

// ── TA:K dialect ────────────────────────────────────────────────────

type takMotion struct{}

// turnPerFrame: the applied per-frame turn is turnrate >> 3, then the
// in-water stat multiplier. UNKNOWN-14 seam: the decompiled C of the turn
// clamp shows the RAW turnrate on the dry-ground path, while the substrate
// pass's read of the authoritative asm reports an effective >>3 per tick —
// and TA:K FBI turn rates run ~5× TA's for comparable units, which fits the
// >>3 reading (swordsman 2500>>3 = 312 ≈ TA-like handling; raw 2500 would be
// a half-second about-face). The asm reading is implemented; if the shift
// turns out to live only in a downstream consumer, drop the >>3 here.
func (takMotion) turnPerFrame(tr int32, scale fixed.Fixed) int32 {
	t := tr >> 3
	if scale != fixed.One {
		t = int32((int64(t) * int64(scale)) >> 16)
	}
	return t
}

// scaleStat: every kinematic stat read is filtered through the per-unit
// water/road multiplier (§1.4-1, UNKNOWN-6).
func (takMotion) scaleStat(v, scale fixed.Fixed) fixed.Fixed {
	if scale == fixed.One {
		return v
	}
	return fixed.Wrap32(fixed.Fixed((int64(v) * int64(scale)) >> 16))
}

// slopeCap: TA:K converts the percent to a 16.16 factor through a ×0.01
// float multiply with truncation, then applies it as (factor × maxspeed)>>16
// — a slightly different rounding than TA's /100 (takSlopeFactor pins the
// truncated factors).
func (takMotion) slopeCap(maxv fixed.Fixed, pitch int32) fixed.Fixed {
	f := takSlopeFactor(pitch)
	return fixed.Wrap32(fixed.Fixed((int64(maxv) * int64(f)) >> 16))
}

// underwaterHalves: TA:K has no fixed underwater ×0.5 — water speed comes
// from the per-unit watermultiplier via the stat scale.
func (takMotion) underwaterHalves(*UnitMeta) bool { return false }

// announceTier: one parameterised MoveRate(tier) call on change (§7.2); TA:K
// has no StartMoving/StopMoving — the scripts' MoveWatcher loop derives
// walking from CURRENT_SPEED and the TurnDirection flag.
func (takMotion) announceTier(b Binding, _, tier int) {
	if b != nil && b.HasScript("MoveRate") {
		b.Start("MoveRate", tier)
	}
}

// announceTurn: TurnDirection(turn/0xb6) — the argument is degrees per frame
// (0xb6 = 182 angle units per degree) — whenever turning starts, stops, or
// flips sign. The scripts' MoveWatcher ORs the value into its walk gate, so
// TA:K walkers animate while pivoting in place.
func (takMotion) announceTurn(u *Unit) {
	s := int8(0)
	if u.loco.Turn > 0 {
		s = 1
	} else if u.loco.Turn < 0 {
		s = -1
	}
	if s == u.lastTurnSign {
		return
	}
	u.lastTurnSign = s
	if u.binding != nil && u.binding.HasScript("TurnDirection") {
		u.binding.Start("TurnDirection", int(u.loco.Turn)/0xb6)
	}
}

// announceFlight: TA:K fliers announce takeoff via BeginFlight and mark the
// unit airborne through setSFXoccupy(5) — the state a dragon's FlightControl
// loop gates its wing-flap cycle on — and reverse both on landing (BeginLanding
// + the grounded occupation state) so the flap loop folds the wings.
func (takMotion) announceFlight(b Binding, airborne bool) {
	if b == nil {
		return
	}
	seq, occ := "BeginLanding", takOccupyLand
	if airborne {
		seq, occ = "BeginFlight", takOccupyAir
	}
	if b.HasScript(seq) {
		b.Start(seq)
	}
	if b.HasScript("setSFXoccupy") {
		b.Start("setSFXoccupy", occ)
	}
}
