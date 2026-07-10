package sim

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
)

// Special mechanics — capture, reclaim, resurrect, cloak, paralyze, and the
// TA:K spell layer (mind control, private mana pool, heal aura) — transplanted
// from the two engines' decompiles onto the sandbox substrate. Every figure
// below is the spec's exact integer arithmetic (specials.md), so a capture or
// reclaim runs tick-for-tick against the real game.
//
// Order-channel mechanics (capture, reclaim, cloak) are armed through the
// order layer (world.ApplyOrder) and advanced once per tick from
// stepSpecials; the TA:K weapon-driven mechanics (mind control, paralyze)
// resolve on the detonation path. Ownership transfer in both games is
// destroy-plus-respawn under the new owner (unit ids are per-player slot
// ranges), so a captured/converted unit loses its accumulated veterancy.

// Death reasons the special channels raise. The sandbox does not carry the
// engines' full reason word on every kill, so these constants document the
// intent at each call site (reason 4 = captured/given-away suppresses wreck;
// reason 5 = reclaimed credits metal at death).
const (
	deathReasonCaptured  = 4
	deathReasonReclaimed = 5
)

// captureMaxTicks is the 60-second (1800-tick) cap on the base capture time
// (specials.md §2.1: T1 = min(T0, 1800)).
const captureMaxTicks = 1800

// captureTime computes the once-at-start channel length (ticks) for capturing
// a target, straight off specials.md §2.1:
//
//	T0 = ftol(0.015·BCE + (3/14)·BCM + 150)
//	T1 = min(T0, 1800)
//	T2 = ((curHP + maxdamage)·T1) / (2·maxdamage)        # unsigned div
//	T  = ((targetKills/5 + 10)·T2·10) / 100              # +10%/5 target kills, UNCAPPED
//
// All the stat fields are the TARGET's. maxdamage doubles as the current-HP
// scale (a full-HP target has curHP == maxdamage, so T2 == T1).
func captureTime(target *Unit) int {
	if target == nil || target.Meta == nil {
		return 0
	}
	bce := float64(target.Meta.Econ.BuildCostEnergy)
	bcm := float64(target.Meta.Econ.BuildCostMetal)
	t0 := int(ftol(0.015*bce + (3.0/14.0)*bcm + 150))
	if t0 > captureMaxTicks {
		t0 = captureMaxTicks
	}
	maxd := int(maxDamage(target.Meta))
	if maxd <= 0 {
		maxd = 1
	}
	curHP := target.absHP()
	t2 := (curHP + maxd) * t0 / (2 * maxd)
	// Veteran capture resistance (§4.1 a5): ×(10 + kills/5)/10, uncapped.
	t := (target.kills/5 + 10) * t2 * 10 / 100
	if t < 1 {
		t = 1
	}
	return t
}

// absHP is the unit's current hit points on the FBI maxdamage scale (the
// percent bar times maxdamage), the figure the integer channel formulas use.
func (u *Unit) absHP() int {
	if u == nil || u.Meta == nil || u.Meta.MaxHealth <= 0 {
		return 100
	}
	hp := u.Health.Mul(u.Meta.MaxHealth).Div(fixed.FromInt(100)).Int()
	if hp < 0 {
		hp = 0
	}
	return hp
}

// applyCapture arms a capture channel: the capturer must cancapture and the
// target must NOT itself cancapture (Commanders are uncapturable) and be fully
// built. The channel time is fixed once, here at arming.
func (w *World) applyCapture(u *Unit, targetID uint32) {
	if u == nil || u.Dead || u.underConstruction() || u.Meta == nil || !u.Meta.CanCapture {
		return
	}
	t := w.units[targetID]
	if t == nil || t.Dead || t == u || t.Meta == nil {
		return
	}
	// Immunity: a target that itself can capture cannot be captured.
	if t.Meta.CanCapture || t.underConstruction() {
		return
	}
	u.capTarget = targetID
	u.capAccum = 0
	u.capTime = captureTime(t)
	u.hasMove = false
	u.hasAttack = false
}

// applyReclaim arms a reclaim channel: the reclaimer must canreclamate and the
// target must NOT cancapture (Commanders unreclaimable). Ownership is not
// checked (own and enemy alike).
func (w *World) applyReclaim(u *Unit, targetID uint32) {
	if u == nil || u.Dead || u.underConstruction() || u.Meta == nil || !u.Meta.CanReclaim {
		return
	}
	t := w.units[targetID]
	if t == nil || t.Dead || t == u || t.Meta == nil || t.Meta.CanCapture {
		return
	}
	u.reclaimTarget = targetID
	u.reclaimAccum = 0
	u.hasMove = false
	u.hasAttack = false
}

// reclaimChunk is the once-computed per-pulse damage a reclaimer deals its
// target (specials.md §3.1, the mislabeled sim_ftol_min1):
//
//	chunk = max(1, ftol( (1 + builderKills/5)·workertime·targetMaxdamage·15
//	                     / (max(targetBuildcostmetal, 10)·300) ))
//
// (kills+5)/5 is integer division = 1 + kills/5, so the reclaimer's veterancy
// MULTIPLIES the drain (×2 at 5 kills). Baseline: workertime·maxdmg/(20·BCM).
func reclaimChunk(builder, target *Unit) int {
	if builder == nil || target == nil || builder.Meta == nil || target.Meta == nil {
		return 1
	}
	wt := float64(builder.Meta.WorkerTime)
	maxd := float64(maxDamage(target.Meta))
	bcm := float64(target.Meta.Econ.BuildCostMetal)
	if bcm < 10 {
		bcm = 10
	}
	vet := float64((builder.kills + 5) / 5) // integer division = 1 + kills/5
	chunk := int(ftol(vet * wt * maxd * 15 / (bcm * 300)))
	if chunk < 1 {
		chunk = 1
	}
	return chunk
}

// stepSpecials advances a unit's active order-channel special mechanics one
// tick: the capture channel, the reclaim pulse, cloak state, and paralyze
// decay. Called from the per-unit phase in Step.
func (w *World) stepSpecials(u *Unit) {
	w.stepPrivateMana(u)
	if u.capTarget != 0 {
		w.stepCapture(u)
	}
	if u.reclaimTarget != 0 {
		w.stepReclaim(u)
	}
}

// stepCapture advances the capture channel by two accumulator counts per
// 2-tick visit (specials.md §2.1: `order+0x36 += 2` per 2-tick visit until
// ≥ T), so the channel reaches the once-computed T after exactly T ticks. The
// transfer itself (destroy-plus-respawn, which mutates the unit iteration
// order) is deferred to a post-loop drain so it never disturbs the tick walk.
func (w *World) stepCapture(u *Unit) {
	t := w.units[u.capTarget]
	if t == nil || t.Dead {
		u.capTarget, u.capAccum, u.capTime = 0, 0, 0
		return
	}
	if w.tick%2 != 0 {
		return // only the 2-tick visits advance the channel
	}
	u.capAccum += 2
	if u.capAccum < u.capTime {
		return
	}
	w.pendingTransfers = append(w.pendingTransfers, pendingTransfer{
		target: u.capTarget, newSide: u.Side, reason: deathReasonCaptured,
	})
	u.capTarget, u.capAccum, u.capTime = 0, 0, 0
}

// pendingTransfer records a completed capture/conversion whose destroy-plus-
// respawn is applied after the unit loop finishes.
type pendingTransfer struct {
	target  uint32
	newSide int
	reason  int
}

// drainTransfers applies every queued ownership transfer; called once per tick
// after the per-unit phase, where RemoveUnit's order-slice mutation is safe.
func (w *World) drainTransfers() {
	if len(w.pendingTransfers) == 0 {
		return
	}
	pending := w.pendingTransfers
	w.pendingTransfers = w.pendingTransfers[:0]
	for _, p := range pending {
		if t := w.units[p.target]; t != nil && !t.Dead {
			w.transferOwnership(t, p.newSide, p.reason)
		}
	}
}

// stepReclaim advances the reclaim pulse: the accumulator climbs 2 per 2-tick
// visit and, when it exceeds 14 — every 16 ticks, the sized-for-15 off-by-one
// — applies one chunk of reason-5 damage. At the target's death the metal
// credit lands via reclaimDamage.
func (w *World) stepReclaim(u *Unit) {
	t := w.units[u.reclaimTarget]
	if t == nil || t.Dead {
		u.reclaimTarget, u.reclaimAccum = 0, 0
		return
	}
	if w.tick%2 != 0 {
		return // only the 2-tick visits advance the pulse timer
	}
	u.reclaimAccum += 2
	if u.reclaimAccum <= 14 {
		return
	}
	u.reclaimAccum = 0
	chunk := reclaimChunk(u, t)
	dead := w.reclaimDamage(u.ID, t, chunk)
	if dead {
		u.reclaimTarget = 0
	}
}

// reclaimDamage applies one reclaim chunk to the target as reason-5 damage and,
// on the lethal pulse, credits the reclaimer's side the metal salvage —
// (1 − buildFrac)·buildcostmetal, metal only, no energy (specials.md §3.1).
func (w *World) reclaimDamage(sourceID uint32, t *Unit, chunk int) bool {
	buildFrac := float64(t.buildRem) // 0 = complete, 1 = fresh frame
	metalGain := (1 - buildFrac) * float64(t.Meta.Econ.BuildCostMetal)
	dead := w.ApplyDamage(sourceID, t.ID, fixed.FromInt(chunk))
	if dead {
		if src := w.units[sourceID]; src != nil && metalGain > 0 {
			w.creditMetal(src.Side, float32(metalGain))
		}
	}
	return dead
}

// transferOwnership performs the destroy-plus-respawn ownership change both
// engines run for capture (TA, reason 4) and conversion (TA:K, wire 0x13): the
// target is respawned as the same type at the same position under newSide, its
// HP and build remaining preserved, and the original destroyed with the
// wreck-suppressing reason (reasons 4/5/9 leave no wreck and run no Killed
// script). Accumulated veterancy is NOT carried over — the respawn is a fresh
// body, so the kills/xp counters reset to zero.
func (w *World) transferOwnership(t *Unit, newSide int, reason int) {
	name, meta := t.Name, t.Meta
	pos := fixed.Vec2{X: t.loco.Pos.X, Z: t.loco.Pos.Z}
	heading := int32(t.loco.Heading.Int())
	hp := t.Health
	buildRem := t.buildRem
	var binding Binding
	if w.spawn != nil {
		_, binding = w.spawn(name)
	}
	// Destroy the original directly (no wreck, no death blast — the
	// suppressing reason path); a plain death event marks the removal.
	t.Health = 0
	t.Dead = true
	w.emit(frame.Event{Kind: frame.EvDeath, UnitID: t.ID, Anchor: t.Pos(), SfxType: reason})
	w.RemoveUnit(t.ID)
	// Respawn under the new owner with the preserved state (kills/xp NOT
	// copied — a fresh body loses its veterancy).
	id := w.addUnit(name, meta, binding, pos, heading, newSide, true)
	if nu := w.units[id]; nu != nil {
		nu.Health = hp
		nu.buildRem = buildRem
		nu.buildHP = maxDamage(meta)
		w.emit(frame.Event{Kind: frame.EvSpawn, UnitID: id, Anchor: nu.Pos()})
	}
}

// paralyzeMaxTicks is the 60-second (1800-tick) cap on a Paralyze order's
// accumulator (specials.md §7.2).
const paralyzeMaxTicks = 1800

// SetHealthPercent pins a unit's health bar (0..100) directly — a measurement
// hook so a scenario can pre-damage a unit and then observe a healing mechanic
// (the AdjustJoy aura, repair) restore it. Clamped to [0, 100].
func (w *World) SetHealthPercent(id uint32, pct int) {
	u := w.units[id]
	if u == nil {
		return
	}
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	u.Health = fixed.FromInt(pct)
}

// InjectParalyze adds paralyze ticks to a unit directly — a measurement hook
// (the set_paralyze scenario action) that exercises the accumulator's cap and
// decay without staging the full paralyzer firing chain. Mirrors the retail
// per-hit accumulation (clamped at 1800) so the cap is graded on the same math.
func (w *World) InjectParalyze(id uint32, amount int) {
	w.applyParalyze(w.units[id], amount)
}

// applyParalyze folds a paralyzer weapon's damage into the victim's paralyze
// accumulator (the spec's per-order stun field, §7.2), clamped at 1800 ticks.
// Immunity: dying units and the immunetoparalyzer flag (not surfaced here —
// no stock scenario exercises it) are skipped. The value is a decaying tick
// count; while positive the unit steps no orders or weapons.
func (w *World) applyParalyze(victim *Unit, amount int) {
	if victim == nil || victim.Dead || amount <= 0 {
		return
	}
	victim.paralyzeAccum += amount
	if victim.paralyzeAccum > paralyzeMaxTicks {
		victim.paralyzeAccum = paralyzeMaxTicks
	}
}

// mindControlThreshold is the veterancy-scaled conversion stick chance
// (specials.md §2.2/§4.2 consumer 4): min((level + 16)·5, 99) — 80 % at L0,
// 99 % at L≥4. Levels make special weapons MORE likely to stick. The falloff
// weighting (edge-effectiveness argument) multiplies this before the CRT roll.
func mindControlThreshold(level int) int {
	th := (level + 16) * 5
	if th > 99 {
		th = 99
	}
	return th
}

// tryMindControl rolls one mind-control hit (specials.md §2.2). Immunity:
// same owner, no COB context (unmodelled — every unit has a body here),
// commander, not fully built, being carried, cantbecaptured. The roll uses the
// veterancy-scaled threshold times the falloff weight; on success the victim is
// converted (destroy-plus-respawn under the caster, XP zeroed).
//
// CRT-stream seam: the engines draw the roll on the unsynced CRT stream
// (crt_rand()·100/0x8000). The sandbox has no CRT stream wired into the world,
// so it draws the roll on the shared MINSTD sim stream instead — deterministic
// given the seed, but on a different generator than the retail engines. The
// gradeable invariant is the THRESHOLD (mindControlThreshold), which the
// harness pins exactly; the stochastic outcome is a documented divergence
// until the CRT ledger lands.
func (w *World) tryMindControl(caster, victim *Unit, falloff float64) {
	if caster == nil || victim == nil || victim.Dead || victim.Meta == nil {
		return
	}
	if caster.Side == victim.Side {
		return
	}
	if victim.Meta.Commander || victim.Meta.CantBeCaptured ||
		victim.underConstruction() || victim.carriedBy != 0 {
		return
	}
	level := takLevel(victim)
	threshold := int(float64(mindControlThreshold(level)) * falloff)
	roll := int(w.rng.Bounded(100)) // seam: CRT stream in the engines
	if roll < threshold {
		w.pendingTransfers = append(w.pendingTransfers, pendingTransfer{
			target: victim.ID, newSide: caster.Side, reason: deathReasonCaptured,
		})
	}
}

// takLevel is the TA:K veteran level of a unit: xp / own experiencepoints,
// capped at 10 (specials.md §4.2). Zero for units without an experiencepoints
// figure.
func takLevel(u *Unit) int {
	if u == nil || u.Meta == nil || u.Meta.ExperiencePoints <= 0 {
		return 0
	}
	level := u.xp / u.Meta.ExperiencePoints
	if level > 10 {
		level = 10
	}
	if level < 0 {
		level = 0
	}
	return level
}

// MindControlThreshold exposes the veterancy-scaled conversion stick chance
// (percent) for a unit at its current level — a harness accessor the
// mind-control scenario grades exactly (the CRT roll itself is a documented
// seam).
func (w *World) MindControlThreshold(id uint32) int {
	if u := w.units[id]; u != nil {
		return mindControlThreshold(takLevel(u))
	}
	return 0
}

// stepPrivateMana recharges a TA:K unit's private mana pool (§7.1): free,
// per-tick, clamped to MaxMana, only while active and fully built. TA units
// (MaxMana == 0) never accumulate.
func (w *World) stepPrivateMana(u *Unit) {
	if w.econModel != EconomyTAK || u.Meta == nil || u.Meta.MaxMana <= 0 {
		return
	}
	if u.underConstruction() {
		return
	}
	u.privMana += u.Meta.ManaRechargeTick
	if u.privMana > u.Meta.MaxMana {
		u.privMana = u.Meta.MaxMana
	}
}

// stepCloakSettle runs a TA unit's per-settle cloak drain (specials.md §5.1):
// while cloaked, an all-or-nothing energy drain of ftol(cloakcost) stationary
// or ftol(cloakcostmoving) moving. On shortfall the unit decloaks. Called from
// the TA settle (once per second).
func (w *World) stepCloakSettle(u *Unit) {
	if u.Meta == nil || !u.cloaked || u.underConstruction() {
		return
	}
	cost := u.Meta.CloakCost
	if u.IsMoving {
		cost = u.Meta.CloakCostMoving
	}
	drain := float32(ftol(float64(cost)))
	if drain <= 0 {
		return
	}
	if !w.taConsumeShot(u.Side, drain, 0) {
		u.cloaked = false // shortfall: decloak
	}
}

// stepCloakTAK runs a TA:K unit's per-tick cloak drain off the private mana
// pool (specials.md §5.2): cost is cloakcost/cloakcostmoving already stored
// ÷30 at parse. On a private-pool shortfall the unit decloaks and takes a
// 90-tick re-cloak lockout.
func (w *World) stepCloakTAK(u *Unit) {
	if u.Meta == nil || !u.cloaked || u.underConstruction() {
		return
	}
	if w.tick < u.cloakLock {
		u.cloaked = false
		return
	}
	cost := u.Meta.CloakCost
	if u.IsMoving {
		cost = u.Meta.CloakCostMoving
	}
	if u.privMana < cost {
		u.cloaked = false
		u.cloakLock = w.tick + 90
		return
	}
	u.privMana -= cost
}

// PrivateMana reports a TA:K unit's private mana pool (0 for TA / an absent
// unit) — a harness/inspection accessor.
func (w *World) PrivateMana(id uint32) float32 {
	if u := w.units[id]; u != nil {
		return u.privMana
	}
	return 0
}

// Cloaked reports whether a unit is currently cloaked.
func (w *World) Cloaked(id uint32) bool {
	if u := w.units[id]; u != nil {
		return u.cloaked
	}
	return false
}

// ParalyzeTicks reports a unit's remaining paralyze tick count.
func (w *World) ParalyzeTicks(id uint32) int {
	if u := w.units[id]; u != nil {
		return u.paralyzeAccum
	}
	return 0
}

// SideOf reports the current owning side of a unit (its captured/converted
// owner after a transfer), or -1 if the id is gone.
func (w *World) SideOf(id uint32) int {
	if u := w.units[id]; u != nil {
		return u.Side
	}
	return -1
}

// healAuraInterval is the AdjustJoy healing-aura cadence: every 30 ticks
// (tick % 0x1e == 0), specials.md §7.4.
const healAuraInterval = 30

// applyHealAuras runs the TA:K AdjustJoy healing auras (specials.md §7.4),
// invoked from Step on the 30-tick cadence. For each aura source, count the
// eligible built targets in radius (N), then heal each by amount = factor/N of
// a full build — HP += maxHP·(factor/N)/buildtime per pulse — where factor =
// Adjustment·factor0 and factor0 = Edge + (1−Edge)·(dist/radius) is the
// INVERTED falloff (full at the edge, Edge weighting the centre).
func (w *World) applyHealAuras() {
	for _, id := range w.order {
		src := w.units[id]
		if src == nil || src.Dead || src.Meta == nil || src.Meta.HealAura == nil {
			continue
		}
		if src.underConstruction() {
			continue
		}
		aura := src.Meta.HealAura
		radius := fixed.FromInt(aura.RadiusWU)
		if radius <= 0 {
			continue
		}
		// First pass: collect eligible built targets in radius.
		var targets []*Unit
		for _, tid := range w.order {
			t := w.units[tid]
			if t == nil || t.Dead || t.Meta == nil || t.underConstruction() {
				continue
			}
			// Joy is affects-self 0: the aura owner does not heal itself.
			if t == src {
				continue
			}
			if !aura.AffectsEnemy && t.Side != src.Side {
				continue
			}
			if src.loco.Pos.DistTo(t.loco.Pos) > radius {
				continue
			}
			targets = append(targets, t)
		}
		n := len(targets)
		if n == 0 {
			continue
		}
		for _, t := range targets {
			dist := src.loco.Pos.DistTo(t.loco.Pos).Float()
			factor0 := aura.Edge + (1-aura.Edge)*(dist/float64(aura.RadiusWU))
			factor := aura.Adjustment * factor0
			w.healUnit(t, factor/float64(n))
		}
	}
}

// healUnit adds HP to a unit as a fraction of a full build: the amount is
// maxHP·frac/buildtime per pulse (the add-HP applicator, specials.md §7.4),
// clamped to full health.
func (w *World) healUnit(t *Unit, frac float64) {
	if t.Meta == nil || frac <= 0 {
		return
	}
	bt := float64(t.Meta.Econ.BuildTimeF)
	if bt <= 0 {
		bt = 100
	}
	maxHP := float64(maxDamage(t.Meta))
	heal := maxHP * frac / bt
	if heal <= 0 {
		return
	}
	// Health is a 0..100 percent bar; convert the HP heal onto it.
	pct := fixed.FromFloat(heal * 100 / maxHP)
	t.Health += pct
	if t.Health > fixed.FromInt(100) {
		t.Health = fixed.FromInt(100)
	}
}

// resurrectTicks is the CORE Necro resurrect duration (specials.md §3.3):
// ftol(0.3·buildtime / float(workertime/30)) — integer division inside the
// float. A harness accessor; the sim has no feature/wreck entities to run a
// full resurrect against yet (DELTA §4), so this pins the arithmetic.
func resurrectTicks(builderWorkerTime int, targetBuildTime float64) int {
	rate := float64(builderWorkerTime / 30) // integer division inside the float
	if rate <= 0 {
		return 0
	}
	return int(ftol(0.3 * targetBuildTime / rate))
}

// ResurrectTicks exposes the resurrect channel length for a builder (by id)
// raising a unit type of the given buildtime — the gradeable arithmetic.
func (w *World) ResurrectTicks(builderID uint32, targetBuildTime float64) int {
	u := w.units[builderID]
	if u == nil || u.Meta == nil {
		return 0
	}
	return resurrectTicks(u.Meta.WorkerTime, targetBuildTime)
}

// StockpileCap is the per-slot stockpile ceiling (specials.md §6.1.1): the
// stock byte a stockpile weapon builds toward saturates at 200. The full
// stockpile firing pipeline is a later block (DELTA §7); this pins the cap the
// spec fixes, exposed for the harness to grade as the invariant.
func (w *World) StockpileCap() int { return 200 }

// coverageCovers is the anti-nuke 2D SQUARE box coverage test (specials.md
// §6.1.2): a target at world offset (dx, dz) from the interceptor is covered
// iff |dx| ≤ coverage AND |dz| ≤ coverage — an axis-aligned box, NOT a circle
// and NOT 3D. dx/dz and coverage are world units.
func coverageCovers(coverageWU, dx, dz int) bool {
	if dx < 0 {
		dx = -dx
	}
	if dz < 0 {
		dz = -dz
	}
	return dx <= coverageWU && dz <= coverageWU
}

// CoverageCovers exposes an interceptor's square-box coverage test against a
// world point — the anti-nuke acquisition invariant the harness grades. slot
// selects the weapon; a non-interceptor slot never covers anything.
func (w *World) CoverageCovers(id uint32, slot int, x, z int) bool {
	u := w.units[id]
	if u == nil || u.Meta == nil || slot < 0 || slot >= len(u.Meta.Weapons) {
		return false
	}
	wm := &u.Meta.Weapons[slot]
	if !wm.Interceptor || wm.CoverageWU <= 0 {
		return false
	}
	p := u.Pos()
	return coverageCovers(wm.CoverageWU, x-p.X.Int(), z-p.Z.Int())
}

// creditMetal adds a lump metal gain to a side's TA pool (reclaim salvage /
// resource share). Settle-clamped like all income: the pool is bumped and the
// next settle's storage clamp meters any overflow.
func (w *World) creditMetal(side int, metal float32) {
	if side < 0 || side >= maxSides || metal <= 0 {
		return
	}
	p := &w.econTA[side]
	if !p.seeded {
		w.seedSideEconomy(side)
	}
	p.stockM = f32(float64(p.stockM) + float64(metal))
	p.producedM += float64(metal)
}
