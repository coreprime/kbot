package sim

import (
	"time"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
)

const (
	// TickHz is the nominal simulation rate — both engines tick at 30 Hz
	// (scaled by gamespeed/10, which affects only how often a tick runs,
	// never the per-tick math). One tick is 33.33ms of game time.
	TickHz = 30
	// TickDuration is the wall-clock length of one tick at nominal speed;
	// hosts pacing the sim in real time divide it by their speed rate.
	TickDuration = time.Second / TickHz
)

// TickToMs converts a tick count to the running millisecond clock. 1000 is
// not divisible by 30, so the clock is derived from the tick count (exact,
// monotone) instead of accumulating a truncated per-tick increment.
func TickToMs(tick uint64) int64 { return int64(tick) * 1000 / TickHz }

// fxTickHz is the tick rate as a fixed-point divisor.
var fxTickHz = fixed.FromInt(TickHz)

// perTick converts a per-second rate to this tick's share: v/30. FBI rates
// are per-30Hz-frame values scaled to per-second at load (×30), so the
// division here cancels that scaling exactly and per-tick quantities equal
// the engines' native per-frame values.
func perTick(v fixed.Fixed) fixed.Fixed { return v.Div(fxTickHz) }

// defaultHitDamage matches the JS engine's constant for weapons whose TDF
// damage field has not been wired through yet.
var defaultHitDamage = fixed.FromInt(12)

// Runtime is the optional COB script VM the world advances each tick before
// movement, mirroring game-engine.js which ticks the runtime first.
type Runtime interface {
	Tick(ms int64)
}

// Step advances the simulation exactly one fixed tick. It is the only time
// source the world has; callers must invoke it once per TickDuration (scaled
// by game speed). The subsystem order below follows the engines' tick shape:
// scripts and their outputs first, then the per-unit pass (weapons before
// movement, as both engines run them), then projectiles, then the player-level
// economy, then decay.
func (w *World) Step(rt Runtime) {
	w.tick++
	w.simMs = TickToMs(w.tick)
	// Resource drain rates are instantaneous figures: rebuilt from this
	// tick's active builds (spent totals accumulate across ticks).
	for i := range w.resRate {
		w.resRate[i] = resourceTally{}
	}
	// TA:K recomputes its mana economy every tick BEFORE the unit phase:
	// income lands, capacity rebuilds, and the demand forecast sets the
	// throttle ratio the tick's build drains are scaled by.
	if w.econModel == EconomyTAK {
		w.stepManaPhaseB()
	}
	// Per-tick A* budget: a group move triggers many path searches, so cap
	// how many run this tick — the rest steer directly and pick up a path on
	// a later tick (deterministic: units are walked in w.order).
	w.pathBudget = 8
	if rt != nil {
		rt.Tick(w.simMs)
	}
	// Harvest script-emitted effects (EMIT_SFX / EXPLODE / PLAY_SOUND) into the
	// render event stream before movement runs. Dead units are included so a
	// Killed script's death-throes explosions surface before the unit is reaped.
	for _, id := range w.order {
		if u := w.units[id]; u != nil {
			w.drainEffects(u)
			// Dead units still owe their corpse decision: poll the tracked
			// Killed thread until the script settles the corpsetype.
			if u.Dead && u.corpsePending {
				w.stepCorpse(u)
			}
			// Publish health into the COB HEALTH port so scripts that poll it
			// (SmokeUnit damage plumes, TA:K ability gates) see real damage.
			// Every live unit, buildings included — they smoke too.
			if !u.Dead {
				if p, ok := u.binding.(CobPorts); ok {
					p.SetUnitValuePort(cobPortHealth, int32(u.Health.Int()))
				}
			}
		}
	}
	for _, id := range w.order {
		u := w.units[id]
		if u == nil || u.Dead {
			continue
		}
		// A buildee under construction is inert until it reaches 100%: no
		// orders bind to it, and it steps neither movement nor weapons. A
		// carried passenger is likewise inert — it rides its transport
		// (which pins its pose in stepTransport).
		if u.underConstruction() || u.carriedBy != 0 {
			continue
		}
		w.stepSelfDestruct(u)
		if u.Dead {
			continue
		}
		// Special order-channels (capture/reclaim) and per-tick special state
		// (private mana recharge, TA:K cloak drain, paralyze decay) advance
		// before the ordinary order phases. A paralyzed unit is frozen: it
		// steps neither its orders nor its weapons this tick.
		w.stepSpecials(u)
		if u.Dead {
			continue
		}
		if w.econModel == EconomyTAK {
			w.stepCloakTAK(u)
		}
		if u.paralyzeAccum > 0 {
			u.paralyzeAccum--
			continue
		}
		w.stepTransport(u)
		w.stepBuilder(u)
		w.stepStance(u)
		w.stepAttack(u)
		// Weapons fire before the unit moves — the engines' per-unit phase
		// order — so a shot launches from the pre-integration position.
		w.stepWeapons(u)
		w.stepMovement(u)
	}
	w.drainTransfers()
	w.pinCargo()
	w.stepYards()
	w.stepCollisions()
	w.stepProjectiles()
	w.stepBuildDecay()
	// TA settles its economy once per second — every unit's window of
	// income and posted demand pays out with the shared proportional
	// ratios, the pools clamp into storage, and the stall carryover rolls.
	// TA:K instead finalizes every tick: negative and over-capacity pool
	// values clamp, metering the discard as waste.
	if w.econModel == EconomyTAK {
		// TA:K healing auras (AdjustJoy) pulse every 30 ticks (specials.md
		// §7.4), before the pool finalizer clamps the tick's mana movement.
		if w.tick%healAuraInterval == 0 {
			w.applyHealAuras()
		}
		w.stepManaFinalize()
	} else if w.tick%taSettleTicks == 0 {
		w.settleTA()
	}
}

// stepBuildDecay rolls back every under-construction frame that no builder
// touched, with each engine's exact law: a TA frame idles for 30 ticks and
// then loses 11/buildcostenergy of total progress per 11-tick pulse (metal
// refunded into the frame's own accumulator); a TA:K frame decays 0.5 build
// points on every unworked tick, refunding mana at the full buildcost rate.
// Either way a frame that regresses to remaining >= 1.0 collapses with no
// wreck.
func (w *World) stepBuildDecay() {
	var collapsed []uint32
	for _, id := range w.order {
		b := w.units[id]
		if b == nil || b.Dead || b.Meta == nil || !b.underConstruction() {
			continue
		}
		if b.lastNanoTick >= w.tick {
			continue // a builder (even a stalled one) touched it this tick
		}
		if w.econModel == EconomyTAK {
			if w.takApplyDecay(b) {
				collapsed = append(collapsed, b.ID)
			}
			continue
		}
		idle := w.tick - b.lastNanoTick
		if idle < 30 || (idle-30)%11 != 0 {
			// The engine's getbuilt order sleeps 30 ticks per builder touch
			// and then pulses on an 11-tick timer; the exact phase of the
			// first pulse relative to the last touch is not pinned — the
			// sandbox fires it the tick the grace expires and every 11
			// ticks after.
			continue
		}
		if w.taApplyDecayPulse(b) {
			collapsed = append(collapsed, b.ID)
		}
	}
	for _, id := range collapsed {
		if b := w.units[id]; b != nil {
			b.Dead = true // for callers holding the pointer
		}
		w.RemoveUnit(id)
	}
}

// stepBuilder advances a builder's construction job. A mobile builder walks
// to within builddistance of its ordered site; a factory pops the next entry
// of its production queue onto its own pad. Either way the buildee spawns at
// 0% and rises at the TA pace (buildee buildtime points / builder workertime
// points-per-second), draining its resource price linearly, until complete
// and commandable. Factory completions roll the new unit off to clear ground.
func (w *World) stepBuilder(u *Unit) {
	switch u.buildState {
	case buildIdle:
		// Factory with work queued: take the head onto the pad. With an
		// Activate script the doors animate open first — the pad raise
		// waits for YARD_OPEN (or the grace deadline).
		if len(u.prodQueue) > 0 && !u.Meta.CanMove {
			name := u.prodQueue[0]
			u.prodQueue = u.prodQueue[1:]
			if len(u.prodQueue) == 0 {
				u.prodQueue = nil
			}
			u.buildName = name
			u.buildSite = w.factoryPad(u)
			if u.binding != nil && u.binding.HasScript("Activate") {
				u.binding.Start("Activate")
				u.buildState = buildOpening
				u.buildGateMs = w.simMs + buildGateGraceMs
			} else {
				w.startRaising(u)
			}
		}
	case buildOpening:
		w.buggerOff(u)
		if portValue(u, cobPortYardOpen) != 0 || w.simMs >= u.buildGateMs {
			w.startRaising(u)
		}
	case buildApproach:
		dist := u.loco.Pos.DistTo(u.buildSite)
		bd := u.Meta.BuildDistance
		if bd <= 0 {
			bd = fixed.FromInt(50)
		}
		if dist > bd {
			u.hasMove = true
			u.moveTarget = u.buildSite
			u.clearPath()
			return
		}
		u.hasMove = false
		w.startRaising(u)
	case buildRaising:
		if !u.Meta.CanMove {
			w.buggerOff(u)
		}
		b := w.units[u.buildeeID]
		if b == nil || b.Dead {
			w.cancelBuild(u)
			return
		}
		// The engine drives building itself: reaching the site raises the
		// actively-building state flag (unit+0x114 bit 8) and runs the applicator
		// every tick, firing StartBuilding purely as an animation notification —
		// it does NOT wait for the script to report the arm deployed. Gating
		// progress on the COB writing INBUILDSTANCE back made construction hostage
		// to the arm's RequestState machine, whose re-entrancy latch strands when
		// a StopBuilding thread is superseded before it clears, permanently
		// freezing INBUILDSTANCE at 0 on alternate jobs in a build queue. The
		// nano-arm animation still plays; only the false progress gate is gone.
		//
		// One tick of the exact nanolathe applicator: it advances progress by
		// floor(workertime/30)/buildtime (TA) or the throttled workertime rate
		// (TA:K), drains the prorated buildcost through the pool authority,
		// climbs the integer HP ladder, and republishes BuildPercent/Health.
		// It stamps the nanolathed keep-alive so a worked frame never decays.
		var done bool
		if w.econModel == EconomyTAK {
			done = w.takApplyBuild(u, b)
		} else {
			done = w.taApplyBuild(u, b)
		}
		// The frame sits at ground level throughout — the wireframe shell,
		// dark hull and nanolathe carry the visual; nothing rises out of the
		// earth.
		ground := w.groundHeight(b.loco.Pos)
		if !b.Meta.IsAircraft {
			b.PosY = ground
		}
		if !done {
			return
		}
		if u.binding != nil && u.binding.HasScript("StopBuilding") {
			u.binding.Start("StopBuilding")
		}
		// FBI activatewhenbuilt: the new unit switches itself on the moment
		// it completes (a solar collector unfolding its panels). setActivation
		// runs the Activate script and pins the ACTIVATION port together so the
		// studio's Active pill reads on.
		if b.Meta.ActivateWhenBuilt {
			w.setActivation(b, true)
		}
		w.emit(frame.Event{Kind: frame.EvBuildStop, UnitID: u.ID, TargetID: b.ID, Anchor: b.Pos()})
		// A factory rolls the finished unit off its pad to clear ground so
		// the next queue entry has room to raise.
		if !u.Meta.CanMove && b.Meta.CanMove {
			b.hasMove = true
			b.moveTarget = w.rolloffSpot(u, b)
			// The factory's rally template (its own order queue) becomes the
			// new unit's initial orders: move waypoints walk once, patrol
			// legs loop. Runs after the rolloff so the pad clears first.
			for _, c := range u.queue {
				b.enqueue(c)
			}
		}
		// Line drained: close the doors. With more queued the yard stays
		// open and the next entry pops straight onto the pad.
		if !u.Meta.CanMove && len(u.prodQueue) == 0 &&
			u.binding != nil && u.binding.HasScript("Deactivate") {
			u.binding.Start("Deactivate")
		}
		u.buildState = buildIdle
		u.buildName = ""
		u.buildeeID = 0
		// A mobile builder pulls its next shift-queued order — typically
		// the next construction site in a queued base plan.
		if u.Meta.CanMove {
			w.advanceQueue(u)
		}
	}
}

// startRaising spawns the active job's buildee at 0% — facing the builder's
// heading, sunk below grade — and flips the builder into the raising phase.
// A failed meta resolve drops the job (and lets a factory try its next entry
// rather than wedging the pad).
func (w *World) startRaising(u *Unit) {
	// Resume: adopt the existing frame the repair order pointed at. If it
	// finished or collapsed while we walked over, the job simply ends.
	if u.buildResumeID != 0 {
		b := w.units[u.buildResumeID]
		u.buildResumeID = 0
		if b == nil || b.Dead || !b.underConstruction() {
			u.buildState = buildIdle
			u.buildName = ""
			return
		}
		u.buildeeID = b.ID
		u.buildState = buildRaising
		u.buildGateMs = w.simMs + buildGateGraceMs
		if u.binding != nil && u.binding.HasScript("StartBuilding") {
			d := b.loco.Pos.Sub(u.loco.Pos)
			heading := aimBearing(u, b.loco.Pos)
			pitch := fixed.ShortestArc(fixed.Atan2(b.PosY-u.PosY, d.Len()))
			u.binding.Start("StartBuilding", int(heading), int(pitch))
		}
		w.emit(frame.Event{Kind: frame.EvBuildStart, UnitID: u.ID, TargetID: b.ID, Anchor: b.Pos(), FromPiece: -1})
		return
	}
	if w.spawn == nil {
		u.buildState = buildIdle
		u.buildName = ""
		return
	}
	meta, binding := w.spawn(u.buildName)
	if meta == nil {
		u.buildState = buildIdle
		u.buildName = ""
		return
	}
	// A mobile builder's drag gesture sets the buildee facing; otherwise it
	// inherits the builder's heading (the factory-pad path keeps its spin).
	buildeeHeading := u.Heading()
	if u.buildHeadingSet {
		buildeeHeading = u.buildHeading
	}
	// The buildee raises as a nanoframe: build-remaining 1.0, HP 0, inert —
	// the applicator (not this spawn) pays for it as it rises.
	id := w.addUnit(u.buildName, meta, binding, u.buildSite, buildeeHeading, u.Side, false)
	b := w.units[id]
	b.PosY = w.groundHeight(b.loco.Pos)
	u.buildeeID = id
	u.buildState = buildRaising
	u.buildGateMs = w.simMs + buildGateGraceMs
	if u.binding != nil && u.binding.HasScript("StartBuilding") {
		// Construction units take (heading, pitch): the torso turn toward
		// the site and the nano-arm elevation — the same TA-angle frame the
		// weapon aim threads use. Factories take no arguments.
		if u.Meta.CanMove {
			d := u.buildSite.Sub(u.loco.Pos)
			heading := aimBearing(u, u.buildSite)
			pitch := fixed.ShortestArc(fixed.Atan2(b.PosY-u.PosY, d.Len()))
			u.binding.Start("StartBuilding", int(heading), int(pitch))
		} else {
			u.binding.Start("StartBuilding")
		}
	}
	// A factory's QueryBuildInfo names the pad piece the buildee rides;
	// the renderer attaches the frame to that piece's live transform so
	// it sits on the plate and turns with it. -1 = no query script.
	padPiece := int32(-1)
	if !u.Meta.CanMove {
		if qb, ok := u.binding.(queryBinding); ok {
			if idx, ok2 := qb.RunQuery("QueryBuildInfo"); ok2 {
				padPiece = idx
			}
		}
	}
	site := fixed.Vec3{X: u.buildSite.X, Z: u.buildSite.Z}
	w.emit(frame.Event{Kind: frame.EvBuildStart, UnitID: u.ID, TargetID: id, Anchor: site, FromPiece: padPiece})
}

// cobPortBuggerOff is TA's BUGGER_OFF unit-value port: the engine raises it
// on a factory whose yard is obstructed so the script (and nearby units) know
// to clear out.
const cobPortBuggerOff = 19

// buggerOff clears squatters from a working factory's yard: the BUGGER_OFF
// port goes high while any outside unit overlaps the footprint, and idle
// trespassers are shooed to a clear spot so production never wedges on a
// blocked pad. Throttled to every 8th tick — yard scans are O(units).
func (w *World) buggerOff(u *Unit) {
	if w.tick%8 != 0 {
		return
	}
	hx, hz := yardHalfExtents(u.Meta)
	blocked := false
	for _, oid := range w.order {
		o := w.units[oid]
		if o == nil || o == u || o.ID == u.buildeeID || !collidable(o) ||
			o.Meta == nil || !o.Meta.CanMove || o.underConstruction() {
			continue
		}
		l := yardLocal(u, o.loco.Pos)
		if l.X.Abs() >= hx || l.Z.Abs() >= hz {
			continue
		}
		blocked = true
		// Shoo an idle squatter toward clear ground; busy units are on
		// their way somewhere already.
		if !o.hasMove && !o.hasAttack && len(o.queue) == 0 {
			o.hasMove = true
			o.moveTarget = w.rolloffSpot(u, o)
		}
	}
	if p, ok := u.binding.(CobPorts); ok {
		v := int32(0)
		if blocked {
			v = 1
		}
		p.SetUnitValuePort(cobPortBuggerOff, v)
	}
}

// factoryPad is where a factory raises its buildee: just inside the front
// edge of its footprint, along its facing.
func (w *World) factoryPad(u *Unit) fixed.Vec2 {
	r := u.Meta.collisionRadius().Div(fixed.FromInt(2))
	sin, cos := fixed.SinCos(int32(u.Heading()))
	return fixed.Vec2{X: u.loco.Pos.X + sin.Mul(r), Z: u.loco.Pos.Z + cos.Mul(r)}
}

// rolloffAngles are the candidate bearings (TA-angle offsets from the
// factory's facing) a finished unit tries when rolling off: straight out the
// exit, fanning sideways, then straight back. ~0.5 rad per step.
var rolloffAngles = [...]int32{0, 5215, -5215, 10430, -10430, 15645, -15645, 32768}

// rolloffSpot finds clear ground near the factory exit for a finished unit:
// ring search over distance and bearing, blocked by every collidable body's
// position AND destination so consecutive completions fan out instead of
// stacking. Falls back to straight ahead.
func (w *World) rolloffSpot(factory, b *Unit) fixed.Vec2 {
	clearance := b.Meta.collisionRadius().Mul(fixed.FromInt(2)) + fixed.FromInt(6)
	// Roll well past the whole footprint (not just the body circle) so the
	// finished unit clears the exit channel and never blocks the doors for
	// the next one off the line.
	base := factory.Meta.collisionRadius() + b.Meta.collisionRadius() + fixed.FromInt(12)
	if hasYard(factory) {
		hx, hz := yardHalfExtents(factory.Meta)
		base = fixed.Max(hx, hz) + b.Meta.collisionRadius().Mul(fixed.FromInt(2)) + fixed.FromInt(24)
	}
	heading := int32(factory.Heading())
	clearAt := func(p fixed.Vec2) bool {
		if !w.canStand(b.Meta, p) {
			return false
		}
		for _, id := range w.order {
			o := w.units[id]
			if o == nil || o == b || o == factory || !collidable(o) {
				continue
			}
			// Structures block by their yardmap cells, not a centre circle,
			// so rolloff spots hug a building's true silhouette.
			if hasYard(o) {
				if yardCircleOverlaps(o, p, clearance) {
					return false
				}
				continue
			}
			if o.loco.Pos.DistTo(p) < clearance {
				return false
			}
			if o.hasMove && o.moveTarget.DistTo(p) < clearance {
				return false
			}
		}
		return true
	}
	for ring := 0; ring < 4; ring++ {
		r := base + fixed.FromInt(30*ring)
		for _, da := range rolloffAngles {
			sin, cos := fixed.SinCos(heading + da)
			p := fixed.Vec2{X: factory.loco.Pos.X + sin.Mul(r), Z: factory.loco.Pos.Z + cos.Mul(r)}
			if clearAt(p) {
				return p
			}
		}
	}
	sin, cos := fixed.SinCos(heading)
	r := base + fixed.FromInt(60)
	return fixed.Vec2{X: factory.loco.Pos.X + sin.Mul(r), Z: factory.loco.Pos.Z + cos.Mul(r)}
}

// effectfulBinding is the optional surface a script binding exposes to hand the
// world the render-only effect events its COB opcodes produced this tick. The
// script VM's *Unit satisfies it; bindings without scripts don't, so the type
// assertion in drainEffects degrades cleanly.
type effectfulBinding interface {
	DrainEffects() []frame.Event
}

// drainEffects folds a unit's buffered script effects into the render event
// stream, stamping each with the unit's id and current world position so the
// renderer's particle / audio layers can place them. The script leaves UnitID
// and Anchor unset; the world is the only side that knows them.
func (w *World) drainEffects(u *Unit) {
	src, ok := u.binding.(effectfulBinding)
	if !ok {
		return
	}
	evs := src.DrainEffects()
	if len(evs) == 0 {
		return
	}
	anchor := u.Pos()
	for i := range evs {
		evs[i].UnitID = u.ID
		evs[i].Anchor = anchor
		w.emit(evs[i])
	}
}

// stepProjectiles advances every in-flight model weapon one tick, emits burst
// parents' pellets, refreshes a guided shot's aim at its live target, and
// detonates the ones that arrive or expire this tick. Projectiles run AFTER
// the per-unit pass, so a shot launched this tick gets its first move this
// tick and impact damage lands after unit movement — the engines' phase order.
func (w *World) stepProjectiles() {
	if len(w.projectiles) == 0 {
		return
	}
	var spawned []*projectile
	alive := w.projectiles[:0]
	for _, p := range w.projectiles {
		if p.mode == projBurstParent {
			// The parent is a static invisible emitter: one flying pellet
			// every burstGap ticks (the first a full gap after launch), then
			// removal when the count runs out.
			p.burstSince++
			if p.burstSince >= p.burstGap {
				p.burstSince = 0
				spawned = append(spawned, w.emitBurstPellet(p))
				p.burstLeft--
			}
			if p.burstLeft > 0 {
				alive = append(alive, p)
			}
			continue
		}
		if p.targetID != 0 {
			if t := w.units[p.targetID]; t != nil && !t.Dead {
				p.target = t.Pos()
			}
		}
		p.stepProjectile(fixed.Zero)
		// Terrain blocks the flight path: a shot dipping below the ground
		// detonates on the slope it hit (clipping the arc that would have
		// reached a target up on a cliff).
		if !p.dead && w.terrain != nil && p.ageSec > fixed.FromFloat(0.1) {
			g := w.groundHeight(fixed.Vec2{X: p.pos.X, Z: p.pos.Z})
			if p.pos.Y < g {
				p.pos.Y = g
				p.dead = true
				p.hit = true
			}
		}
		if p.dead {
			w.detonate(p)
			continue
		}
		alive = append(alive, p)
	}
	w.projectiles = append(alive, spawned...)
}

// emitBurstPellet clones one flying pellet off a burst parent. Two sim-stream
// draws happen here in the engines' projectile-phase order — lifetime jitter
// (±randomdecay/2 ticks) first, then the sprayangle bearing scatter
// (±spray/2) — each skipped without advancing the stream when its bound is
// below 2, the shared RNG's small-bound rule.
func (w *World) emitBurstPellet(parent *projectile) *projectile {
	wm := parent.wm
	lifeJitterTicks := 0
	if d := int32(wm.RandomDecayTicks); d >= 2 {
		lifeJitterTicks = int(w.rng.Bounded(d) - d/2)
	}
	bearing := parent.heading
	if sp := wm.SprayAngle; sp >= 2 {
		bearing += w.rng.Bounded(sp) - sp/2
	}
	// The pellet flies the parent's launch geometry at the scattered
	// bearing: same pitch, same speed, aim re-projected to the original
	// target distance. The parent's unit target rides along so the
	// single-target damage path credits the victim (the sandbox has no
	// per-cell flight collision yet — hit resolution stays aim-point based,
	// so a scattered pellet still credits its target; the muzzle is also
	// not re-queried per emission, since the sim carries no piece geometry).
	dx := parent.target.X - parent.origin.X
	dz := parent.target.Z - parent.origin.Z
	horiz := fixed.Hypot(dx, dz)
	sb, cb := fixed.SinCos(fixed.NormalizeAngle(bearing))
	target := fixed.Vec3{
		X: parent.origin.X + sb.Mul(horiz),
		Y: parent.target.Y,
		Z: parent.origin.Z + cb.Mul(horiz),
	}
	pellet := w.makeProjectile(parent.ownerID, parent.targetID, parent.slot, wm, parent.origin, target, parent.fromPiece)
	w.nextProjID++
	if lifeJitterTicks != 0 {
		pellet.lifeSec += fixed.FromInt(lifeJitterTicks).Div(fxTickHz)
		if pellet.lifeSec < 0 {
			pellet.lifeSec = 0
		}
	}
	w.emit(frame.Event{Kind: frame.EvProjectileSpawn, UnitID: parent.ownerID, Slot: parent.slot, TargetID: parent.targetID, Anchor: parent.origin, Weapon: wm.Name})
	return pellet
}

// detonate emits the projectile's hit event and, if it actually reached its
// target or the ground (rather than timing out), routes the landed shot
// through the shared damage pipeline — the per-target table, the sub-17 wu
// single-target shortcut, quadratic splash with bounding-box distance and the
// per-game shooter rule.
func (w *World) detonate(p *projectile) {
	w.emit(frame.Event{Kind: frame.EvProjectileHit, UnitID: p.ownerID, Slot: p.slot, TargetID: p.targetID, Anchor: p.pos, Weapon: p.weapon})
	if !p.hit {
		return
	}
	w.detonateWeapon(p.ownerID, p.targetID, &p.wm, p.pos)
}

// stepAttack drives the explicit Attack-order path: it points a unit at its
// target and decides whether to close. Aircraft fly a full attack maneuver
// (delegated to stepAircraftAttack); ground units walk into range. A full
// autonomous target scan lives in the COB layer. Ported from game-engine.js
// #stepAttack.
func (w *World) stepAttack(u *Unit) {
	// Tear down a dead/departed autonomous attack target, but preserve a
	// committed bomb run — its slot is locked to a cached aim point, so the run
	// finishes even after the prey dies.
	if u.hasAttack {
		if t := w.units[u.attackTarget]; t == nil || t.Dead {
			u.hasAttack = false
			u.attackTarget = 0
			for slot := range u.weapons {
				s := &u.weapons[slot]
				if s.hasTarget && s.source == "attack" {
					if u.bombRunActive && u.bombRunSlot == slot {
						continue
					}
					w.clearWeaponSlot(u, slot)
				}
			}
			// The attack completed (target died/despawned) — start the next
			// shift-queued order. Any chase move still armed is stale; the
			// queue entry overwrites or clears it.
			u.hasMove = false
			w.advanceQueue(u)
		}
	}

	// Sweep stale attack-tagged slots when there's no engagement and no bomb run
	// (e.g. a Move order cancelled the attack); otherwise they auto-fire forever.
	if !u.hasAttack && !u.bombRunActive {
		for slot := range u.weapons {
			s := &u.weapons[slot]
			if s.hasTarget && s.source == "attack" {
				w.clearWeaponSlot(u, slot)
			}
		}
	}

	// Aircraft fly an attack maneuver around whatever they're engaging — an
	// autonomous unit target or a force-fired weapon slot.
	if u.Meta.CanMove && u.Meta.IsAircraft {
		w.stepAircraftAttack(u)
		return
	}

	// Ground / ship / sub: walk into range of an autonomous attack target. A
	// force-fire point fires in place via the weapon SM's own range gate.
	if !u.hasAttack {
		return
	}
	t := w.units[u.attackTarget]
	if t == nil || t.Dead {
		return
	}
	rngF := engageRange(u.Meta.Weapons[0])
	if rngF <= 0 {
		rngF = fixed.FromInt(220)
	}
	dist := u.loco.Pos.DistTo(t.loco.Pos)
	if dist > rngF {
		// Out of range. Hold Position never steps off its spot — it waits
		// for the prey to come to it (an autonomous engagement stands down
		// so acquisition can re-pick something reachable).
		if u.moveMode == MoveHold {
			if u.autoEngaged {
				w.standDown(u)
			}
			return
		}
		// Chase the prey's current position and drop slot 0 so the SM
		// doesn't burn aim threads while we walk.
		u.hasMove = true
		u.moveTarget = t.loco.Pos
		s := &u.weapons[0]
		if s.hasTarget && s.source == "attack" {
			w.clearWeaponSlot(u, 0)
		}
		return
	}
	// In range — stop walking and point slot 0 at the enemy. Re-pushing the same
	// target each tick is a no-op, so the live aim thread survives across ticks.
	u.hasMove = false
	if u.Meta.Weapons[0].CommandFire {
		return // command-fire weapons never join a standing attack
	}
	s := &u.weapons[0]
	if s.hasTarget && s.source == "manual" {
		return // an explicit force-fire order owns the slot
	}
	s.hasTarget = true
	s.source = "attack"
	s.targetUnit = u.attackTarget
}

// stepAircraftAttack flies an engaged aircraft's attack pattern. It follows
// whatever the unit is shooting at — an autonomous attack target, else the
// first armed weapon slot's aim point, so force-fire-at-point flies the same
// pattern as attack-a-unit. A Move order preempts the pattern for everything
// except a bomber mid-run (the bomb-and-bail tactic). Ported from
// game-engine.js #stepAttack's aircraft branch.
func (w *World) stepAircraftAttack(u *Unit) {
	var ex, ez fixed.Fixed
	var haveAim bool
	eslot := 0
	var armUnit *Unit
	if u.hasAttack {
		if t := w.units[u.attackTarget]; t != nil && !t.Dead {
			armUnit = t
			ex, ez = t.loco.Pos.X, t.loco.Pos.Z
			haveAim = true
		}
	}
	if !haveAim {
		for s := 0; s < 3; s++ {
			if pt, ok := w.slotAimXZ(u, s); ok {
				ex, ez = pt.X, pt.Z
				eslot = s
				haveAim = true
				break
			}
		}
	}
	if !haveAim {
		u.atkActive = false
		return
	}

	wm := u.Meta.Weapons[eslot]
	bomberMode := wm.Dropped
	var passthrough fixed.Fixed
	if bomberMode {
		_, halfRun := bombRunGeometry(u.loco.Speed.Mul(fxTickHz), wm)
		passthrough = fixed.Min(fixed.FromInt(600), halfRun+fixed.FromInt(30))
	}

	// Sticky bomber: a committed run or a manual force-fire slot keeps the
	// maneuver in control even when the player issues Move; other aircraft drop
	// the pattern and obey the Move.
	stickyBomber := false
	if bomberMode {
		if u.bombRunActive {
			stickyBomber = true
		} else {
			for s := 0; s < 3; s++ {
				if u.weapons[s].hasTarget && u.weapons[s].source == "manual" {
					stickyBomber = true
					break
				}
			}
		}
	}
	if u.hasMove && !stickyBomber {
		u.atkActive = false
		return
	}

	rngF := wm.Range
	if rngF <= 0 {
		rngF = fixed.FromInt(220)
	}
	if !u.atkActive {
		u.atkActive = true
		u.atkPhase = atkApproach
		u.sweepPhase = 0
		u.sweepCenter = 0
		u.egX, u.egZ = 0, 0
		// Seed the fly-by side deterministically from the unit id (odd => +1,
		// even => -1) so a flight scatters to both sides without consuming the
		// world rng — which would desync a late joiner whose rng stream lags the
		// authority's. The maneuver toggles it on each egress (figure-eight).
		if u.ID%2 == 1 {
			u.flybySide = 1
		} else {
			u.flybySide = -1
		}
	}
	u.attackManeuver(ex, ez, rngF, bomberMode, passthrough)
	u.hasMove = false // the maneuver owns movement; don't double-drive in stepMovement

	// Auto-arm slot 0 only for an autonomous unit pursuit — a force-fire slot is
	// already armed and re-arming would reset its aim.
	if armUnit != nil {
		s := &u.weapons[0]
		s.hasTarget = true
		s.source = "attack"
		s.targetUnit = u.attackTarget
	}
}

// slotAimXZ returns the world XZ a weapon slot is aiming at — its armed point,
// or a live unit target's position — so the aircraft maneuver can follow
// whatever the unit is actually trying to shoot. ok is false for an unarmed
// slot or a dead/missing unit target.
func (w *World) slotAimXZ(u *Unit, slot int) (fixed.Vec2, bool) {
	s := &u.weapons[slot]
	if !s.hasTarget {
		return fixed.Vec2{}, false
	}
	if s.targetUnit == 0 {
		return fixed.Vec2{X: s.targetPt.X, Z: s.targetPt.Z}, true
	}
	if t := w.units[s.targetUnit]; t != nil && !t.Dead {
		return t.loco.Pos, true
	}
	return fixed.Vec2{}, false
}

// bombRunGeometry derives a bomber's run from the weapon TDF and the carrier's
// current speed: bomb spacing is carrier-speed x reload, the run spreads ~4
// blast diameters along the flight path, and the bomb count is that run divided
// by the spacing (min 2). halfRun is the drop-window half-length — the run is
// centred on the aim point. Mirrors the JS engine's bomb-run math.
func bombRunGeometry(carrierSpeed fixed.Fixed, wm WeaponMeta) (bombs int, halfRun fixed.Fixed) {
	cs := fixed.Max(fixed.One, carrierSpeed)
	reloadSec := fixed.FromFloat(0.18)
	if wm.ReloadMs > 0 {
		reloadSec = fixed.FromInt(wm.ReloadMs).Div(fixed.FromInt(1000))
	}
	spacing := cs.Mul(reloadSec)
	aoe := wm.AreaOfEffectWU
	if aoe <= 0 {
		aoe = fixed.FromInt(32)
	}
	desiredRun := aoe.Mul(fixed.FromInt(4))
	bombs = 2
	if spacing > 0 {
		ratio := desiredRun.Div(spacing)
		c := ratio.Int() // floor
		if ratio > fixed.FromInt(c) {
			c++ // ceil
		}
		if c > bombs {
			bombs = c
		}
	}
	halfRun = fixed.FromInt(bombs - 1).Mul(spacing).Div(fixed.FromInt(2))
	return bombs, halfRun
}

// withinFireArc enforces the weapon TDF tolerance (TA-angle, 65536 = full turn)
// as a yaw firing arc for aircraft, which aim by pointing the whole airframe.
// The body heading must be within tolerance of the target bearing before the
// weapon may open fire. Turreted ground units aim via their COB AimX turret
// (gated separately) so the body arc never constrains them. Ported from
// game-engine.js #withinFireArc.
func (u *Unit) withinFireArc(wm WeaponMeta, targetPos fixed.Vec2) bool {
	if wm.Tolerance <= 0 || !u.Meta.IsAircraft {
		return true
	}
	d := targetPos.Sub(u.loco.Pos)
	bearing := fixed.Atan2(d.X, d.Z)
	return absAngle(fixed.ShortestArc(bearing-u.Heading())) <= wm.Tolerance
}

// inBombDropWindow gates a bomber's dropped weapon so a run only STARTS when the
// carrier is close enough that the string will straddle the target. Once a run
// is committed (bombRunActive) the gate stays open until the cached count
// empties, even through a Move order. Ported from game-engine.js #stepWeapon.
func (u *Unit) inBombDropWindow(slot int, wm WeaponMeta, targetPos fixed.Vec2) bool {
	if !wm.Dropped || !u.Meta.IsAircraft {
		return true
	}
	if u.bombRunActive && u.bombRunSlot == slot {
		return true
	}
	_, halfRun := bombRunGeometry(u.loco.Speed.Mul(fxTickHz), wm)
	return u.loco.Pos.DistTo(targetPos) <= halfRun
}

// stepMovement integrates one tick of locomotion plus aircraft altitude and
// emits move-start/move-stop. Ported from game-engine.js #stepMovement.
func (w *World) stepMovement(u *Unit) {
	if u.motionPin != motionPinNone {
		w.stepPinnedMovement(u)
		return
	}
	wasMoving := u.IsMoving
	if u.hasMove && u.Meta.CanMove {
		// Global path: a Move/Patrol/Build destination routes around terrain
		// (spiral ramps, cliffs) and static structures via A* (pathfind.go);
		// the unit walks its smoothed waypoints. Local avoidance below layers
		// dynamic-unit detours on top of the current waypoint.
		w.ensurePath(u)
		// Wedge recovery: an ordered unit that makes no NET progress across
		// ticks is pinned (a pushback or the terrain blocked-step revert
		// cancelling its step). Measured at tick ENTRY so the cancellation is
		// visible. Past ~1.2s — longer than any turn-in-place — force a path
		// recompute from here; after a few fruitless retries the destination
		// is unreachable and the order is abandoned.
		if u.loco.Pos.DistTo(u.progressPos) < fixed.FromFloat(0.08) {
			u.stallTicks++
			if u.stallTicks >= 50 {
				u.stallTicks = 0
				u.avoidFlip = !u.avoidFlip
				u.pathTried = false
				u.path = nil
				u.pathIdx = 0
				u.pathFails++
				if u.pathFails > 3 {
					// Genuinely stuck — drop the order.
					u.hasMove = false
					u.IsMoving = false
					u.clearPath()
					if u.curIsPatrol {
						u.curIsPatrol = false
					}
					if !u.hasAttack {
						w.advanceQueue(u)
					}
					return
				}
			}
		} else if u.stallTicks > 0 {
			u.stallTicks = 0
		}
		u.progressPos = u.loco.Pos
		// Intermediate waypoints complete within the engines' ~5-cell consume
		// radius; the 80 wu pull-in below corner-cuts toward the next one —
		// together they are what smooths raw waypoint chains (the engines
		// have no smoothing pass).
		w.consumeWaypoints(u)
		goal := u.currentGoal()
		steer := w.avoidanceTarget(u, goal)
		var next *fixed.Vec2
		if steer == goal && u.pathEligible() && u.pathIdx+1 < len(u.path) {
			nv := u.path[u.pathIdx+1]
			next = &nv
		}
		w.stepGroundToward(u, steer, next)
		u.IsMoving = u.walkTier() > 0
		// Final arrival: only against the true destination, never a detour
		// point (the avoidance layer re-steers every tick on its own).
		if steer == goal && u.goalIsFinal() && arrivedFinal(&u.loco, goal) {
			u.hasMove = false
			u.avoidFlip = false
			u.stallTicks = 0
			u.clearPath()
			// A completed patrol leg re-queues itself at the tail, so N
			// consecutive patrol commands loop the route indefinitely.
			if u.curIsPatrol {
				u.enqueue(queuedCommand{kind: order.KindPatrol, target: u.moveTarget})
			}
			// A player move completing starts the next shift-queued order. A
			// chase move (stepAttack walking into range) arrives with hasAttack
			// still set — the attack is the active order, so its queue waits.
			if !u.hasAttack {
				w.advanceQueue(u)
			}
		}
	} else if u.Meta.IsAircraft && u.atkActive && u.Meta.CanMove {
		// stepAttack already flew this aircraft's maneuver — it advanced pos and
		// heading and ramped speed. Mark it moving and leave speed UNTOUCHED; the
		// plain else below would zero speed, restarting the maneuver from a
		// standstill so the aircraft could never accelerate or fly its arc.
		u.IsMoving = true
	} else if u.Meta.CanMove && !u.Meta.IsAircraft {
		// No steering target: the engines brake to a stop rather than
		// halting — the unit coasts through its brake ramp along its
		// heading until the ≥0 clamp lands.
		w.stepGroundIdle(u)
		u.IsMoving = u.walkTier() > 0
	} else {
		u.IsMoving = false
		u.loco.Speed = 0
	}

	// Hard map border: the playable world is the loaded map's extent. Ground,
	// sea and hover units cannot cross it — momentum, pushback or avoidance
	// that would shove them past the edge is clamped to the boundary (their
	// body kept fully inside). Aircraft may fly past mid-maneuver (an attack
	// run, a banking turn) but cannot come to rest outside, so a landed/idle
	// flier is pulled back in.
	if w.terrain != nil && u.Meta != nil {
		if !u.Meta.IsAircraft || (!u.IsMoving && !u.atkActive) {
			u.loco.Pos = w.clampToMap(u.loco.Pos, u.Meta.collisionRadius())
		}
	}

	if u.Meta.IsAircraft {
		w.stepAltitude(u)
	} else {
		w.settleOnTerrain(u)
	}

	w.announceMotion(u, wasMoving)
}

// announceMotion drives the walk-animation contract (§7) plus the render
// move events. Shared by the order-driven locomotion and the replay motion
// pin, so walk cycles start and stop through one code path however motion is
// decided.
func (w *World) announceMotion(u *Unit, wasMoving bool) {
	// Render event stream + the TA:K flier takeoff/landing announcements ride
	// the coarse moving flag's edges.
	if u.IsMoving && !wasMoving {
		// TA:K fliers have no StartMoving: the engine announces takeoff via
		// BeginFlight and marks the unit airborne through setSFXoccupy(5) —
		// the state the dragons' FlightControl loop gates its wing-flap
		// cycle on.
		if u.binding != nil && u.binding.HasScript("BeginFlight") {
			u.binding.Start("BeginFlight")
		}
		if u.Meta != nil && u.Meta.IsAircraft && u.binding != nil && u.binding.HasScript("setSFXoccupy") {
			u.binding.Start("setSFXoccupy", takOccupyAir)
		}
		w.emit(frame.Event{Kind: frame.EvMoveStart, UnitID: u.ID})
	} else if !u.IsMoving && wasMoving {
		// TA:K fliers: announce the landing sequence and drop the airborne
		// occupation state so the flap loop folds the wings.
		if u.binding != nil && u.binding.HasScript("BeginLanding") {
			u.binding.Start("BeginLanding")
		}
		if u.Meta != nil && u.Meta.IsAircraft && u.binding != nil && u.binding.HasScript("setSFXoccupy") {
			u.binding.Start("setSFXoccupy", takOccupyLand)
		}
		w.emit(frame.Event{Kind: frame.EvMoveStop, UnitID: u.ID})
	}

	// Walk-anim tier (§7): 0 while blocked or fully at rest (speed 0 AND not
	// turning — pivoting in place counts as moving), else 1..3 against the
	// MoveRate1/2 thresholds. Emission is strictly transition-edged, and the
	// dialect decides the calls: TA fires StartMoving/StopMoving/MoveRate1-3,
	// TA:K a single parameterised MoveRate(tier); TA:K additionally notifies
	// TurnDirection on any turn start/stop/sign flip.
	tier := u.walkTier()
	if tier != int(u.motionTier) {
		u.motionConvention().announceTier(u.binding, int(u.motionTier), tier)
		u.motionTier = uint8(tier)
	}
	u.motionConvention().announceTurn(u)

	// CURRENT_SPEED publishes in world units per SECOND: the TA:K MoveWatcher
	// loops gate their walk on `get CURRENT_SPEED > 5`, which only works on a
	// per-second scale (a swordsman's 1.1 wu/frame reads 33) — the engine's
	// own scaling of this read is UNKNOWN-4; wu/sec satisfies the verified
	// script contract.
	if p, ok := u.binding.(CobPorts); ok {
		p.SetUnitValuePort(cobPortCurrentSpeed, int32(u.loco.Speed.Mul(fxTickHz).Int()))
	}
}

// walkTier computes the unit's walk-animation tier (§7.1): tier 0 for a
// blocked slide or full rest, else 1 plus one per MoveRate threshold the
// per-frame speed strictly exceeds.
func (u *Unit) walkTier() int {
	st := &u.loco
	if st.Blocked || (st.Speed == 0 && st.Turn == 0) {
		return 0
	}
	t := 1
	if st.Speed > u.Meta.moveRate1() {
		t = 2
	}
	if st.Speed > u.Meta.moveRate2() {
		t = 3
	}
	return t
}

// stepPinnedMovement drives a unit whose motion flag is pinned by a replay
// driver (UnitStateOverride.Moving). Wire truth owns the pose, so none of the
// order-driven locomotion applies — no pathing, arrival, terrain settling or
// map clamping; the next authoritative correction re-pins whatever drifts. A
// pinned-moving unit coasts along its heading at the injected speed (the
// between-corrections interpolation) so its motion stays smooth at the wire's
// correction cadence, and the shared announceMotion fires StartMoving /
// StopMoving exactly on the flag's transitions — the walk cycle the pin
// exists to drive.
func (w *World) stepPinnedMovement(u *Unit) {
	wasMoving := u.IsMoving
	moving := u.motionPin == motionPinMoving
	u.IsMoving = moving
	if moving {
		if u.loco.Speed > 0 {
			u.loco.advance(u.loco.Speed)
		}
	} else {
		u.loco.Speed = 0
	}
	w.announceMotion(u, wasMoving)
}

// cobPortCurrentSpeed is TA:K's CURRENT_SPEED unit-value port. sim keeps its
// own copy of the number rather than importing engine/script (the dependency
// arrow points the other way); it must match script.UVCurrentSpeed.
const cobPortCurrentSpeed = 29

// cobPortHealth is TA's HEALTH unit-value port (script uvHealth). The sim
// publishes each live unit's health percent into it every tick so the
// health-polling COB loops observe real damage — most importantly SmokeUnit,
// whose `get HEALTH` gate decides when a damaged unit starts venting smoke.
// Port writes never feed the world hash (see CobPorts).
const cobPortHealth = 4

// TA unit-value ports the build cycle observes. YARD_OPEN is set by a factory's
// Activate script once its doors finish opening and gates the pad RAISE (the
// buildOpening state) so a factory does not spawn its buildee before the doors
// part. INBUILDSTANCE is set by a construction unit's StartBuilding script once
// its nano arm is deployed — it drives the arm ANIMATION only and does not gate
// build progress (the engine raises its own actively-building flag and runs the
// applicator regardless; gating on it stranded the arm's script state machine).
const (
	cobPortInBuildStance = 5
	cobPortYardOpen      = 18
)

// buildGateGraceMs caps how long the factory door cycle waits on YARD_OPEN
// before raising the pad anyway, so a script that never reports readiness (or a
// TA:K convention without the port) cannot wedge production.
const buildGateGraceMs = 3000

// portValue reads a COB unit-value port off the binding (0 without one).
func portValue(u *Unit, port int) int32 {
	if p, ok := u.binding.(CobPorts); ok {
		return p.UnitValuePort(port)
	}
	return 0
}

// TA:K setSFXoccupy states. The retail scripts only test airborne (5); the
// grounded value just needs to differ so the flight loops disengage.
//
// Ground/naval water occupation states (0 idle, 1 shallow, 2 at waterline,
// 3 submerged past waterline, 4 above water) exist in both engines, but the
// spec pins only the value list — the exact depth comparisons behind them
// are unverified, so emitting them waits on that detail rather than guessing
// a mapping the unit scripts would act on.
const (
	takOccupyLand = 1
	takOccupyAir  = 5
)

// stepAltitude lifts aircraft to cruise while they have somewhere to be and
// settles them to the ground when idle. Climb/descent rates derive from the
// FBI accel/brake, matching the JS engine.
func (w *World) stepAltitude(u *Unit) {
	hasFireOrder := false
	for i := range u.weapons {
		if u.weapons[i].hasTarget {
			hasFireOrder = true
			break
		}
	}
	airborne := u.IsMoving || hasFireOrder
	cruise := u.Meta.CruiseAltitude
	if cruise <= 0 {
		if u.Meta.IsHover {
			cruise = fixed.FromInt(60)
		} else {
			cruise = fixed.FromInt(100)
		}
	}
	// Altitude rides the terrain: cruise height is measured above the
	// ground (and a landed aircraft parks ON it, not at sea-floor zero).
	ground := w.groundHeight(u.loco.Pos)
	altTarget := ground
	if airborne {
		altTarget = ground + cruise
	}
	accel := u.Meta.Accel
	if accel <= 0 {
		accel = fixed.FromFloat(0.1)
	}
	brake := u.Meta.BrakeRate
	if brake <= 0 {
		brake = fixed.FromFloat(0.1)
	}
	climbRate := fixed.Clamp(accel.Mul(fixed.FromInt(100)), fixed.FromInt(12), fixed.FromInt(80))
	descendRate := fixed.Clamp(brake.Mul(fixed.FromInt(10)), fixed.FromInt(8), fixed.FromInt(40))
	cur := u.PosY
	rate := descendRate
	if altTarget > cur {
		rate = climbRate
	}
	step := perTick(rate)
	if (altTarget - cur).Abs() <= step {
		u.PosY = altTarget
	} else {
		u.PosY = fixed.Wrap32(cur + fixed.FromInt((altTarget - cur).Sign()).Mul(step))
	}
}

// stepWeapons runs each slot's firing cycle on the engines' shape: decrement
// the reload counter (only while the slot holds a target), resolve the aim
// point (with veteran target leading), drive the COB aim thread, then walk
// the fire gates in the engines' order — reload, range (ballistic arcs must
// solve), resources (full per-shot cost in stock or the shot blocks), aim
// latch/arc — and on success restart the scaled reload, drain the pools and
// release the shot (immediately for TA conventions; via the script's
// WEAPON_LAUNCH_NOW contact frame for TA:K).
func (w *World) stepWeapons(u *Unit) {
	for slot := range u.weapons {
		s := &u.weapons[slot]
		wm := u.Meta.Weapons[slot]
		// A committed TA:K shot waits for the fire animation's release frame
		// even if the slot's target has since cleared.
		if s.launchPending {
			w.pollWeaponLaunch(u, s, slot, wm)
		}
		if !s.hasTarget {
			continue
		}
		// Reload runs down only while the slot is targeted; a cleared slot
		// freezes its remaining count.
		if s.reloadTicks > 0 {
			s.reloadTicks--
		}
		var targetPos fixed.Vec2
		var targetY fixed.Fixed
		if s.targetUnit != 0 {
			t := w.units[s.targetUnit]
			if t == nil || t.Dead {
				w.clearWeaponSlot(u, slot)
				continue
			}
			targetPos = t.loco.Pos
			targetY = t.Pos().Y
			// Veteran target leading: from 6 kills a TA unit aims ahead of a
			// moving target by 0.8 × travel time (skipped for cruise
			// weapons, which fly a fixed dogleg).
			if u.kills >= 6 && wm.VelocityWU > 0 && t.IsMoving && t.loco.Speed > 0 {
				lead := t.loco.Pos.DistTo(u.loco.Pos).Div(wm.VelocityWU.Div(fxTickHz))
				sh, ch := fixed.SinCos(int32(t.Heading()))
				adv := t.loco.Speed.Mul(lead).Mul(fixed.FromFloat(0.8))
				targetPos.X += sh.Mul(adv)
				targetPos.Z += ch.Mul(adv)
			}
		} else {
			targetPos = fixed.Vec2{X: s.targetPt.X, Z: s.targetPt.Z}
			targetY = s.targetPt.Y
			// Ground fire aims at the terrain surface, never below it.
			if g := w.groundHeight(targetPos); targetY < g {
				targetY = g
			}
		}
		// Track the target with the turret/barrel while closing and in range, so
		// the aim animation is live before the shot resolves. aimReady reports
		// whether the aim latch holds (TA: the aim thread returned TRUE; TA:K:
		// the script wrote WEAPON_READY); fire waits on it.
		aimReady := w.aimWeapon(u, s, slot, targetPos, targetY)
		// Body-aimed units (TA:K ground units, which have no turret scripts)
		// additionally pivot the whole unit toward the target and hold fire
		// until the body bears.
		if conventionFor(u.binding).bodyAim(u.Meta) && !w.faceWeaponTarget(u, targetPos) {
			aimReady = false
		}
		rngF := engageRange(wm)
		if rngF <= 0 {
			rngF = fixed.FromInt(180)
		}
		// Range: planar distance only — altitude never extends or shrinks it.
		if u.loco.Pos.DistTo(targetPos) > rngF {
			continue
		}
		anchor := u.Pos()
		anchor.Y += muzzleAimHeight
		// A ballistic weapon may only fire when the gravity arc to the aim
		// point solves (the unsolvable case is treated as out of range).
		if wm.Ballistic && wm.VelocityWU > 0 {
			d := targetPos.Sub(u.loco.Pos)
			if _, _, ok := solveBallisticLaunch(d.Len().Float(), (anchor.Y - targetY).Float(),
				wm.VelocityWU.Float(), w.gravity.Float(), wm.MinBarrelSin); !ok {
				continue
			}
		}
		// Resource gate: the FULL per-shot cost must be in stock before the
		// shot; the drain happens after launch, all-or-nothing, never
		// partial. Only TA bills the player pools per shot — TA:K pays a
		// weapon's ManaPerShot out of the unit's private caster mana (not
		// modelled here), so its player pool never gates fire.
		if w.econModel == EconomyTA && (wm.EnergyShot > 0 || wm.MetalShot > 0) {
			if !w.taCanAffordShot(u.Side, float32(wm.EnergyShot.Float()), float32(wm.MetalShot.Float())) {
				continue
			}
		}
		// Aircraft must have the airframe lined up within the weapon's firing arc
		// before they open fire (no rotating turret); and a bomber only starts a
		// run once it is inside the drop window so the string straddles the target.
		if !u.withinFireArc(wm, targetPos) {
			continue
		}
		if !u.inBombDropWindow(slot, wm, targetPos) {
			continue
		}
		if !aimReady {
			continue
		}
		if s.reloadTicks > 0 || s.launchPending {
			continue
		}
		// Melee swing pacing: while engaged, each tick rolls the shared
		// stream and only a zero starts the swing — the RNG cadence layered
		// on top of the reload interval.
		if wm.Melee && w.rng.Bounded(3) != 0 {
			continue
		}
		s.lastFireMs = w.simMs
		s.reloadTicks = scaledReloadTicks(u, &wm)
		// Per-shot economy drain (energypershot / metalpershot), after the
		// launch commitment: all-or-nothing straight from the TA pools,
		// bypassing the settle. The gate above already confirmed the stock.
		if w.econModel == EconomyTA && (wm.EnergyShot > 0 || wm.MetalShot > 0) {
			e, m := float32(wm.EnergyShot.Float()), float32(wm.MetalShot.Float())
			if w.taConsumeShot(u.Side, e, m) {
				w.tallySpend(u.Side, float64(m), float64(e), 0)
			}
		}
		aimPoint := fixed.Vec3{X: targetPos.X, Y: targetY, Z: targetPos.Z}
		// Recoil / muzzle-flash animation: the COB Fire thread moves the barrel
		// and emits its own muzzle SFX, which DrainEffects folds into the render
		// stream. It self-terminates, so a plain Start (no supersede) is right.
		// Run it before the query so a script that cycles its barrel from the Fire
		// thread has toggled by the time Query reports the muzzle, matching TA.
		takLaunch := false
		if u.binding != nil {
			conv := conventionFor(u.binding)
			if name := conv.fireScript(slot); name != "" && u.binding.HasScript(name) {
				u.binding.Start(name, conv.fireArgs(slot)...)
				// TA:K's shot releases when the fire animation writes
				// WEAPON_LAUNCH_NOW at its contact frame; TA launches now.
				if _, ok := u.binding.(takLaunchBinding); ok && conv.fireScript(slot) == "FireWeapon" {
					takLaunch = true
				}
			}
		}
		fromPiece := w.queryFirePiece(u, slot)
		w.emit(frame.Event{Kind: frame.EvFire, UnitID: u.ID, Slot: slot, TargetID: s.targetUnit, Anchor: anchor, Target: aimPoint, FromPiece: fromPiece, Weapon: wm.Name})
		if takLaunch {
			s.launchPending = true
			s.launchTarget = aimPoint
			s.launchTargetID = s.targetUnit
		} else {
			w.releaseShot(u, slot, wm, anchor, aimPoint, s.targetUnit, fromPiece)
		}
		// A command-fire weapon (the D-gun) discharges exactly once per
		// explicit order: release the slot so it never repeats on reload.
		if wm.CommandFire {
			w.clearWeaponSlot(u, slot)
			continue
		}
		// Bomb-run bookkeeping for an aircraft's dropped weapon. The first shot
		// snapshots the aim point + total bomb count so subsequent shots keep
		// dropping at the cached point — even if the player issues Move (the
		// bomb-and-bail tactic). The slot is rebound to that point so target death
		// or clearance can't drift the run mid-flight, while lastFireMs and the aim
		// thread are preserved so the reload cadence holds.
		if wm.Dropped && u.Meta.IsAircraft {
			if !u.bombRunActive {
				bombs, _ := bombRunGeometry(u.loco.Speed.Mul(fxTickHz), wm)
				src := s.source
				if src == "" {
					src = "attack"
				}
				pt := s.targetPt
				if s.targetUnit != 0 {
					if t := w.units[s.targetUnit]; t != nil {
						pt = t.Pos()
					}
					// Re-aim the slot at the cached point so the run's range / arc /
					// drop-window gates evaluate against the locked spot.
					s.targetUnit = 0
					s.targetPt = pt
				}
				u.bombRunActive = true
				u.bombRunSlot = slot
				u.bombRunPoint = pt
				u.bombRunLeft = bombs
				u.bombRunSource = src
			}
			if u.bombRunActive && u.bombRunSlot == slot {
				u.bombRunLeft--
				if u.bombRunLeft <= 0 {
					src := u.bombRunSource
					u.bombRunActive = false
					// A force-fire (manual) run is a sticky patrol-and-bomb order —
					// leave the slot armed so the bomber loops back and lays another
					// string. An autonomous attack run releases the slot so stepAttack
					// can re-engage (the prey may be dead, hiding, or out of reach).
					if src != "manual" {
						w.clearWeaponSlot(u, slot)
					}
				}
			}
		}
		// A manual shot at a specific unit is a one-shot order: clear it after
		// firing (single-burst weapons). Force-firing at a ground point persists
		// at the reload cadence until the player issues a new fire or stop order.
		if s.source == "manual" && s.targetUnit != 0 && wm.Burst <= 1 {
			w.clearWeaponSlot(u, slot)
		}
	}
}

// engageRange is a weapon's effective engagement distance. Melee carries the
// engine's tile-quantised floor: the swing-range check works on 16-wu tile
// coordinates with a minimum of two tiles, so contact reaches to 32 wu of
// centre distance even when the TDF range is shorter — which is also what
// lets two colliding bodies (whose separation floor exceeds the raw range)
// come to blows at all.
func engageRange(wm WeaponMeta) fixed.Fixed {
	r := wm.Range
	if wm.Melee {
		r = fixed.Max(r, fixed.FromInt(32))
	}
	return r
}

// takLaunchBinding is the optional script surface for TA:K's fire-release
// handshake: the attack animation writes the weapon index into the
// WEAPON_LAUNCH_NOW port at its contact frame, and the weapon machine
// consumes it here to actually let the shot go.
type takLaunchBinding interface {
	TakeWeaponLaunchNow(slot int) bool
}

// pollWeaponLaunch waits out a committed TA:K shot's fire animation and
// releases it — projectile spawn, or melee contact damage — when the script
// signals the contact frame. There is no timeout: a script that never writes
// the port never releases the shot, exactly the engine's contract (every
// retail attack script writes it).
func (w *World) pollWeaponLaunch(u *Unit, s *weaponSlot, slot int, wm WeaponMeta) {
	lb, ok := u.binding.(takLaunchBinding)
	if !ok {
		// Binding cannot signal a release frame — degrade to an immediate
		// launch so scriptless TA:K units still fight.
		s.launchPending = false
		anchor := u.Pos()
		anchor.Y += muzzleAimHeight
		w.releaseShot(u, slot, wm, anchor, s.launchTarget, s.launchTargetID, -1)
		return
	}
	if !lb.TakeWeaponLaunchNow(slot) {
		return
	}
	s.launchPending = false
	anchor := u.Pos()
	anchor.Y += muzzleAimHeight
	target := s.launchTarget
	targetID := s.launchTargetID
	// Contact lands at the victim's CURRENT position when it is still alive
	// — the swing follows the brawl.
	if targetID != 0 {
		if t := w.units[targetID]; t != nil && !t.Dead {
			target = t.Pos()
		}
	}
	w.releaseShot(u, slot, wm, anchor, target, targetID, -1)
}

// releaseShot lets one committed shot go: instant behaviors (TA:K melee and
// the effect emitters) resolve through the detonation path at the aim point
// with nothing ever in flight; everything else spawns a projectile — a
// static burst parent when the weapon bursts, the flying shot itself
// otherwise. Turret accuracy scatter draws happen here, bearing then pitch,
// on the shared sim stream (each skipped without a draw when the spread
// bound is below 2 — at full health an accuracy-0 turret shoots true).
func (w *World) releaseShot(u *Unit, slot int, wm WeaponMeta, anchor, aimPoint fixed.Vec3, targetID uint32, fromPiece int32) {
	if wm.Instant {
		w.detonateWeapon(u.ID, targetID, &wm, aimPoint)
		return
	}
	if wm.Turret {
		if spread := turretSpread(u, &wm); spread >= 2 {
			db := w.rng.Bounded(spread) - spread/2
			dp := w.rng.Bounded(spread) - spread/2
			aimPoint = scatterAim(anchor, aimPoint, db, dp)
		}
	}
	if wm.Burst > 1 {
		// Static invisible parent at the muzzle: it emits one flying pellet
		// every burstrate ticks (the first a full interval after launch).
		gap := wm.BurstRateTicks
		if gap < 1 {
			gap = 1
		}
		parent := w.makeProjectile(u.ID, targetID, slot, wm, anchor, aimPoint, int(fromPiece))
		w.nextProjID++
		parent.mode = projBurstParent
		parent.burstLeft = wm.Burst
		parent.burstGap = gap
		parent.burstSince = 0
		w.projectiles = append(w.projectiles, parent)
		return
	}
	p := w.makeProjectile(u.ID, targetID, slot, wm, anchor, aimPoint, int(fromPiece))
	w.nextProjID++
	w.projectiles = append(w.projectiles, p)
	w.emit(frame.Event{Kind: frame.EvProjectileSpawn, UnitID: u.ID, Slot: slot, TargetID: targetID, Anchor: anchor, Weapon: wm.Name})
}

// scatterAim rebuilds an aim point after angular jitter: the bearing and
// pitch from the muzzle to the original point each shift by their draw, and
// the point re-projects at the original 3-D distance.
func scatterAim(anchor, aim fixed.Vec3, dBearing, dPitch int32) fixed.Vec3 {
	dx := aim.X - anchor.X
	dy := aim.Y - anchor.Y
	dz := aim.Z - anchor.Z
	horiz := fixed.Hypot(dx, dz)
	dist := fixed.Hypot(horiz, dy)
	if dist <= 0 {
		return aim
	}
	bearing := fixed.Atan2(dx, dz) + dBearing
	pitch := fixed.Atan2(dy, horiz) + dPitch
	sb, cb := fixed.SinCos(fixed.NormalizeAngle(bearing))
	sp, cp := fixed.SinCos(fixed.NormalizeAngle(pitch))
	h := cp.Mul(dist)
	return fixed.Vec3{
		X: anchor.X + sb.Mul(h),
		Y: anchor.Y + sp.Mul(dist),
		Z: anchor.Z + cb.Mul(h),
	}
}

// muzzleAimHeight lifts the aim origin off the unit's footprint so the pitch to
// a same-height target is ~0 rather than aiming up from the ground; it matches
// the fire-event anchor offset.
var muzzleAimHeight = fixed.FromInt(12)

// aimReissueArc is how far (in TA-angle units, ~2.8 degrees) the bearing to the
// target must drift before the world re-drives the aim thread. Below it the
// settled aim thread is left running so the turret holds steady.
const aimReissueArc int32 = 512

// aimRefreshMs is how often the world re-issues a settled aim thread even when
// the bearing has not drifted. It must be shorter than the unit scripts' usual
// restore-after-delay (TA's RestoreAfterDelay sleeps ~3s) so that re-calling
// AimWeapon keeps killing and restarting that restore thread, holding the
// turret on target instead of letting it drift back to its home pose.
const aimRefreshMs int64 = 1000

// bodyAimArc is how far (TA-angle units, ~10 degrees) a body-aimed unit's
// heading may be off the target bearing and still fire. Body-aimed units
// carry no turret aim scripts — the engine pivots the whole unit — so the
// gate is deliberately lenient: the projectile already launches at the
// target, the pivot is what makes the unit visibly point where it shoots.
const bodyAimArc int32 = 1820

// faceWeaponTarget pivots a stationary unit's body toward the target bearing
// at its FBI turn rate, reporting whether the heading is within bodyAimArc.
// A unit that is walking leaves steering to locomotion — it keeps driving
// toward its move goal — but the facing gate still applies: a body-aimed
// weapon must never fire sideways mid-stride, only when the walk happens to
// point the body at the target.
func (w *World) faceWeaponTarget(u *Unit, targetPos fixed.Vec2) bool {
	d := targetPos.Sub(u.loco.Pos)
	want := fixed.FromInt(int(fixed.Atan2(d.X, d.Z)))
	if !u.IsMoving {
		dh := shortestArcFx(want - u.loco.Heading)
		turnStep := fixed.FromInt(int(w.turnPerFrame(u)))
		if turnStep > 0 && dh.Abs() > turnStep {
			u.loco.setHeading(u.loco.Heading + fixed.FromInt(dh.Sign()).Mul(turnStep))
		} else {
			u.loco.setHeading(want)
		}
	}
	dh := shortestArcFx(want - u.loco.Heading)
	return dh.Abs() <= fixed.FromInt(int(bodyAimArc))
}

// clearWeaponSlot resets a weapon slot and, when the slot was tracking a
// target and the unit's script defines TargetCleared (the TA:K handler that
// aborts the aim loop and restores the turret pose), notifies it with the
// weapon index. TA scripts have no TargetCleared, so this degrades to a plain
// reset for them.
func (w *World) clearWeaponSlot(u *Unit, slot int) {
	s := &u.weapons[slot]
	hadTarget := s.hasTarget
	// The reload countdown and any committed-but-unreleased shot are SLOT
	// state, not target state: clearing the target freezes the remaining
	// reload (it resumes against the next target) and a swing already past
	// its fire commitment still lands at its contact frame.
	*s = weaponSlot{
		reloadTicks:    s.reloadTicks,
		launchPending:  s.launchPending,
		launchTarget:   s.launchTarget,
		launchTargetID: s.launchTargetID,
	}
	if hadTarget && u.binding != nil && u.binding.HasScript("TargetCleared") {
		u.binding.Start("TargetCleared", slot)
	}
}

// queryFirePiece runs the slot's Query<slot> script to find the piece the shot
// exits from, returning its index into the unit's piece-name table. It returns
// -1 when the unit has no binding or no Query script (the renderer then anchors
// the shot at the unit centre). The query is synchronous and advances any
// per-barrel cycle the script maintains, so successive shots from a multi-barrel
// weapon report alternating muzzles.
func (w *World) queryFirePiece(u *Unit, slot int) int32 {
	if u.binding == nil {
		return -1
	}
	conv := conventionFor(u.binding)
	name := conv.queryScript(slot)
	if name == "" || !u.binding.HasScript(name) {
		return -1
	}
	qb, ok := u.binding.(queryBinding)
	if !ok {
		return -1
	}
	if piece, ok := qb.RunQuery(name, conv.queryArgs(slot)...); ok {
		return piece
	}
	return -1
}

// aimWeapon re-drives the slot's COB aim thread so the turret and barrel track
// the target, and reports whether the turret has turned far enough to fire.
// Heading is the bearing to the target relative to the unit's facing and pitch
// its elevation, both as TA-angle units — the (heading, pitch) the AimWeapon
// scripts expect. Positive bearings and positive y-axis piece turns rotate the
// same way (see aimBearing), so no sign fix-up happens here; the renderer's
// piece transform applies the matching rotation. It re-issues only when the
// bearing has drifted past aimReissueArc, letting the same-name supersede swap
// the tracking thread without piling up stale instances.
//
// Fire is gated on the aim thread's completion: a turret with an AimWeapon
// script does not fire until that thread returns TRUE — the latch is
// absolute, with no fire-anyway fallback. A unit with no aim script — or a
// binding that can't report aim status — fires as soon as it is in range.
func (w *World) aimWeapon(u *Unit, s *weaponSlot, slot int, targetPos fixed.Vec2, targetY fixed.Fixed) bool {
	if u.binding == nil {
		return true
	}
	conv := conventionFor(u.binding)
	name := conv.aimScript(slot)
	if name == "" || !u.binding.HasScript(name) {
		return true
	}
	ab, ok := u.binding.(aimBinding)
	if !ok {
		// Binding can drive scripts but can't report aim completion: re-drive on
		// drift and let the weapon fire when in range.
		w.driveAimDrift(u, s, slot, name, targetPos, targetY)
		return true
	}
	d := targetPos.Sub(u.loco.Pos)
	heading := aimBearing(u, targetPos)
	pitch := fixed.ShortestArc(fixed.Atan2(targetY-(u.PosY+muzzleAimHeight), d.Len()))
	drifted := !s.aimIssued ||
		absAngle(heading-s.aimHeading) >= aimReissueArc ||
		absAngle(pitch-s.aimPitch) >= aimReissueArc
	// Re-drive the aim thread on drift, or on a steady cadence so the unit's COB
	// restore-after-delay thread never returns the turret home while a target is
	// still tracked. A cadence refresh keeps the same bearing, so it must not
	// re-gate fire — only an actual drift re-arms aimReady.
	refreshDue := w.simMs-s.aimLastIssueMs >= aimRefreshMs
	if drifted || refreshDue {
		s.aimIssued = true
		s.aimHeading = heading
		s.aimPitch = pitch
		s.aimLastIssueMs = w.simMs
		if drifted {
			s.aimReady = false
			s.aimStartMs = w.simMs
		}
		s.aimThread = ab.StartAim(name, conv.aimArgs(heading, pitch, slot)...)
	}
	// Consume the convention's aim-completion signal: TA reads the thread's
	// return value, TA:K the WEAPON_READY / WEAPON_AIM_ABORTED ports. The
	// latch is absolute — a script that never signals a held aim never
	// fires; there is no fire-anyway fallback (the periodic re-issue above
	// keeps offering the thread fresh angles, so a transient FALSE recovers
	// on a later pass).
	conv.pollAimReady(u.binding, ab, s, slot, w.simMs)
	return s.aimReady
}

// driveAimDrift re-issues the aim thread on drift via the plain Restart surface,
// for bindings that don't implement aimBinding (the world still wants the turret
// to track even when it can't await completion).
func (w *World) driveAimDrift(u *Unit, s *weaponSlot, slot int, name string, targetPos fixed.Vec2, targetY fixed.Fixed) {
	d := targetPos.Sub(u.loco.Pos)
	heading := aimBearing(u, targetPos)
	pitch := fixed.ShortestArc(fixed.Atan2(targetY-(u.PosY+muzzleAimHeight), d.Len()))
	settled := s.aimIssued &&
		absAngle(heading-s.aimHeading) < aimReissueArc &&
		absAngle(pitch-s.aimPitch) < aimReissueArc
	// Hold a settled aim, but still refresh on the cadence so the COB restore
	// thread can't drift the turret home while the target is tracked.
	if settled && w.simMs-s.aimLastIssueMs < aimRefreshMs {
		return
	}
	s.aimIssued = true
	s.aimHeading = heading
	s.aimPitch = pitch
	s.aimLastIssueMs = w.simMs
	u.binding.Restart(name, conventionFor(u.binding).aimArgs(heading, pitch, slot)...)
}

// aimBearing is the bearing argument a COB aim/build thread receives: the
// shortest signed arc from the unit's facing to the target, in TA-angle
// units. Positive values turn the same way as an increasing heading, which is
// the direction a positive y-axis TURN slews a piece — so a script that turns
// its torso "to y-axis heading" points it at the target.
func aimBearing(u *Unit, targetPos fixed.Vec2) int32 {
	d := targetPos.Sub(u.loco.Pos)
	return fixed.ShortestArc(fixed.Atan2(d.X, d.Z) - u.Heading())
}

// absAngle is the absolute value of a TA-angle delta.
func absAngle(a int32) int32 {
	if a < 0 {
		return -a
	}
	return a
}
