// The authoritative per-side economy. Pools gate real work: weapon shots,
// construction, and income all move them, with each game's exact arithmetic:
//
//   - TA runs a dual pool (metal + energy) that SETTLES once per second
//     (every 30 ticks). Per-tick consumers post demand into per-unit econ
//     slots; the settle pays all of a window's grants with one shared
//     proportional ratio per axis, clamps the pool into its storage cap, and
//     rolls unmet grants into per-unit stall carryover — a consumer gets one
//     window of overdraft, then its grants are refused until the carryover
//     pays down. Weapon per-shot costs bypass the settle and hit the pool
//     immediately, all-or-nothing.
//   - TA:K runs a single mana pool (internally "Mogrium" — one pool, two
//     names) recomputed every tick: income and the storage capacity are
//     summed in a pre-pass before the unit phase, along with a demand
//     forecast that sets the proportional throttle ratio; per-unit build
//     drains then run against the live pool (never over-drawing, never fully
//     stopping); a finalizer clamps the pool into capacity once per tick and
//     meters the overflow as waste.
//
// All pool arithmetic is IEEE float32 with float64 intermediates standing in
// for the engines' x87 float80 registers (divergence in principle is the
// spec's open U8/U11 experiment; the sandbox pins the float64 reading).
package sim

import (
	"math"

	"github.com/coreprime/kbot/engine/fixed"
)

// EconomyModel selects which game's economy law a world runs.
type EconomyModel uint8

const (
	// EconomyTA — dual metal/energy pools, 1 Hz settle, stall carryover.
	EconomyTA EconomyModel = iota
	// EconomyTAK — single mana pool, per-tick income and throttle.
	EconomyTAK
)

// taSettleTicks is the TA economy settle interval: once per second (30
// ticks). The engine's per-player settle timer is zeroed with the player
// struct (spec U7 — an explicit initializer was never found); the sandbox
// reads that as settles landing on ticks 30, 60, 90, ... which is the phase
// the harness scenarios pin (first income credit at frame 30).
const taSettleTicks = 30

// taDefaultStart is the skirmish-default opening stock per axis (the lobby /
// SkirmishInfo value the engines fill the pools from).
const taDefaultStart = 1000

// taStorageFloor: the engine stores max(startValue, 200) into the per-player
// storage-cap bonus fields — the base storage every TA player has even
// though no FBI declares it.
const taStorageFloor = 200

// takTickScale is TA:K's per-tick income/demand scale: NOT 1/30 but the
// engine's 8-digit decimal literal 0.03333333 (bits 0x3FA11110F46EFD39).
var takTickScale = math.Float64frombits(0x3FA11110F46EFD39)

// econAxis is one axis of a TA unit's econ slot: production credited this
// settle window, consumption requested/granted this window, and the stall
// carryover — unmet demand from previous windows. carry > 0 means the unit
// is stalled on this axis: new grants are refused and the extractor /
// metal-maker income gate reads false. prevProd/prevReq are the display
// copies the settle rotation publishes.
type econAxis struct {
	prod, req, granted, carry float32
	prevProd, prevReq         float32
}

// sideEconTA is one side's TA pool pair. Caps are rebuilt from scratch every
// settle (unit storage fields plus the start bonus); wasted meters overflow
// clamped off at the settle, in the engines' lifetime doubles.
type sideEconTA struct {
	seeded         bool
	stockE, stockM float32
	bonusE, bonusM float32 // max(start, 200) cap bonus per axis
	capE, capM     float32 // last settle's rebuilt caps (display + clamp)
	// Last settle's summed production / requested consumption, the
	// income/expense rate fields (per settle = per second).
	incomeE, incomeM     float32
	expenseE, expenseM   float32
	producedE, producedM float64
	wastedE, wastedM     float64
}

// sideEconTAK is one side's mana pool (the 0x190 block: stock, capacity,
// throttle ratio, per-tick gained/demand meters, lifetime doubles). The
// per-second history ring is display-only and not modelled.
type sideEconTAK struct {
	seeded   bool
	stock    float32 // pool[0]
	capacity float32 // pool[1], recomputed every tick, floor 1.0
	throttle float32 // pool[2], the demand-forecast build efficiency
	gained   float32 // pool[3], income landed this tick
	demand   float32 // pool[4], unthrottled demand metered this tick
	produced float64
	wasted   float64
}

// f32 collapses a float64 intermediate to the engines' stored width.
func f32(v float64) float32 { return float32(v) }

// fxTrunc converts a float32 pool value to the snapshot's Q16.16 axis with
// truncation toward zero (pools are never negative).
func fxTrunc(v float32) fixed.Fixed { return fixed.Fixed(int64(float64(v) * 65536)) }

// ftol truncates toward zero — the engines' __ftol.
func ftol(v float64) int64 { return int64(v) }

// seedSideEconomy initialises a side's pools the first time it fields a
// unit: TA fills the opening stock and the max(start,200) cap bonus; TA:K
// starts empty with the capacity floor and an open throttle (the opening
// mana arrives via spawn grants instead).
func (w *World) seedSideEconomy(side int) {
	if side < 0 || side >= maxSides {
		return
	}
	if w.econModel == EconomyTAK {
		p := &w.econTAK[side]
		if !p.seeded {
			p.seeded = true
			p.capacity = 1
			p.throttle = 1
		}
		return
	}
	p := &w.econTA[side]
	if p.seeded {
		return
	}
	p.seeded = true
	startE, startM := w.startEnergy, w.startMetal
	p.stockE, p.stockM = float32(startE), float32(startM)
	p.bonusE, p.bonusM = float32(max(startE, taStorageFloor)), float32(max(startM, taStorageFloor))
	p.capE, p.capM = p.bonusE, p.bonusM
}

// grantSpawnMana is TA:K's spawn grant: a unit spawned already complete
// credits its own mogriumstorage to the owner's pool and lifetime-produced
// (how scenario starting kits — monarch plus lodestone — seed the opening
// mana). Incomplete spawns (nanoframes) never pass here.
func (w *World) grantSpawnMana(u *Unit) {
	if w.econModel != EconomyTAK || u.Meta == nil || u.Side < 0 || u.Side >= maxSides {
		return
	}
	s := u.Meta.Econ.ManaStorage
	if s == 0 {
		return
	}
	p := &w.econTAK[u.Side]
	p.stock = f32(float64(p.stock) + float64(s))
	p.produced += float64(s)
	// The engine also bumps capacity here; transient — the next tick's
	// pre-pass recomputes it — but it keeps a pre-first-tick snapshot sane.
	p.capacity = f32(float64(p.capacity) + float64(s))
}

// cacheExtractorYield computes a TA extractor's income ONCE, at placement:
// yield = extractsmetal × Σ over footprint cells (cellMetal + 1) — the +1
// floor means an extractor on bare ground still produces footprintArea ×
// extractsmetal. There is no extraction radius and the yield never
// re-samples after placement.
func (w *World) cacheExtractorYield(u *Unit) {
	if u.Meta == nil || u.Meta.Econ.ExtractsMetal <= 0 {
		return
	}
	fx, fz := u.Meta.FootprintX, u.Meta.FootprintZ
	if fx <= 0 {
		fx = 1
	}
	if fz <= 0 {
		fz = 1
	}
	// Footprint cells anchored on the unit's plot position (16 wu cells).
	cx0 := int(u.loco.Pos.X>>20) - fx/2
	cz0 := int(u.loco.Pos.Z>>20) - fz/2
	sum := 0
	for dz := 0; dz < fz; dz++ {
		for dx := 0; dx < fx; dx++ {
			sum += int(w.cellMetal(cx0+dx, cz0+dz)) + 1
		}
	}
	// The engine accumulates the sum in an integer high word and normalizes
	// by 2^-16 — an exact integer either way — then scales by the float32
	// extractsmetal and stores the yield as float32.
	u.mexYield = f32(float64(u.Meta.Econ.ExtractsMetal) * float64(sum))
}

// econAccumulate posts single-axis demand (TA): the request always accrues;
// the grant lands — and the caller may proceed — only while the axis has no
// positive stall carryover.
func econAccumulate(a *econAxis, amount float32) bool {
	a.req = f32(float64(a.req) + float64(amount))
	if a.carry > 0 {
		return false
	}
	a.granted = f32(float64(a.granted) + float64(amount))
	return true
}

// econAccumulate2 posts dual-axis demand (TA builders/stockpilers): requests
// always accrue on both axes, but the grants land — and work may proceed —
// only if NEITHER axis carries stall debt.
func econAccumulate2(u *Unit, costE, costM float32) bool {
	u.econE.req = f32(float64(u.econE.req) + float64(costE))
	u.econM.req = f32(float64(u.econM.req) + float64(costM))
	if u.econE.carry > 0 || u.econM.carry > 0 {
		return false
	}
	u.econE.granted = f32(float64(u.econE.granted) + float64(costE))
	u.econM.granted = f32(float64(u.econM.granted) + float64(costM))
	return true
}

// taConsumeShot is TA's immediate all-or-nothing spender (weapon fire):
// both pools must cover the full per-shot amounts or nothing drains.
func (w *World) taConsumeShot(side int, e, m float32) bool {
	if side < 0 || side >= maxSides {
		return true
	}
	p := &w.econTA[side]
	if p.stockE < e || p.stockM < m {
		return false
	}
	p.stockE = f32(float64(p.stockE) - float64(e))
	p.stockM = f32(float64(p.stockM) - float64(m))
	return true
}

// taCanAffordShot is the fire gate's stock check (the drain itself commits
// after launch through taConsumeShot).
func (w *World) taCanAffordShot(side int, e, m float32) bool {
	if side < 0 || side >= maxSides {
		return true
	}
	p := &w.econTA[side]
	return p.stockE >= e && p.stockM >= m
}

// settleTA closes one TA settle window (once per second) for every seeded
// side: credit each unit's income, rebuild the storage caps, pay the
// window's demand with the two-pass proportional payout, clamp into storage
// (metering overflow as waste), and rotate every econ slot — the unmet
// fraction of what a unit was granted becomes its stall carryover.
func (w *World) settleTA() {
	// Per-side sums accumulate in float64 (the engines keep them in x87
	// registers across the unit loop — float80; U8 stand-in).
	var prodE, prodM, reqE, reqM [maxSides]float64
	var grantE, grantM, carryE, carryM [maxSides]float64
	var capE, capM [maxSides]float64

	for _, id := range w.order {
		u := w.units[id]
		if u == nil || u.Dead || u.Meta == nil || u.Side < 0 || u.Side >= maxSides ||
			u.carriedBy != 0 {
			continue
		}
		s := u.Side
		w.taUnitIncomeTick(u, &prodE[s], &prodM[s])
		grantE[s] += float64(u.econE.granted)
		grantM[s] += float64(u.econM.granted)
		carryE[s] += float64(u.econE.carry)
		carryM[s] += float64(u.econM.carry)
		reqE[s] += float64(u.econE.req)
		reqM[s] += float64(u.econM.req)
		prodE[s] += float64(u.econE.prod)
		prodM[s] += float64(u.econM.prod)
		if u.buildRem == 0 {
			capE[s] += float64(u.Meta.Econ.EnergyStorage)
			capM[s] += float64(u.Meta.Econ.MetalStorage)
		}
	}

	var ratioNewE, ratioNewM, ratioCarryE, ratioCarryM [maxSides]float64
	for side := range w.econTA {
		p := &w.econTA[side]
		if !p.seeded {
			continue
		}
		p.incomeE, p.expenseE = f32(prodE[side]), f32(reqE[side])
		p.incomeM, p.expenseM = f32(prodM[side]), f32(reqM[side])
		p.producedE += prodE[side]
		p.producedM += prodM[side]
		p.capE = f32(capE[side] + float64(p.bonusE))
		p.capM = f32(capM[side] + float64(p.bonusM))
		var wE, wM float64
		p.stockE, ratioCarryE[side], ratioNewE[side], wE =
			settleAxis(prodE[side], float64(p.stockE), carryE[side], grantE[side], float64(p.capE))
		p.stockM, ratioCarryM[side], ratioNewM[side], wM =
			settleAxis(prodM[side], float64(p.stockM), carryM[side], grantM[side], float64(p.capM))
		p.wastedE += wE
		p.wastedM += wM
	}

	// Slot rotation: publish the display copies, zero the window, and fold
	// the unpaid grant/carry fractions into next window's carryover.
	for _, id := range w.order {
		u := w.units[id]
		if u == nil || u.Dead || u.Side < 0 || u.Side >= maxSides {
			continue
		}
		s := u.Side
		rotateAxis(&u.econE, ratioNewE[s], ratioCarryE[s])
		rotateAxis(&u.econM, ratioNewM[s], ratioCarryM[s])
	}

	// TA cloak drain runs once per settle, after income has landed and the
	// pools clamped: an all-or-nothing energy debit of ftol(cloakcost)
	// (stationary) / ftol(cloakcostmoving) (moving) against the settled stock
	// (specials.md §5.1). Shortfall decloaks the unit.
	for _, id := range w.order {
		if u := w.units[id]; u != nil && !u.Dead && u.cloaked {
			w.stepCloakSettle(u)
		}
	}
}

// taUnitIncomeTick is one unit's income pass at the settle, the branch
// structure of the engine's per-unit resource tick.
func (w *World) taUnitIncomeTick(u *Unit, prodE, prodM *float64) {
	ec := &u.Meta.Econ
	if u.Meta.CanMove {
		// Mobile units: only energyuse applies, gated on active OR moving.
		// (The sandbox reads the structure discriminator as !CanMove — the
		// engine's structure-like flag setter is its own unknown, U1.)
		if u.active || u.IsMoving {
			if ec.EnergyUse < 0 {
				*prodE += float64(-ec.EnergyUse)
			} else if ec.EnergyUse > 0 {
				econAccumulate(&u.econE, ec.EnergyUse)
			}
		}
	} else if u.active {
		// Structures: energyuse first (negative energyuse is how solar
		// works), computing the energy-satisfied gate for the production
		// suite; then exactly one income branch in priority order.
		if ec.EnergyUse < 0 {
			*prodE += float64(-ec.EnergyUse)
		} else if ec.EnergyUse > 0 {
			econAccumulate(&u.econE, ec.EnergyUse)
		}
		energyOK := u.econE.carry <= 0
		switch {
		case ec.ExtractsMetal > 0:
			if energyOK {
				*prodM += float64(u.mexYield)
			}
		case ec.MakesMetal != 0:
			// Metal maker: an energy stall in the previous window stops
			// metal output in this one. The engine's 2:1 stored-metal
			// auto-toggle draws rand(5) from the shared sim stream; the
			// sandbox leaves the toggle unmodelled rather than perturb the
			// stream's draw order (seam: revisit with the RNG ledger).
			if energyOK {
				*prodM += float64(int32(ec.MakesMetal))
			}
		case ec.WindGenerator > 0:
			// Wind income needs the live wind scalar; the sandbox carries
			// no wind system yet (seam: world block), so wind generators
			// produce nothing rather than inventing a strength.
		case ec.TidalGenerator > 0:
			// Map tidal strength defaults to 0.5 when the OTA declares
			// none; the sandbox has no OTA feed, so the default applies.
			*prodE += 0.5 * float64(ec.TidalGenerator)
		}
	}
	// Fully-built block (both branches): passive income does NOT require
	// the active bit. Storage caps are summed by the caller.
	if u.buildRem == 0 {
		*prodE += float64(ec.EnergyMake)
		*prodM += float64(ec.MetalMake)
	}
	// The cloak energy drain runs once per settle at the tail of settleTA,
	// after this window's income has landed and the pools have clamped
	// (specials.md §5.1) — see stepCloakSettle.
}

// settleAxis runs one axis's settle: avail = production + stored, the
// two-pass proportional payout (carryover first, then the window's grants),
// then the storage clamp. Returns the stored float32, both payout ratios,
// and the overflow wasted.
func settleAxis(prod, stored, carrySum, grantSum, cap float64) (float32, float64, float64, float64) {
	avail := prod + stored
	ratioCarry, ratioNew := 1.0, 1.0
	if carrySum > 0 {
		ratioCarry = avail / carrySum
		if ratioCarry > 1 {
			ratioCarry = 1
		}
		avail -= math.Min(avail, carrySum)
	}
	if grantSum > 0 {
		ratioNew = avail / grantSum
		if ratioNew > 1 {
			ratioNew = 1
		}
		avail -= math.Min(avail, grantSum)
	}
	var wasted float64
	if avail > cap {
		wasted = avail - cap
		avail = cap
	}
	return f32(avail), ratioCarry, ratioNew, wasted
}

// rotateAxis closes a unit slot's settle window: the unpaid fraction of this
// window's grants plus the unpaid fraction of the old carryover becomes the
// new carryover — the entire stall model in one line. Carryover decays
// geometrically as later windows pay it down; while any remains, grants are
// refused.
func rotateAxis(a *econAxis, ratioNew, ratioCarry float64) {
	a.prevProd, a.prevReq = a.prod, a.req
	a.prod, a.req = 0, 0
	a.carry = f32(float64(a.granted)*(1-ratioNew) + float64(a.carry)*(1-ratioCarry))
	a.granted = 0
}

// stepManaPhaseB is TA:K's pre-unit-phase economy pass, run every tick for
// every seeded side: sum income and storage over fully built units and the
// demand forecast over actively-building builders, land the tick's income,
// rebuild capacity (floor 1.0), and set the throttle ratio the tick's
// drains will be scaled by.
func (w *World) stepManaPhaseB() {
	var income, capacity, demand [maxSides]float64
	for _, id := range w.order {
		u := w.units[id]
		if u == nil || u.Dead || u.Meta == nil || u.Side < 0 || u.Side >= maxSides {
			continue
		}
		s := u.Side
		if u.buildRem == 0 {
			// Lodestone sacred-site gating (income only while the yardmap's
			// 'S' cells fully cover a sacredsite feature) is a feature-world
			// mechanic; until the feature block lands, mogriumincome credits
			// ungated (seam: Block 7 replaces this with the footprint scan).
			income[s] += float64(u.Meta.Econ.ManaIncome)
			capacity[s] += float64(u.Meta.Econ.ManaStorage)
		}
		// Demand forecast: builders with the actively-building state flag
		// contribute workertime × (1/buildtime) × buildcost of their target.
		if u.buildState == buildRaising {
			if b := w.units[u.buildeeID]; b != nil && !b.Dead && b.Meta != nil && b.buildRem != 0 {
				demand[s] += float64(u.Meta.Econ.WorkerTimeF) *
					float64(b.Meta.Econ.BuildTimeRecip) * float64(b.Meta.Econ.BuildCost)
			}
		}
	}
	for side := range w.econTAK {
		p := &w.econTAK[side]
		if !p.seeded {
			continue
		}
		tickIncome := income[side] * takTickScale
		// The x87 keeps the product extended across the three adds (U11:
		// float64 stand-in), storing each destination at its own width.
		p.stock = f32(float64(p.stock) + tickIncome)
		p.produced += tickIncome
		p.gained = f32(float64(p.gained) + tickIncome)
		if capacity[side] > 0 {
			p.capacity = f32(capacity[side])
		} else {
			p.capacity = 1
		}
		demandTick := demand[side] * takTickScale
		if float64(p.stock) < demandTick {
			p.throttle = f32(float64(p.stock) / demandTick)
		} else {
			p.throttle = 1
		}
	}
}

// stepManaFinalize is TA:K's per-tick pool finalizer: clamp a negative pool
// to zero and the overflow above capacity off, metering both into the wasted
// lifetime double, then zero the per-tick meters. (The campaign
// MogriumSpecialLimit override and the per-second history ring are
// savegame/display machinery the sandbox does not model.)
func (w *World) stepManaFinalize() {
	for side := range w.econTAK {
		p := &w.econTAK[side]
		if !p.seeded {
			continue
		}
		if p.stock < 0 {
			p.wasted += float64(p.stock)
			p.stock = 0
		}
		if p.capacity < p.stock {
			p.wasted += float64(p.stock) - float64(p.capacity)
			p.stock = p.capacity
		}
		p.gained, p.demand = 0, 0
	}
}

// takApplyBuild advances one TA:K builder's work on its buildee by one tick:
// throttle-first proportional math — work is scaled by the demand-forecast
// ratio, then clamped to the live pool, so builds slow smoothly and never
// over-draw. Returns true when the buildee completed this tick.
func (w *World) takApplyBuild(builder, b *Unit) bool {
	if b.buildRem == 0 || b.Meta == nil {
		return false
	}
	b.lastNanoTick = w.tick
	p := &w.econTAK[builder.Side]
	tEc := &b.Meta.Econ
	amount := float64(builder.Meta.Econ.WorkerTimeF) * takTickScale
	eff := float64(p.throttle) * amount
	eff *= float64(tEc.BuildTimeRecip)
	cost := eff * float64(tEc.BuildCost)
	// Unthrottled demand metering (feeds the next tick's throttle forecast
	// through phase B's separate sum; kept for the meter's own fidelity).
	p.demand = f32(float64(p.demand) + float64(tEc.BuildTimeRecip)*float64(tEc.BuildCost)*amount)
	if float64(p.stock) < cost {
		r := 0.0
		if p.stock > 0 {
			r = float64(p.stock) / cost
		}
		cost *= r
		eff *= r
	}
	rem := float64(b.buildRem) - eff
	p.stock = f32(float64(p.stock) - cost)
	w.tallySpend(builder.Side, 0, 0, cost)
	if rem <= 0 {
		w.setBuildRem(b, 0)
		b.buildHP = maxDamage(b.Meta)
		w.syncBuildHealth(b)
		return true
	}
	w.setBuildRem(b, f32(rem))
	// HP display: truncated recompute from the stored remaining.
	b.buildHP = int32(ftol((1 - float64(b.buildRem)) * float64(maxDamage(b.Meta))))
	w.syncBuildHealth(b)
	return false
}

// takApplyDecay rolls an unworked TA:K frame back by 0.5 build points this
// tick, refunding the prorated mana at full buildcost rate; a frame that
// regresses to remaining >= 1.0 self-destructs with no further refund.
// Returns true when the shell collapsed.
func (w *World) takApplyDecay(b *Unit) bool {
	if b.Meta == nil || b.Side < 0 || b.Side >= maxSides {
		return false
	}
	tEc := &b.Meta.Econ
	eff := 0.5 * float64(tEc.BuildTimeRecip)
	cost := eff * float64(tEc.BuildCost)
	rem := float64(b.buildRem) + eff
	if rem >= 1 {
		return true
	}
	p := &w.econTAK[b.Side]
	p.stock = f32(float64(p.stock) + cost)
	p.produced += cost
	p.gained = f32(float64(p.gained) + cost)
	w.setBuildRem(b, f32(rem))
	return false
}

// taApplyBuild advances one TA builder's work on its buildee by one tick:
// progress floor(workertime/30)/buildtime, resource drain linearly prorated
// through the stall-aware demand path (all-or-nothing per tick: a stalled
// builder's tick contributes nothing at all), HP climbing the truncation
// ladder from 0 to exactly maxdamage. Returns true when the buildee
// completed this tick.
func (w *World) taApplyBuild(builder, b *Unit) bool {
	if b.buildRem == 0 || b.Meta == nil {
		return false
	}
	// The nanolathed keep-alive stamps before the stall check — a stalled
	// builder's touch still holds off abandonment decay.
	b.lastNanoTick = w.tick
	amount := builder.Meta.Econ.WorkerTime / 30 // unsigned integer division
	if amount == 0 {
		return false
	}
	bt := b.Meta.Econ.BuildTime
	if bt <= 0 {
		bt = 1
	}
	rem := float64(b.buildRem)
	newRem := rem - float64(amount)/float64(bt)
	if newRem < 0 {
		newRem = 0
	}
	// delta stays at register width (the engine's float80; float64 here)
	// while the stored remaining rounds to float32.
	delta := rem - newRem
	costE := f32(delta * float64(b.Meta.Econ.BuildCostEnergy))
	costM := f32(delta * float64(b.Meta.Econ.BuildCostMetal))
	maxHP := float64(maxDamage(b.Meta))
	hpDelta := ftol(maxHP*rem) - ftol(maxHP*newRem)
	if !econAccumulate2(builder, costE, costM) {
		return false // stalled: no progress, no HP, no partial drain
	}
	w.tallySpend(builder.Side, float64(costM), float64(costE), 0)
	b.buildHP += int32(hpDelta)
	if m := maxDamage(b.Meta); b.buildHP > m {
		b.buildHP = m
	}
	w.setBuildRem(b, f32(newRem))
	w.syncBuildHealth(b)
	return newRem == 0
}

// taApplyDecayPulse rolls an abandoned TA frame back by one 11-tick decay
// pulse: progress falls 11/buildcostenergy, the prorated metal refunds into
// the frame's own production accumulator (energy is never refunded), and HP
// walks back down the truncation ladder. Returns true when the frame
// regressed to remaining >= 1.0 and dies.
func (w *World) taApplyDecayPulse(b *Unit) bool {
	if b.Meta == nil {
		return false
	}
	bce := float64(b.Meta.Econ.BuildCostEnergy)
	if bce <= 0 {
		return false // engine data always prices energy; guard the div
	}
	bt := b.Meta.Econ.BuildTime
	if bt <= 0 {
		bt = 1
	}
	// amount = -(buildtime × 11)/buildcostenergy, so the applicator's
	// amount/buildtime regression is 11/buildcostenergy of total progress.
	amount := -(float64(bt) * 11.0) / bce
	rem := float64(b.buildRem)
	newRem := rem - amount/float64(bt)
	if newRem >= 1 {
		return true
	}
	delta := rem - newRem // negative
	b.econM.prod = f32(float64(b.econM.prod) + (-delta)*float64(b.Meta.Econ.BuildCostMetal))
	maxHP := float64(maxDamage(b.Meta))
	hpDelta := ftol(maxHP*rem) - ftol(maxHP*newRem) // negative
	b.buildHP += int32(hpDelta)
	if b.buildHP < 0 {
		b.buildHP = 0
	}
	w.setBuildRem(b, f32(newRem))
	w.syncBuildHealth(b)
	return false
}

// maxDamage is the unit's absolute hit points as the engines' integer.
func maxDamage(m *UnitMeta) int32 {
	if m == nil || m.MaxHealth <= 0 {
		return 100
	}
	return int32(m.MaxHealth.Int())
}

// setBuildRem stores a buildee's authoritative float32 build-remaining and
// keeps the fixed-point BuildPercent (the snapshot/HUD axis) derived from it.
func (w *World) setBuildRem(b *Unit, rem float32) {
	b.buildRem = rem
	b.BuildPercent = fixed.FromFloat((1 - float64(rem)) * 100)
}

// syncRemFromPercent derives the float32 build-remaining (and the HP ladder
// value) from an externally written BuildPercent/Health — the Restore and
// replay-override paths, whose wire carries the fixed-point axes. Loses the
// low float bits by construction; those paths are presentation-driven.
func (u *Unit) syncRemFromPercent() {
	rem := 1 - u.BuildPercent.Float()/100
	if rem < 0 {
		rem = 0
	}
	if rem > 1 {
		rem = 1
	}
	u.buildRem = float32(rem)
	u.buildHP = int32(u.Health.Mul(fixed.FromInt(int(maxDamage(u.Meta)))).Div(fixed.FromInt(100)).Int())
}

// syncBuildHealth republishes a frame's percent health bar from its integer
// build HP (the ladder value is authoritative while under construction).
func (w *World) syncBuildHealth(b *Unit) {
	m := maxDamage(b.Meta)
	if m <= 0 {
		m = 1
	}
	b.Health = fixed.FromInt(int(b.buildHP) * 100).Div(fixed.FromInt(int(m)))
}

// resView is the HUD/render view of one side's economy: the float32 pool
// values collapsed to the snapshot's fixed-point axes. seeded reports whether
// the side has an economy at all (so the snapshot can skip empty sides).
type resView struct {
	seeded                       bool
	stock, cap, income, produced resourceTally
}

// econView collapses a side's live pools into the snapshot's fixed-point
// figures. The pool authority is float32; these are the display copies the
// economy bar reads (never fed back into the sim).
func (w *World) econView(side int) resView {
	if side < 0 || side >= maxSides {
		return resView{}
	}
	if w.econModel == EconomyTAK {
		p := &w.econTAK[side]
		if !p.seeded {
			return resView{}
		}
		return resView{
			seeded:   true,
			stock:    resourceTally{Mana: fxTrunc(p.stock)},
			cap:      resourceTally{Mana: fxTrunc(p.capacity)},
			income:   resourceTally{Mana: fxTrunc(p.gained * TickHz)},
			produced: resourceTally{Mana: fixed.FromFloat(p.produced)},
		}
	}
	p := &w.econTA[side]
	if !p.seeded {
		return resView{}
	}
	return resView{
		seeded: true,
		stock:  resourceTally{Energy: fxTrunc(p.stockE), Metal: fxTrunc(p.stockM)},
		cap:    resourceTally{Energy: fxTrunc(p.capE), Metal: fxTrunc(p.capM)},
		income: resourceTally{Energy: fxTrunc(p.incomeE), Metal: fxTrunc(p.incomeM)},
		produced: resourceTally{
			Energy: fixed.FromFloat(p.producedE),
			Metal:  fixed.FromFloat(p.producedM),
		},
	}
}

// tallySpend folds a drain into the side's HUD usage figures (fixed point,
// display only — the float pools above are the authority).
func (w *World) tallySpend(side int, metal, energy, mana float64) {
	if side < 0 || side >= maxSides {
		return
	}
	w.resSpent[side].Metal += fixed.FromFloat(metal)
	w.resSpent[side].Energy += fixed.FromFloat(energy)
	w.resSpent[side].Mana += fixed.FromFloat(mana)
	perSec := fixed.FromInt(TickHz)
	w.resRate[side].Metal += fixed.FromFloat(metal).Mul(perSec)
	w.resRate[side].Energy += fixed.FromFloat(energy).Mul(perSec)
	w.resRate[side].Mana += fixed.FromFloat(mana).Mul(perSec)
}
