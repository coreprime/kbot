package sim

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
)

const (
	// TickHz is the simulation rate; one tick is 25ms, matching TA's loop.
	TickHz = 40
	// TickMs is the millisecond duration of a single tick.
	TickMs = 1000 / TickHz
)

// dtSec is the fixed per-tick time step in seconds (0.025).
var dtSec = fixed.FromInt(TickMs).Div(fixed.FromInt(1000))

// defaultHitDamage matches the JS engine's constant for weapons whose TDF
// damage field has not been wired through yet.
var defaultHitDamage = fixed.FromInt(12)

// Runtime is the optional COB script VM the world advances each tick before
// movement, mirroring game-engine.js which ticks the runtime first.
type Runtime interface {
	Tick(ms int64)
}

// Step advances the simulation exactly one fixed tick. It is the only time
// source the world has; callers must invoke it once per TickMs.
func (w *World) Step(rt Runtime) {
	w.tick++
	w.simMs += TickMs
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
		}
	}
	for _, id := range w.order {
		u := w.units[id]
		if u == nil || u.Dead {
			continue
		}
		// A buildee under construction is inert until it reaches 100%: no
		// orders bind to it, and it steps neither movement nor weapons.
		if u.underConstruction() {
			continue
		}
		w.stepBuilder(u)
		w.stepAttack(u)
		w.stepMovement(u)
		w.stepWeapons(u)
	}
	w.stepCollisions()
	w.stepProjectiles()
}

// buildSinkWU is how far a buildee starts below grade: it rises out of the
// ground as its build percentage climbs, the sim-side visual of construction.
var buildSinkWU = fixed.FromInt(10)

// stepBuilder advances a mobile builder's construction job: walk to within
// builddistance of the site, spawn the buildee at 0%, then raise its build
// percentage at the TA rate (buildee buildtime points / builder workertime
// points-per-second) until it is complete and commandable.
func (w *World) stepBuilder(u *Unit) {
	switch u.buildState {
	case buildIdle:
		return
	case buildApproach:
		dist := u.loco.Pos.DistTo(u.buildSite)
		bd := u.Meta.BuildDistance
		if bd <= 0 {
			bd = fixed.FromInt(50)
		}
		if dist > bd {
			u.hasMove = true
			u.moveTarget = u.buildSite
			return
		}
		u.hasMove = false
		if w.spawn == nil {
			u.buildState = buildIdle
			return
		}
		meta, binding := w.spawn(u.buildName)
		if meta == nil {
			u.buildState = buildIdle
			return
		}
		// Spawn the buildee at 0% facing the builder's heading and sunk below
		// grade; it rises as the build progresses.
		id := w.AddUnit(u.buildName, meta, binding, u.buildSite, u.Heading(), u.Side)
		b := w.units[id]
		b.BuildPercent = 0
		b.PosY = -buildSinkWU
		u.buildeeID = id
		u.buildState = buildRaising
		if u.binding != nil && u.binding.HasScript("StartBuilding") {
			u.binding.Start("StartBuilding")
		}
		site := fixed.Vec3{X: u.buildSite.X, Z: u.buildSite.Z}
		w.emit(frame.Event{Kind: frame.EvBuildStart, UnitID: u.ID, TargetID: id, Anchor: site})
	case buildRaising:
		b := w.units[u.buildeeID]
		if b == nil || b.Dead {
			w.cancelBuild(u)
			return
		}
		// Percent per tick: 100% over (buildee buildtime / builder workertime)
		// seconds, the TA pacing. Missing data falls back to 8 seconds.
		bt := b.Meta.BuildTime
		wt := u.Meta.WorkerTime
		durSec := fixed.FromInt(8)
		if bt > 0 && wt > 0 {
			durSec = fixed.Clamp(bt.Div(fixed.FromInt(wt)), fixed.FromInt(2), fixed.FromInt(60))
		}
		b.BuildPercent += fixed.FromInt(100).Div(durSec.Mul(fixed.FromInt(TickHz)))
		if b.BuildPercent < fixed.FromInt(100) {
			if !b.Meta.IsAircraft {
				b.PosY = -buildSinkWU.Mul(fixed.FromInt(100) - b.BuildPercent).Div(fixed.FromInt(100))
			}
			return
		}
		b.BuildPercent = fixed.FromInt(100)
		if !b.Meta.IsAircraft {
			b.PosY = 0
		}
		if u.binding != nil && u.binding.HasScript("StopBuilding") {
			u.binding.Start("StopBuilding")
		}
		w.emit(frame.Event{Kind: frame.EvBuildStop, UnitID: u.ID, TargetID: b.ID, Anchor: b.Pos()})
		u.buildState = buildIdle
		u.buildName = ""
		u.buildeeID = 0
	}
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

// stepProjectiles advances every in-flight model weapon one tick, refreshes a
// guided shot's aim at its live target, and detonates the ones that arrive or
// expire this tick.
func (w *World) stepProjectiles() {
	if len(w.projectiles) == 0 {
		return
	}
	alive := w.projectiles[:0]
	for _, p := range w.projectiles {
		if p.targetID != 0 {
			if t := w.units[p.targetID]; t != nil && !t.Dead {
				p.target = t.Pos()
			}
		}
		p.stepProjectile(fixed.Zero)
		if p.dead {
			w.detonate(p)
			continue
		}
		alive = append(alive, p)
	}
	w.projectiles = alive
}

// detonate emits the projectile's hit event and, if it actually reached its
// target (rather than timing out), applies damage — to everything inside the
// blast radius for an area weapon, or to the single target otherwise.
func (w *World) detonate(p *projectile) {
	w.emit(frame.Event{Kind: frame.EvProjectileHit, UnitID: p.ownerID, Slot: p.slot, TargetID: p.targetID, Anchor: p.pos, Weapon: p.weapon})
	if !p.hit {
		return
	}
	if p.aoe > 0 {
		r := p.aoe.Div(fixed.FromInt(2)) // diameter -> radius
		center := fixed.Vec2{X: p.pos.X, Z: p.pos.Z}
		for _, id := range w.order {
			t := w.units[id]
			if t == nil || t.Dead {
				continue
			}
			if t.loco.Pos.DistTo(center) <= r {
				w.ApplyDamage(p.ownerID, id, p.damage)
			}
		}
		return
	}
	if p.targetID != 0 {
		w.ApplyDamage(p.ownerID, p.targetID, p.damage)
	}
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
	rngF := u.Meta.Weapons[0].Range
	if rngF <= 0 {
		rngF = fixed.FromInt(220)
	}
	dist := u.loco.Pos.DistTo(t.loco.Pos)
	if dist > rngF {
		// Out of range — chase the prey's current position and drop slot 0 so the
		// SM doesn't burn aim threads while we walk.
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
	s := &u.weapons[0]
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
		_, halfRun := bombRunGeometry(u.loco.Speed, wm)
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
	u.attackManeuver(ex, ez, rngF, dtSec, bomberMode, passthrough)
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
	_, halfRun := bombRunGeometry(u.loco.Speed, wm)
	return u.loco.Pos.DistTo(targetPos) <= halfRun
}

// stepMovement integrates one tick of locomotion plus aircraft altitude and
// emits move-start/move-stop. Ported from game-engine.js #stepMovement.
func (w *World) stepMovement(u *Unit) {
	wasMoving := u.IsMoving
	if u.hasMove && u.Meta.CanMove {
		// Steer toward the avoidance target — the real destination, or a
		// tangent point beside a unit blocking the path. Arrival only counts
		// against the REAL target; touching a detour point just keeps driving
		// (the detour is recomputed from the live field every tick).
		steer := w.avoidanceTarget(u)
		arrived, moving := stepSurfaceLocomotion(&u.loco, steer, u.Meta, dtSec)
		u.IsMoving = moving
		if arrived && steer != u.moveTarget {
			u.IsMoving = true
		} else if arrived {
			u.hasMove = false
			u.IsMoving = false
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
	} else {
		u.IsMoving = false
		u.loco.Speed = 0
	}

	if u.Meta.IsAircraft {
		w.stepAltitude(u)
	}

	if u.IsMoving && !wasMoving {
		if u.binding != nil && u.binding.HasScript("StartMoving") {
			u.binding.Start("StartMoving")
		}
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
		if u.binding != nil && u.binding.HasScript("StopMoving") {
			u.binding.Start("StopMoving")
		}
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

	// TA:K units have no StartMoving/StopMoving: their MoveWatcher loop polls
	// the CURRENT_SPEED port to switch the walk gait on and off. Publish the
	// unit's speed (world units/sec) so those loops observe real motion; the
	// scripts gate on small thresholds (> 5), which a walking unit clears by
	// an order of magnitude.
	if p, ok := u.binding.(CobPorts); ok {
		p.SetUnitValuePort(cobPortCurrentSpeed, int32(u.loco.Speed.Int()))
	}
}

// cobPortCurrentSpeed is TA:K's CURRENT_SPEED unit-value port. sim keeps its
// own copy of the number rather than importing engine/script (the dependency
// arrow points the other way); it must match script.UVCurrentSpeed.
const cobPortCurrentSpeed = 29

// TA:K setSFXoccupy states. The retail scripts only test airborne (5); the
// grounded value just needs to differ so the flight loops disengage.
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
	altTarget := fixed.Zero
	if airborne {
		altTarget = cruise
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
	step := rate.Mul(dtSec)
	if (altTarget - cur).Abs() <= step {
		u.PosY = altTarget
	} else {
		u.PosY = cur + fixed.FromInt((altTarget - cur).Sign()).Mul(step)
	}
}

// stepWeapons runs each slot's fire cadence: in range + reloaded -> fire and
// apply damage. It also drives each slot's COB aim thread so turrets track and
// barrels recoil; the script effects are render-only and never feed the hash,
// so they stay deterministic as long as every client issues the same calls.
func (w *World) stepWeapons(u *Unit) {
	for slot := range u.weapons {
		s := &u.weapons[slot]
		if !s.hasTarget {
			continue
		}
		wm := u.Meta.Weapons[slot]
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
		} else {
			targetPos = fixed.Vec2{X: s.targetPt.X, Z: s.targetPt.Z}
			targetY = s.targetPt.Y
		}
		reload := int64(wm.ReloadMs)
		if reload <= 0 {
			reload = 750
		}
		// Track the target with the turret/barrel while closing and in range, so
		// the aim animation is live before the shot resolves. aimReady reports
		// whether the turret has actually turned to bear; fire waits on it.
		aimReady := w.aimWeapon(u, s, slot, targetPos, targetY, reload)
		// Body-aimed units (TA:K ground units, which have no turret scripts)
		// additionally pivot the whole unit toward the target and hold fire
		// until the body bears.
		if conventionFor(u.binding).bodyAim(u.Meta) && !w.faceWeaponTarget(u, targetPos) {
			aimReady = false
		}
		rngF := wm.Range
		if rngF <= 0 {
			rngF = fixed.FromInt(180)
		}
		if u.loco.Pos.DistTo(targetPos) > rngF {
			continue
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
		if w.simMs < s.lastFireMs+reload {
			continue
		}
		s.lastFireMs = w.simMs
		anchor := u.Pos()
		anchor.Y += fixed.FromInt(12)
		aimPoint := fixed.Vec3{X: targetPos.X, Y: targetY, Z: targetPos.Z}
		// Recoil / muzzle-flash animation: the COB Fire thread moves the barrel
		// and emits its own muzzle SFX, which DrainEffects folds into the render
		// stream. It self-terminates, so a plain Start (no supersede) is right.
		// Run it before the query so a script that cycles its barrel from the Fire
		// thread has toggled by the time Query reports the muzzle, matching TA.
		if u.binding != nil {
			conv := conventionFor(u.binding)
			if name := conv.fireScript(slot); name != "" && u.binding.HasScript(name) {
				u.binding.Start(name, conv.fireArgs(slot)...)
			}
		}
		// Resolve which piece the shot exits from via the Query<slot> script. The
		// sim has no geometry, so it forwards the piece index and the renderer
		// computes the muzzle world position; running the query also advances any
		// per-barrel cycle so multi-barrel weapons alternate muzzles.
		fromPiece := w.queryFirePiece(u, slot)
		w.emit(frame.Event{Kind: frame.EvFire, UnitID: u.ID, Slot: slot, TargetID: s.targetUnit, Anchor: anchor, Target: aimPoint, FromPiece: fromPiece, Weapon: wm.Name})
		if wm.flies() {
			// Every non-beam weapon flies a tracked projectile and resolves damage
			// on detonation; the flight is stepped in stepProjectiles. Model
			// missiles draw a 3DO mesh, model-less cannon/EMG shots fly the same
			// path invisibly server-side (the client paints their tracer vfx). A
			// shot that exists as authoritative state survives a join/restore.
			target3 := fixed.Vec3{X: targetPos.X, Z: targetPos.Z}
			if s.targetUnit != 0 {
				if t := w.units[s.targetUnit]; t != nil {
					target3.Y = t.Pos().Y
				}
			} else {
				target3.Y = s.targetPt.Y
			}
			p := w.makeProjectile(u.ID, s.targetUnit, slot, wm, anchor, target3, int(fromPiece))
			w.nextProjID++
			w.projectiles = append(w.projectiles, p)
			w.emit(frame.Event{Kind: frame.EvProjectileSpawn, UnitID: u.ID, Slot: slot, TargetID: s.targetUnit, Anchor: anchor, Weapon: wm.Name})
		} else if s.targetUnit != 0 {
			// Instant-hit beam (laser): resolve damage now; nothing flies.
			dmg := wm.Damage
			if dmg <= 0 {
				dmg = defaultHitDamage
			}
			w.ApplyDamage(u.ID, s.targetUnit, dmg)
		}
		// Bomb-run bookkeeping for an aircraft's dropped weapon. The first shot
		// snapshots the aim point + total bomb count so subsequent shots keep
		// dropping at the cached point — even if the player issues Move (the
		// bomb-and-bail tactic). The slot is rebound to that point so target death
		// or clearance can't drift the run mid-flight, while lastFireMs and the aim
		// thread are preserved so the reload cadence holds.
		if wm.Dropped && u.Meta.IsAircraft {
			if !u.bombRunActive {
				bombs, _ := bombRunGeometry(u.loco.Speed, wm)
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
		turnStep := u.Meta.turnRatePerSec().Mul(dtSec)
		if dh.Abs() > turnStep {
			u.loco.Heading += fixed.FromInt(dh.Sign()).Mul(turnStep)
		} else {
			u.loco.Heading = want
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
	*s = weaponSlot{}
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
// scripts expect. The heading is negated to match the render pipeline, which
// applies the inverse Y rotation (rot[1] = -ry) when it draws the turret; the
// original JS engine negated it for the same reason. It re-issues only when the
// bearing has drifted past aimReissueArc, letting the same-name supersede swap
// the tracking thread without piling up stale instances.
//
// Fire is gated on the aim thread's completion: a turret with an AimWeapon
// script does not fire until that thread returns TRUE (or the stuck-timeout of
// 2x reload elapses, so a script that never signals completion can't deadlock
// the weapon). A unit with no aim script — or a binding that can't report aim
// status — fires as soon as it is in range, as before.
func (w *World) aimWeapon(u *Unit, s *weaponSlot, slot int, targetPos fixed.Vec2, targetY fixed.Fixed, reloadMs int64) bool {
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
	heading := -fixed.ShortestArc(fixed.Atan2(d.X, d.Z) - u.Heading())
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
	// return value, TA:K the WEAPON_READY / WEAPON_AIM_ABORTED ports.
	conv.pollAimReady(u.binding, ab, s, slot, w.simMs)
	if !s.aimReady && w.simMs-s.aimStartMs >= 2*reloadMs {
		// The aim thread never reported completion within twice the reload
		// window; fire anyway rather than stalling the weapon indefinitely.
		s.aimReady = true
	}
	return s.aimReady
}

// driveAimDrift re-issues the aim thread on drift via the plain Restart surface,
// for bindings that don't implement aimBinding (the world still wants the turret
// to track even when it can't await completion).
func (w *World) driveAimDrift(u *Unit, s *weaponSlot, slot int, name string, targetPos fixed.Vec2, targetY fixed.Fixed) {
	d := targetPos.Sub(u.loco.Pos)
	heading := -fixed.ShortestArc(fixed.Atan2(d.X, d.Z) - u.Heading())
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

// absAngle is the absolute value of a TA-angle delta.
func absAngle(a int32) int32 {
	if a < 0 {
		return -a
	}
	return a
}
