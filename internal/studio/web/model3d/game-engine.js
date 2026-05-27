// game-engine.js
//
// Headless simulation core for the studio's playable surfaces.  Owns:
//
//   - A CobRuntime (the bytecode VM that drives every unit's COB
//     scripts in lock-step at TA's 40 Hz tick rate).
//   - A Map of live UnitInstance records (position, heading, health,
//     move/attack targets, FBI metadata, COB binding, per-slot weapon
//     state machine).
//   - A per-tick simulation pass that resolves attack state, advances
//     movement (turn-rate + walk), drives the per-slot weapon state
//     machine (aim thread lifecycle + reload cadence + burst cycling),
//     edge-triggers StartMoving / StopMoving, and applies hit-scan
//     damage on each shot.
//   - An event bus.  When the simulation needs the rendering layer to
//     draw something — fire a projectile, play a death puff — it emits
//     an event.  Subscribers (the host view) translate events into
//     particle / audio / animation calls.
//
// The engine is INTENTIONALLY headless: no DOM, no WebGL, no
// dependency on the camera / renderer / particle pool.  That keeps it
// instanceable (each tab can have its own GameEngine) and makes the
// rendering layer pluggable — a future headless test harness or
// AI-vs-AI replay tool can construct a GameEngine without ever loading
// the renderer.
//
// Weapon state machine:
//
//   Each unit gets three per-slot records (primary/secondary/tertiary)
//   tracking { target, thread, lastFireMs, burstShotsLeft,
//   nextBurstShotAtMs, threadStartMs }.  Callers point a slot at a
//   target via setWeaponTarget(); the SM then runs aim + reload + burst
//   cycling autonomously each tick, emitting 'fire' events as shots
//   leave.  commandFire weapons (d-gun) auto-clear after one shot.
//
//   Targets carry a `source` tag ('attack' | 'manual') so the
//   autonomous attack loop (#stepAttack) can reclaim its own targets
//   without stomping on user-initiated manual shots.
//
// Event protocol:
//
//   'spawn'   { unit }
//                Fired when addUnit() registers a new unit.
//
//   'despawn' { unitId }
//                Fired when removeUnit() drops a unit.
//
//   'fire'    { unit, slot, slotName, weapon, anchor, target }
//                Fired when a unit's weapon discharges.  `anchor` is
//                the firing-piece world XYZ (muzzle), `target` is the
//                aim point.  `weapon` is the FBI weapon record (never
//                null on a 'fire' — the SM gates on weapon presence).
//                Listener typically calls weapon-driver.spawnProjectile
//                which spawns the particle + plays sound.
//
//   'hit'     { source, target, dmg }
//                Fired immediately after damage is applied (hit-scan
//                model).  Listener can spawn impact effects.
//
//   'death'   { unit, anchor }
//                Fired when a unit's HP reaches zero.  Listener can
//                spawn a death puff / play a kill sound.
//
//   'move-start' { unit } / 'move-stop' { unit }
//                Edge-triggered when a unit begins / ends a walk
//                cycle.  Listener can fire ack sounds / camera
//                tracking handoffs.
//
// Subscribe with engine.on(event, handler) — returns an unsubscribe
// closure.  No-op cleanup is safe (handler isn't required to be
// registered).

import { CobRuntime } from './cob/cob-runtime.js'
import { CobBinding } from './cob/cob-binding.js'

const SLOT_NAMES = ['Primary', 'Secondary', 'Tertiary']
const TA_TURN_FULL = 65536

// Default damage per shot for sandbox hit-scan combat.  The FBI weapon
// JSON doesn't currently expose the TDF damage= field, so every shot
// applies this constant when the target is a live unit.  When the API
// starts surfacing per-weapon damage we'll switch to w.weaponDamage
// here.  Tuned so a 100-HP skirmish unit takes ~8 hits to drop,
// matching the cadence the user expects to watch.
const DEFAULT_HIT_DAMAGE = 12

let _nextEngineUnitId = 1

// _makeSlotState produces the per-slot weapon record.  Six fields:
//   target            — null | { type, unit?, point?, source }
//                       'unit' targets resolve live (track a moving
//                       enemy); 'point' targets stay fixed.  source
//                       distinguishes #stepAttack-driven targets from
//                       manual user targets so the attack loop can
//                       reclaim its own without stomping user intent.
//   thread            — the live CobThread spawned for AimX.  When it
//                       dies with returnValue === 1 the slot is ready
//                       to fire (subject to reload + burst gates).
//                       Null between targets.
//   lastFireMs        — sim-time of the most recent shot (any burst).
//                       Reload gate waits until simNow >= last + reload.
//   burstShotsLeft    — remaining shots in the current burst (TDF
//                       burst).  0 = ready to start a new burst (gated
//                       on reload), >0 = mid-burst (gated on burstrate).
//   nextBurstShotAtMs — sim-time the next intra-burst shot may leave.
//   threadStartMs     — sim-time the current aim thread was spawned.
//                       Stuck-aim detector compares aimAge against
//                       reload * 2 to flush wedged threads.
function _makeSlotState() {
  return {
    target: null,
    thread: null,
    lastFireMs: -Infinity,
    burstShotsLeft: 0,
    nextBurstShotAtMs: 0,
    threadStartMs: null,
  }
}

export class GameEngine {
  constructor({ runtime, gravity = 80 } = {}) {
    // Each engine owns its own runtime by default — keeps per-tab sim
    // state cleanly isolated.  Caller can pass an existing runtime to
    // share scripts (e.g. AI vs. player on one shared sim) but that's
    // not the common path.
    this.runtime = runtime || new CobRuntime()
    // World gravity (wu/s²) for the ballistic aim solver.  The
    // renderer's environment owns the authoritative value; sandbox /
    // viewer setters push updates via setGravity() when the env
    // changes.  Default matches the studio's ground-world preset.
    this.gravity = gravity
    // Optional renderer ref for cross-unit dynamic light aggregation
    // (laser beams, d-gun orbs, missile exhaust illuminating nearby
    // units).  When set, the engine scans every unit's particle pool
    // each tick and pushes the globally-brightest light-emitter to
    // renderer.setPulseLight.  Without this the multi-unit Sandbox
    // would either get NO dynamic lights (binding.tick is what calls
    // _pushPulseLight in the Viewer path, and the engine doesn't call
    // binding.tick — it calls binding._sync directly) or one-light-
    // per-binding fighting over the renderer's single slot.
    this._renderer = null
    // Audio silencing flag — when set, every per-unit AudioPool gets
    // its setPaused(true) called each #syncBinding so a backgrounded
    // tab goes silent without pausing the simulation.  Independent of
    // runtime.paused: the engine + per-tick scripts keep running.
    this._silenced = false
    // unitId → UnitInstance.  Map iteration order = insertion order
    // (per ECMAScript spec) so the inspector roster reads predictable.
    this._units = new Map()
    // event-name → Set<handler>.  Lazy-allocated so engines with no
    // subscribers don't pay for the map.
    this._listeners = new Map()
  }

  // ── Event bus ─────────────────────────────────────────────────────

  on(event, handler) {
    if (typeof handler !== 'function') return () => {}
    let bucket = this._listeners.get(event)
    if (!bucket) { bucket = new Set(); this._listeners.set(event, bucket) }
    bucket.add(handler)
    return () => { bucket.delete(handler) }
  }

  // emit fires every registered handler for `event`.  Handler
  // exceptions are caught + logged so a buggy renderer can't take the
  // sim down.
  emit(event, payload) {
    const bucket = this._listeners.get(event)
    if (!bucket || bucket.size === 0) return
    for (const handler of bucket) {
      try { handler(payload) } catch (err) { console.warn(`[game-engine:${event}]`, err) }
    }
  }

  // ── Configuration ────────────────────────────────────────────────

  // setGravity — renderer / world owns the authoritative gravity
  // value; tell the engine when it changes so the ballistic aim
  // solver's launch angle agrees with weapon-driver's flight sim
  // (otherwise the turret pitch and the projectile arc disagree and
  // shells miss their target).
  setGravity(g) {
    const v = +g
    if (Number.isFinite(v) && v > 0) this.gravity = v
  }

  // setRenderer attaches a renderer to receive per-tick dynamic-light
  // updates.  Each tick the engine scans every unit's particle pool
  // for the brightest live light-emitter (laser pulse, d-gun ball,
  // missile exhaust) and calls renderer.setPulseLight with it.  Pass
  // null to detach (e.g. the host view is disposing).  Optional —
  // engines that don't need cross-unit lighting (the headless viewer
  // path, where binding.tick already handles it for the single unit)
  // can ignore this entirely.
  setRenderer(r) { this._renderer = r || null }

  // setSilenced toggles AudioPool muting across every unit's binding.
  // When true, all live <audio> elements pause and new emits (which
  // typically auto-start playing) get paused too.  The simulation
  // itself keeps running — only the audible output is muted.  Used
  // by tab-switch to silence the inactive view without freezing its
  // sim.  Idempotent.
  setSilenced(s) {
    s = !!s
    if (s === this._silenced) return
    this._silenced = s
    // Push the new state onto every live binding's audio pool right
    // away — don't wait for the next #syncBinding tick because a
    // backgrounded view might not be ticking.
    for (const u of this._units.values()) {
      if (u.binding && u.binding.audio && typeof u.binding.audio.setPaused === 'function') {
        try { u.binding.audio.setPaused(s) } catch { /* ignore */ }
      }
    }
  }

  // ── Unit lifecycle ────────────────────────────────────────────────

  // addUnit registers a new unit at (x, z) on the ground plane.
  // Caller provides the loaded Model + parsed CobScript JSON; the
  // engine builds the CobUnit + CobBinding internally and emits
  // 'spawn' once the record is live.  Returns the UnitInstance so the
  // caller can stow it on a roster.
  addUnit({ name, model, cobScript, x = 0, z = 0, headingRad = 0, meta = null, side = 0 }) {
    const id = _nextEngineUnitId++
    // Multi-unit instance isolation — the loader caches one Model per
    // unit type, so spawning N of the same unit (sandbox) would have
    // them share Piece.move/rotate/visible and stomp each other's
    // pose every frame (only the LAST tick wins).  Clone the piece
    // tree into a per-instance Model that aliases the same GPU
    // buffers but owns its own animated state.  Models created via
    // adoptUnit (the unit editor, which has exactly one unit) skip
    // this path entirely.
    const instModel = (model && typeof model.cloneForInstance === 'function')
      ? model.cloneForInstance()
      : model
    const cobUnit = cobScript ? this.runtime.addUnit(cobScript, {}) : null
    const binding = (cobUnit && instModel) ? new CobBinding(instModel, cobUnit) : null
    const unit = {
      id, name,
      // Faction index (0..7) — drives the renderer's team-colour pass.
      // 0 = no recolour (the model's authored blue pixels stay blue);
      // 1..7 each map to a TA team palette via team-colors.js.
      side: (side | 0),
      model: instModel, cobUnit, binding,
      // World-space placement.  Heading is body yaw in radians; 0 =
      // facing +Z (the unit's atan2-natural forward direction).  The
      // renderer applies its own +π flip to compensate for the 3DO
      // X-flip — that's a rendering concern, not a sim one.
      pos: { x, y: 0, z },
      heading: headingRad,
      isMoving: false,
      moveTarget: null,
      attackTarget: null,
      // Health, in TA's percent units.  100 = full, 0 = dead.  The
      // COB's GET HEALTH hook reads off this field so SmokeUnit /
      // Killed scripts see the live value next tick.
      health: 100,
      dead: false,
      buildPercent: 100,
      meta,
      // Per-unit COB port state.  Sandbox units used to share a single
      // global port object on the viewer, which made per-unit edits in
      // the Controls panel impossible (everything routed to one bucket).
      // Each engine unit now owns its own, mirroring the viewer's
      // ModelViewer.cobPorts shape so the inspector renderer doesn't
      // need to special-case.  Defaults match the viewer's defaults so
      // standing-orders + activation behave identically in both modes.
      cobPorts: {
        activation: 1,
        moveOrders: 2,
        fireOrders: 2,
        inBuildStance: 0,
        armoured: 0,
        yardOpen: 0,
        buggerOff: 0,
      },
      // Per-slot weapon SM state.  See _makeSlotState() commentary.
      weaponSlots: [_makeSlotState(), _makeSlotState(), _makeSlotState()],
    }
    // Wire the COB's GET_UNIT_VALUE hook so HEALTH / BUILD_PERCENT
    // and the per-unit port state read off this instance.  Matches the
    // port indices the unit editor's model-viewer.js uses so the COB
    // scripts behave identically across modes.
    if (cobUnit) {
      cobUnit.hooks.getUnitValue = (port) => {
        const p = unit.cobPorts
        switch (port) {
          case 1:  return p.activation | 0      // ACTIVATION
          case 2:  return p.moveOrders | 0      // STANDINGMOVEORDERS
          case 3:  return p.fireOrders | 0      // STANDINGFIREORDERS
          case 4:  return Math.max(0, 100 - (100 - unit.health) | 0)  // HEALTH
          case 5:  return p.inBuildStance | 0   // INBUILDSTANCE
          case 6:  return Math.max(0, 100 - (unit.buildPercent | 0))  // BUILD_PERCENT_LEFT
          case 18: return p.yardOpen | 0        // YARD_OPEN
          case 19: return p.buggerOff | 0       // BUGGER_OFF
          case 20: return p.armoured | 0        // ARMORED
          default: return 0
        }
      }
      // SET_UNIT_VALUE writes from scripts (factories flipping IN_BUILD_STANCE,
      // damage scripts toggling ARMORED).  Mirrors the model-viewer's
      // setUnitValue hook so script semantics stay consistent.
      cobUnit.hooks.setUnitValue = (port, value) => {
        const v = value | 0
        const p = unit.cobPorts
        switch (port) {
          case 1:  p.activation    = v ? 1 : 0; break
          case 2:  p.moveOrders    = Math.max(0, Math.min(2, v)); break
          case 3:  p.fireOrders    = Math.max(0, Math.min(2, v)); break
          case 5:  p.inBuildStance = v ? 1 : 0; break
          case 18: p.yardOpen      = v ? 1 : 0; break
          case 19: p.buggerOff     = v ? 1 : 0; break
          case 20: p.armoured      = v ? 1 : 0; break
          default: break
        }
      }
    }
    this._units.set(id, unit)
    this.emit('spawn', { unit })
    return unit
  }

  // adoptUnit registers an existing CobUnit + binding + model as a
  // unit instance WITHOUT creating new ones.  Used by the Unit Viewer
  // to share its already-loaded unit with an engine instance for the
  // sole purpose of running the weapon SM through the engine — the
  // viewer's CobRuntime + binding + model already exist (the renderer
  // creates them on model load), so the engine should attach to them
  // rather than instantiate a parallel set.  Same fields as addUnit
  // populates, just sourced from outside.  Returns the UnitInstance.
  adoptUnit({ name, model, cobUnit, binding, meta = null, x = 0, z = 0, headingRad = 0, side = 0 }) {
    const id = _nextEngineUnitId++
    const unit = {
      id, name,
      side: (side | 0),
      model, cobUnit, binding,
      pos: { x, y: 0, z },
      heading: headingRad,
      isMoving: false,
      moveTarget: null,
      attackTarget: null,
      health: 100,
      dead: false,
      buildPercent: 100,
      meta,
      weaponSlots: [_makeSlotState(), _makeSlotState(), _makeSlotState()],
    }
    // We don't wire the getUnitValue hook here — the host (viewer) is
    // expected to manage its own HEALTH / BUILD port wiring through its
    // existing channels.  Adoption is strictly "make this binding
    // addressable by the engine's weapon SM" — not "take over its COB
    // hook surface".
    this._units.set(id, unit)
    this.emit('spawn', { unit })
    return unit
  }

  removeUnit(id) {
    const unit = this._units.get(id)
    if (!unit) return
    // Tear down any live aim threads first — leaving them running
    // after the unit is gone would yield orphan CobThreads referring
    // to a freed CobUnit.
    for (const state of unit.weaponSlots) {
      if (state.thread && !state.thread.dead) state.thread.dead = true
      state.thread = null
      state.target = null
    }
    if (unit.cobUnit) this.runtime.removeUnit(unit.cobUnit.id)
    if (unit.binding && unit.binding.audio) unit.binding.audio.dispose()
    this._units.delete(id)
    this.emit('despawn', { unitId: id })
  }

  units() { return this._units.values() }
  unitById(id) { return this._units.get(id) }
  unitCount() { return this._units.size }

  // ── Command API ───────────────────────────────────────────────────

  setMoveTarget(unitId, target) {
    const u = this._units.get(unitId)
    if (!u || u.dead) return
    u.moveTarget = target ? { x: target.x, z: target.z } : null
  }

  setAttackTarget(unitId, targetUnitId) {
    const u = this._units.get(unitId)
    if (!u || u.dead) return
    if (targetUnitId == null) { u.attackTarget = null; return }
    const t = this._units.get(targetUnitId)
    if (!t || t.dead || t === u) return
    u.attackTarget = t
  }

  clearOrders(unitId) {
    const u = this._units.get(unitId)
    if (!u) return
    u.moveTarget = null
    u.attackTarget = null
    // Drop every slot's weapon target so the SM stops cycling reloads
    // against a phantom enemy.  Aim threads die in setWeaponTarget(null).
    for (let slot = 0; slot < 3; slot++) this.setWeaponTarget(u.id, slot, null)
    if (u.binding && u.binding.hasScript('StopMoving')) {
      try { u.binding.start('StopMoving') } catch { /* ignore */ }
    }
    if (u.binding && u.binding.hasScript('TargetCleared')) {
      // Force-restart TargetCleared so a held Stop with a previous
      // run mid-flight gets the latest reset.  Symmetric with the
      // Viewer-side Stop handler that already does this; pulling the
      // logic into the engine lets every caller (Viewer + Sandbox +
      // studio's Controls grid handler) share one source of truth.
      const cu = u.cobUnit
      if (cu && typeof cu.killThreadsByName === 'function') {
        cu.killThreadsByName('TargetCleared')
        cu.killThreadsByName('RestorePosition')
      }
      try { u.binding.start('TargetCleared', [0]) } catch { /* ignore */ }
    }
  }

  // stopUnit is the canonical "halt this unit completely" entry point.
  // Mirrors clearOrders semantics — name kept for back-compat — but is
  // the documented name callers (BaseView.stop, studio.js Controls
  // grid handler, sandbox-view #stopSelected) should reach for.
  stopUnit(unitId) { this.clearOrders(unitId) }

  // stopUnits drops orders on every unit in the iterable.  Returns
  // the number of units actually halted (skips ids the engine doesn't
  // know about).  Used by multi-select Stop buttons + the S hotkey
  // so the caller doesn't need its own for-each loop.
  stopUnits(unitIds) {
    let n = 0
    for (const id of unitIds) {
      if (this._units.has(id)) { this.stopUnit(id); n++ }
    }
    return n
  }

  // setWeaponTarget points a slot at a target and lets the per-tick
  // SM drive aim + reload + burst from there.  Target shapes:
  //
  //   null                  → clear target (kills aim thread, resets burst)
  //   { unit: U }           → live-track another unit's position
  //   { point: [x, y, z] }  → static aim point
  //   [x, y, z]             → shorthand for { point: ... }
  //
  // Optional opts.source ('attack' | 'manual', default 'manual') tags
  // the target so #stepAttack can distinguish its own autonomous
  // targets (safe to retract on Move / target-loss) from user-
  // initiated ones (left alone until the user changes them).
  //
  // Re-calling with the same target unit (or the same XZ point) is a
  // no-op so an autonomous attack loop can push the target every tick
  // without dropping the live aim thread.  Switching target replaces
  // it AND resets aim + burst so a fresh aim cycle runs against the
  // new target.
  setWeaponTarget(unitId, slot, target, { source = 'manual' } = {}) {
    const u = this._units.get(unitId)
    if (!u || u.dead) return
    if (slot < 0 || slot > 2) return
    const state = u.weaponSlots[slot]
    if (!state) return
    const normalized = this.#normalizeTarget(target, source)
    if (this.#targetsEqual(state.target, normalized)) return
    state.target = normalized
    // New target — drop the in-flight aim thread + burst counters so
    // the SM runs a fresh aim cycle.  Without this, a held aim thread
    // from the previous target would tick its returnValue=1 and the
    // first shot would discharge at the OLD aim angle.
    if (state.thread && !state.thread.dead) state.thread.dead = true
    state.thread = null
    state.threadStartMs = null
    state.burstShotsLeft = 0
    state.nextBurstShotAtMs = 0
    // Run BOS TargetCleared on every new target so per-unit aim
    // globals (Commander's aimtype, ARM_DGUN flag etc.) reset.  Without
    // this, switching primary→tertiary→primary leaves the previous
    // weapon's aimtype locked and AimPrimary short-circuits with
    // `return FALSE`.
    if (normalized && u.binding && u.binding.hasScript('TargetCleared')) {
      try { u.binding.start('TargetCleared', [0]) } catch { /* ignore */ }
    }
  }

  clearWeaponTarget(unitId, slot) {
    this.setWeaponTarget(unitId, slot, null)
  }

  // fireWeapon — legacy single-shot API.  Equivalent to setting a
  // manual target on the slot; the SM picks it up on the next tick
  // and discharges as soon as aim + reload allow.  Kept for back-compat
  // with call sites that just want "fire ONCE at this point" semantics.
  // For sustained fire prefer setWeaponTarget directly so the source
  // tag can be controlled.
  fireWeapon(unitId, slot, target) {
    this.setWeaponTarget(unitId, slot, target, { source: 'manual' })
  }

  // applyDamage subtracts dmg from the target's HP and emits 'hit'.
  // If HP reaches zero, also emits 'death' + flips dead = true.
  // Returns true when the target died this call.
  applyDamage(sourceId, targetId, dmg) {
    const source = this._units.get(sourceId)
    const target = this._units.get(targetId)
    if (!target || target.dead) return false
    target.health = Math.max(0, target.health - dmg)
    this.emit('hit', { source, target, dmg })
    if (target.health <= 0) {
      target.dead = true
      target.moveTarget = null
      target.attackTarget = null
      // Snuff in-flight aim threads on the dead unit so they don't
      // continue ticking against a stale binding.
      for (const state of target.weaponSlots) {
        if (state.thread && !state.thread.dead) state.thread.dead = true
        state.thread = null
        state.target = null
      }
      this.emit('death', { unit: target, anchor: [target.pos.x, target.pos.y + 18, target.pos.z] })
      return true
    }
    return false
  }

  // ── Per-frame tick ────────────────────────────────────────────────
  //
  // tick advances the runtime + every per-unit phase by dtMs.  Options
  // let an embedding host suppress phases it owns itself:
  //
  //   skipRuntime  — don't advance runtime.tick(dtMs).  The Unit Viewer
  //                  passes this because its renderer ticks the binding
  //                  (and therefore the runtime) per-frame; the engine
  //                  is along for the ride only to drive weapon SMs.
  //   skipMovement — don't run #stepMovement / #stepAttack.  The Viewer
  //                  passes this because MvControls owns the viewer's
  //                  movement (with aircraft altitude + ship wakes +
  //                  manual ground walk the engine doesn't model).
  //   skipSync     — don't run #syncBinding.  The Viewer passes this
  //                  because its renderer ticks the binding directly
  //                  and pushes its own worldOffset.
  tick(dtMs, { skipRuntime = false, skipMovement = false, skipSync = false } = {}) {
    const insts = skipRuntime ? null : this.runtime.tick(dtMs)
    const dtSec = (dtMs * (this.runtime.playbackRate || 1)) / 1000
    const simNowMs = this.runtime.simTimeMs || 0
    for (const u of this._units.values()) {
      if (u.dead) continue
      if (!skipMovement) {
        this.#stepAttack(u, simNowMs)
        this.#stepMovement(u, dtSec)
      }
      this.#stepWeapons(u, simNowMs)
      if (!skipSync) this.#syncBinding(u, dtMs)
    }
    // Cross-unit dynamic-light aggregation.  Only when a renderer is
    // attached AND we're driving the sync pass (the headless viewer
    // path skips sync because its binding.tick already handles
    // _pushPulseLight for the single unit).
    if (!skipSync && this._renderer) this.#pushSceneLight()
    return insts
  }

  // #pushSceneLight scans every unit's particle pool for the
  // brightest live light-emitter and forwards it to the renderer's
  // single dynamic-light slot.  Cross-unit by design — without this,
  // each unit's binding._pushPulseLight would overwrite the previous
  // unit's contribution and only the last-iterated binding's light
  // would survive (or, more often in Sandbox mode where binding.tick
  // isn't called per-unit at all, no light would surface).  Score =
  // lightStrength · max(r,g,b) · alpha/alpha0 — same formula
  // cob-binding uses for the single-unit case so behaviour matches.
  #pushSceneLight() {
    const r = this._renderer
    if (!r || typeof r.setPulseLight !== 'function') return
    let bestUnit = null
    let bestIdx = -1
    let bestScore = 0
    for (const u of this._units.values()) {
      if (u.dead) continue
      const b = u.binding
      if (!b || !b.particles) continue
      const p = b.particles
      for (let i = 0; i < p.count; i++) {
        if (!p.alive[i]) continue
        const ls = p.lightStrength[i]
        if (!(ls > 0)) continue
        const lum = Math.max(p.r[i], p.g[i], p.b[i])
        const s = ls * lum * (p.a[i] / Math.max(0.001, p.a0[i]))
        if (s > bestScore) { bestScore = s; bestIdx = i; bestUnit = u }
      }
    }
    if (bestIdx < 0 || !bestUnit) {
      r.setPulseLight(null, null, 0)
      return
    }
    const p = bestUnit.binding.particles
    // Particle positions are in WORLD coords for sandbox (the binding's
    // worldOffset has already been baked in by the spawn helper) — so
    // pass straight through without re-adding the unit position.
    r.setPulseLight(
      [p.x[bestIdx], p.y[bestIdx], p.z[bestIdx]],
      [p.r[bestIdx], p.g[bestIdx], p.b[bestIdx]],
      p.lightStrength[bestIdx]
    )
  }

  // #stepAttack — autonomous attack loop.  Walks the unit into range
  // of attackTarget, then pushes the target into slot 0's weapon SM
  // (tagged source='attack' so a manual override or a Move order can
  // reclaim it).  Damage application now happens in #stepWeapon on
  // each shot — this step is purely "walk + arm slot 0".
  #stepAttack(u, _simNowMs) {
    const t = u.attackTarget
    if (!t || t.dead || !this._units.has(t.id)) {
      u.attackTarget = null
      // Withdraw any attack-tagged weapon target so the slot doesn't
      // keep firing at a phantom enemy.  Manual targets are left
      // alone — the user explicitly asked for them.  Also stop ALL
      // slots that the autonomous attack loop had armed: secondary +
      // tertiary fire-while-engaged stay live until the pursuit ends
      // (mirrors slot 0 — without this, killing the target leaves
      // those slots cycling forever at a phantom).
      for (let slot = 0; slot < 3; slot++) {
        const s = u.weaponSlots[slot]
        if (s.target && s.target.source === 'attack') {
          this.setWeaponTarget(u.id, slot, null)
        }
      }
      // Drop the in-flight move command if it was driven by THIS
      // attack pursuit (walk-into-range writes u.moveTarget every
      // tick to the prey's last position).  Without this clear, the
      // survivor units keep walking to the late prey's coffin spot
      // before settling — looks like "they all stop responding" right
      // after a kill.  Pursuit-issued moveTarget always matches the
      // last-known prey position to within ~1 wu, so we test that
      // before clearing in case the user issued an unrelated move.
      // `t` may be null here (no attack target was ever set — the
      // common case after Move was issued), so guard the dereference.
      if (t && u.moveTarget &&
          Math.abs(u.moveTarget.x - t.pos.x) < 1 &&
          Math.abs(u.moveTarget.z - t.pos.z) < 1) {
        u.moveTarget = null
      }
      return
    }
    const dx = t.pos.x - u.pos.x
    const dz = t.pos.z - u.pos.z
    const dist = Math.hypot(dx, dz)
    const range = this.#weaponRangeFor(u, 0)
    if (dist > range) {
      // Out of range — re-aim the move command at the prey's CURRENT
      // position each tick (target may be running) and drop slot 0's
      // weapon target so the SM doesn't burn aim threads while we walk.
      u.moveTarget = { x: t.pos.x, z: t.pos.z }
      const slot0 = u.weaponSlots[0]
      if (slot0.target && slot0.target.source === 'attack') {
        this.setWeaponTarget(u.id, 0, null)
      }
      return
    }
    // In range — stop walking, point slot 0 at the enemy.  Re-pushing
    // the same target each tick is a no-op via #targetsEqual, so the
    // live aim thread + burst state survive across ticks.
    u.moveTarget = null
    this.setWeaponTarget(u.id, 0, { unit: t }, { source: 'attack' })
  }

  // #stepMovement turns the unit toward its move-target at FBI
  // TurnRate, then walks forward at MaxVelocity once aligned.
  // Edge-triggers StartMoving / StopMoving scripts on isMoving
  // transitions so kbot/tank leg loops kick in/out properly.
  #stepMovement(u, dtSec) {
    const wasMoving = !!u.isMoving
    if (u.moveTarget) {
      const dx = u.moveTarget.x - u.pos.x
      const dz = u.moveTarget.z - u.pos.z
      const dist = Math.hypot(dx, dz)
      if (dist < 0.5) {
        u.moveTarget = null
        u.isMoving = false
      } else {
        const want = Math.atan2(dx, dz)
        // FBI TurnRate: TA-angle/frame.  Convert to rad/sec.
        const turnRateTA = (u.meta && u.meta.turnRate) ? u.meta.turnRate : 600
        const turnRate = (turnRateTA / 65536) * Math.PI * 2 * 30
        let dh = want - u.heading
        while (dh > Math.PI) dh -= Math.PI * 2
        while (dh < -Math.PI) dh += Math.PI * 2
        const turnStep = turnRate * dtSec
        let aligned
        if (Math.abs(dh) > turnStep) {
          u.heading += Math.sign(dh) * turnStep
          aligned = false
        } else {
          u.heading = want
          aligned = true
        }
        if (aligned) {
          const speed = (u.meta && u.meta.maxVelocity > 0)
            ? u.meta.maxVelocity * 30 /* FBI units/frame × 30Hz → wu/sec */
            : 30
          const step = Math.min(dist, speed * dtSec)
          u.pos.x += Math.sin(u.heading) * step
          u.pos.z += Math.cos(u.heading) * step
        }
        u.isMoving = true
      }
    } else {
      u.isMoving = false
    }
    if (u.isMoving && !wasMoving) {
      if (u.binding && u.binding.hasScript('StartMoving')) {
        try { u.binding.start('StartMoving') } catch { /* ignore */ }
      }
      this.emit('move-start', { unit: u })
    } else if (!u.isMoving && wasMoving) {
      if (u.binding && u.binding.hasScript('StopMoving')) {
        try { u.binding.start('StopMoving') } catch { /* ignore */ }
      }
      this.emit('move-stop', { unit: u })
    }
  }

  // #stepWeapons — drive each slot's weapon SM once per tick.  Cheap
  // early-out when no binding (the unit's COB never loaded) or when
  // no slot has a target (the SM is gated on state.target).
  #stepWeapons(u, simNowMs) {
    if (!u.binding) return
    for (let slot = 0; slot < 3; slot++) {
      this.#stepWeapon(u, slot, simNowMs)
    }
  }

  // #stepWeapon — port of MvControls._updateWeapon, generalised.
  // Drives the aim thread lifecycle, reload timing, and burst cycling
  // for ONE slot.  When the gates align, emits the 'fire' event so the
  // rendering layer spawns the visible projectile / beam / smoke trail
  // / sound, and applies hit-scan damage when the target is a live
  // unit ref.
  //
  // The SM keeps a live aim thread running between shots so the turret
  // tracks a moving target; on each fire the thread is killed (first
  // burst shot only) and respawned so the next aim cycle uses the
  // target's current position.  commandFire weapons (d-gun) clear the
  // slot's target after one shot, matching TA's D-key one-shot
  // behaviour.
  #stepWeapon(u, slot, simNowMs) {
    const state = u.weaponSlots[slot]
    if (!state.target) return
    const target = this.#resolveTarget(state.target)
    if (!target) {
      // Target unit died / disappeared — drop the slot.
      state.target = null
      if (state.thread && !state.thread.dead) state.thread.dead = true
      state.thread = null
      return
    }
    const binding = u.binding
    if (!binding) return
    // Pre-Create gate matches the viewer SM: firing during the Create
    // script causes static-var reads before Create has initialised
    // them.  Only consulted when _lifecycle is set (the viewer's
    // MvControls writes it; sandbox auto-Create never does, so the
    // gate silently passes through).
    if (binding._lifecycle === 'unborn' || binding._lifecycle === 'creating') return
    const slotName = SLOT_NAMES[slot]
    const aimScript = 'Aim' + slotName
    const fireScript = 'Fire' + slotName
    const hasAim = binding.hasScript(aimScript)
    const hasFire = binding.hasScript(fireScript)
    // Need an FBI weapon record to know reload + burst + soundStart +
    // projectile kind.  Without it the SM has nothing meaningful to
    // schedule.
    const w = this.#weaponForSlot(u, slot)
    if (!w) return
    const reloadMs = this.#reloadMs(w)
    const sinceLastFire = simNowMs - state.lastFireMs
    const reloadReady = sinceLastFire >= reloadMs
    // Aim-completion: AimX threads end with returnValue === 1 when the
    // turret has reached the requested angle.  Units without an AimX
    // script (aircraft, fixed turrets) get an implicit "always ready"
    // via hasAim=false.
    const aimDoneOk = !hasAim || (state.thread && state.thread.dead && state.thread.returnValue === 1)
    // Stuck-aim detection: if AimX has been running > 2× reload
    // without dying, the unit's walk animation is probably fighting
    // our turret pieces (PeeWee's leg loops keep upper-arm rotations
    // mid-cycle).  Fire anyway so the user still sees discharge —
    // matches TA firing on reload cadence even when the turret isn't
    // perfectly aligned.
    const aimAgeMs = state.threadStartMs ? (simNowMs - state.threadStartMs) : 0
    const aimStuck = hasAim && state.thread && !state.thread.dead && aimAgeMs > reloadMs * 2
    // Burst gates — TDF `burst` declares shots per burst (EMG = 3),
    // `burstrate` is the intra-burst gap (EMG = 0.1 s).  Reload only
    // starts AFTER the full burst empties.  burstShotsLeft = 0 means
    // ready to start a new burst (gated on reloadReady); >0 means
    // mid-burst (gated on the intra-burst timer).
    const burstSize = (w.burst > 1) ? w.burst : 1
    const burstGapMs = (w.burstRateSec > 0) ? w.burstRateSec * 1000 : 0
    const inBurst = state.burstShotsLeft > 0
    const burstReady = inBurst && simNowMs >= state.nextBurstShotAtMs
    const startBurst = !inBurst && reloadReady && (aimDoneOk || aimStuck)
    if (startBurst || burstReady) {
      state.lastFireMs = simNowMs
      // Initialise (burstSize - 1) on the FIRST shot — we're about to
      // fire shot #1 right now, subsequent shots tick the counter down.
      if (startBurst) state.burstShotsLeft = burstSize - 1
      else state.burstShotsLeft -= 1
      state.nextBurstShotAtMs = simNowMs + burstGapMs
      // Run the COB Fire script (turret recoil, muzzle flash hook, BOS
      // sleep-fire-show-flare pattern).  Aircraft fall through to the
      // binding's _emitFireBurst helper which synthesises the muzzle
      // flash by hand (TA auto-fires aircraft; the BOS only ships
      // QueryX).
      if (hasFire) {
        try { binding.start(fireScript) } catch { /* ignore */ }
      } else if (typeof binding._emitFireBurst === 'function') {
        try { binding._emitFireBurst(fireScript) } catch { /* ignore */ }
      }
      // Compute the muzzle-exit world position via QueryX (preferred)
      // or name-heuristic fallback, then emit 'fire' so the rendering
      // layer spawns the visible projectile + beam + smoke trail +
      // sound through the shared weapon-driver.
      const firePiece = this.#firingPieceFor(u, slot)
      const anchor = this.#pieceWorldPos(u, firePiece)
      this.emit('fire', {
        unit: u,
        slot,
        slotName,
        weapon: w,
        anchor,
        target,
      })
      // Hit-scan damage for unit-vs-unit fire (sandbox skirmishes).
      // Real game models per-projectile flight-time damage; the engine
      // doesn't yet, so apply on fire when the target is a live unit
      // ref.  Point targets (manual fire-at-ground) don't damage anything.
      if (state.target.type === 'unit' && state.target.unit && !state.target.unit.dead) {
        this.applyDamage(u.id, state.target.unit.id, DEFAULT_HIT_DAMAGE)
      }
      // Kill the stale aim thread on the FIRST burst shot — fresh
      // thread spawns below to track the target through subsequent
      // reloads.  Subsequent burst shots reuse the existing thread so
      // the turret holds steady through the burst.
      if (startBurst) {
        if (state.thread && !state.thread.dead) state.thread.dead = true
        state.thread = null
        state.threadStartMs = null
      }
      // commandFire weapons (d-gun) clear the target after one full
      // burst — matches TA's D-key one-shot behaviour.  The user
      // re-arms + clicks for a second shot.
      if (w.commandFire && state.burstShotsLeft === 0) {
        state.target = null
        return
      }
    }
    // Maintain a live aim thread between shots so the turret tracks
    // the target.  Without this, after firing we'd have no aim
    // running and the turret would sit at its last position until the
    // next fire respawned it.
    if (hasAim && (!state.thread || state.thread.dead) && u.cobUnit) {
      // Resolve the aim ORIGIN piece via AimFromX → use that piece's
      // world position as the from-point in the angle solver instead
      // of the unit's centre.  TA tanks/kbots with raised turrets get
      // a more accurate pitch this way — shooting up at a hill from
      // a turret 6 wu above the body otherwise underestimates the
      // pitch angle, and the projectile drops short.  Resolves to
      // u.pos when the unit has no AimFromX script (most don't).
      const aimOrigin = this.#aimOriginPos(u, slot)
      const { headingTA, pitchTA } = this.#aimAnglesFor(u, slot, target, aimOrigin)
      try {
        state.thread = u.cobUnit.startThread(aimScript, [headingTA | 0, pitchTA | 0])
        state.threadStartMs = simNowMs
      } catch {
        // Thread spawn failed (rare — bad script bytecode?).  Fall
        // back to a dead pseudo-thread so the SM keeps firing on
        // reload cadence without trying to spawn aim every tick.
        state.thread = { dead: true, returnValue: 1 }
        state.threadStartMs = simNowMs
      }
    } else if (!hasAim && !state.thread) {
      // No aim script — synthesise an "always ready" pseudo-thread so
      // aimDoneOk passes the gate on the next tick.
      state.thread = { dead: true, returnValue: 1 }
    }
  }

  // ── Weapon helpers ────────────────────────────────────────────────

  #weaponForSlot(u, slot) {
    if (!u.meta || !u.meta.weapons) return null
    const w = u.meta.weapons[slot]
    return (w && w.name) ? w : null
  }

  // #reloadMs — TDF reloadtime in ms.  100 ms floor protects against
  // pathological weapons that ship a reload of zero or less.
  #reloadMs(w) {
    if (!w || !w.reloadSec) return 1500
    return Math.max(100, w.reloadSec * 1000)
  }

  // #weaponRangeFor returns slot N's engagement range (wu).  Used by
  // #stepAttack to decide walk-or-fire.  Falls back to a sandbox
  // default when the unit has no weapon meta yet (FBI fetch races
  // the first attack order on freshly-spawned units).
  #weaponRangeFor(u, slot) {
    const w = this.#weaponForSlot(u, slot)
    if (w && w.rangeWU > 0) return w.rangeWU
    return 220
  }

  // #normalizeTarget coerces the caller's shape into the SM's internal
  // { type, unit?, point?, source } record.  Allows callers to pass
  // raw arrays, unit refs, or fully-formed records interchangeably.
  #normalizeTarget(target, source) {
    if (!target) return null
    if (target.type === 'unit' || target.type === 'point') {
      // Already normalised — overlay the requested source so the
      // attack-vs-manual tag stays under the caller's control.
      return { ...target, source }
    }
    if (target.unit) return { type: 'unit', unit: target.unit, source }
    if (target.point) {
      return { type: 'point', point: [target.point[0], target.point[1] || 0, target.point[2]], source }
    }
    if (Array.isArray(target)) {
      return { type: 'point', point: [target[0], target[1] || 0, target[2]], source }
    }
    return null
  }

  // #targetsEqual — used by setWeaponTarget to make "re-push the same
  // target" a no-op so the autonomous attack loop can call every
  // tick without dropping the live aim thread.  Point targets compare
  // XZ only (Y differences from sub-tick ground re-raycasts shouldn't
  // count as a target change).
  #targetsEqual(a, b) {
    if (!a && !b) return true
    if (!a || !b) return false
    if (a.type !== b.type) return false
    if (a.type === 'unit') return a.unit === b.unit
    if (a.type === 'point') {
      const ap = a.point, bp = b.point
      return ap[0] === bp[0] && ap[2] === bp[2]
    }
    return false
  }

  // #resolveTarget converts the SM's stored target record into a
  // world-space [x, y, z] for the aim solver + 'fire' event payload.
  // Unit targets resolve to the unit's CURRENT position so a moving
  // enemy is tracked between shots; lifts y by a small COM offset so
  // the turret aims at the body rather than the feet.  Returns null
  // when the target unit has died (caller clears the slot).
  #resolveTarget(target) {
    if (!target) return null
    if (target.type === 'unit') {
      const u = target.unit
      if (!u || u.dead) return null
      return [u.pos.x, u.pos.y + 12, u.pos.z]
    }
    if (target.type === 'point') return target.point
    return null
  }

  // #firingPieceFor — resolve the piece a slot's projectile should
  // exit from.  Preferred path: run the unit's QueryX script in
  // synchronous "query mode" — runQuery executes the script start to
  // finish in the current frame and returns the piece index the
  // script wrote to its `piecenum` out-parameter.  This is the same
  // source-of-truth the cob-binding's muzzle-flash helper uses, so
  // the projectile + flash share an anchor (PeeWee's QueryPrimary
  // alternates rfire/lfire via the `gun` static var — both views
  // honour the alternation).  Fallback when no QueryX or when query
  // refused to resolve synchronously: name-heuristic scan over the
  // model pieces.
  // #aimOriginPos — resolve AimFromX → piece world position, used as
  // the FROM-point in #aimAnglesFor for ballistic pitch math.  Same
  // synchronous query mechanism as QueryX: the AimFromX script writes
  // the chosen piece index into its 0th argument and returns; the
  // runtime's runQuery() hands back that out-param value.  Falls
  // through to the unit centre when there's no AimFromX script (most
  // units), or when the script returns an out-of-range index.
  #aimOriginPos(u, slot) {
    const fallback = [u.pos.x, u.pos.y, u.pos.z]
    if (!u.cobUnit || !u.model) return fallback
    if (typeof u.cobUnit.runQuery !== 'function') return fallback
    if (typeof u.cobUnit.hasScript !== 'function') return fallback
    const scriptName = 'AimFrom' + SLOT_NAMES[slot]
    if (!u.cobUnit.hasScript(scriptName)) return fallback
    // runQuery drains the script synchronously this tick and returns
    // the value of locals[0] (the conventional `piecenum` out-param
    // slot).  Returns null when the script yields (sleep / wait-*),
    // which AimFromX never should — TA's BOS only ever uses it for
    // pure data resolution.  Defensive null check anyway.
    const pieceIdx = u.cobUnit.runQuery(scriptName, [0])
    if (pieceIdx == null) return fallback
    const names = u.cobUnit.pieceNames || []
    if (pieceIdx < 0 || pieceIdx >= names.length) return fallback
    const piece = u.model.findPiece(names[pieceIdx])
    if (!piece || !piece.worldMatrix) return fallback
    const wm = piece.worldMatrix
    return [wm[12], wm[13], wm[14]]
  }

  #firingPieceFor(u, slot) {
    const model = u.model
    if (!model) return null
    const queryName = 'Query' + SLOT_NAMES[slot]
    if (u.cobUnit && typeof u.cobUnit.runQuery === 'function'
        && typeof u.cobUnit.hasScript === 'function' && u.cobUnit.hasScript(queryName)) {
      const pieceIdx = u.cobUnit.runQuery(queryName, [0])
      // pieceIdx indexes the COB header's piece-name table (the order
      // pieces are declared in the BOS `piece` statement) — NOT the
      // 3DO DFS-flat order.  Resolve through the name table, then look
      // up by name on the model so renderer + COB stay in sync.
      const names = u.cobUnit.pieceNames || []
      if (pieceIdx != null && pieceIdx >= 0 && pieceIdx < names.length) {
        const p = model.findPiece(names[pieceIdx])
        if (p) return p
      }
    }
    const idx = slot + 1
    const exact = (idx === 1)
      ? ['flare', 'flare1', 'rfire', 'rfirept', 'firept1', 'muzzle', 'muzzle1', 'barrel']
      : (idx === 2)
        ? ['flare2', 'lfire', 'lfirept', 'firept2', 'muzzle2', 'barrel2']
        : [`flare${idx}`, `firept${idx}`, `muzzle${idx}`, `barrel${idx}`]
    for (const name of exact) {
      const p = model.findPiece(name)
      if (p) return p
    }
    const re = (idx === 1)
      ? /^(flare1?|rfire|firept1|muzzl(e|e1)|barrel1?)/i
      : (idx === 2)
        ? /^(flare2|lfire|firept2|muzzle2|barrel2)/i
        : new RegExp(`^(flare${idx}|firept${idx}|muzzle${idx}|barrel${idx})`, 'i')
    const m = model.flat.find((p) => re.test(p.name))
    if (m) return m
    return model.flat.find((p) => /flare|firept|muzzl|fire/i.test(p.name)) || null
  }

  // #pieceWorldPos reads the post-COB-anim WORLD position of a piece.
  //
  // `piece.worldMatrix` is computed by Piece.computeWorldMatrix with
  // the renderer's `_modelMatrix` as the root parent.  In single-unit
  // viewer mode the renderer sets `_modelMatrix` from setUnitTransform
  // (typically identity since the studio unit sits at origin); in
  // multi-unit sandbox mode it sets `_modelMatrix` from entity.transform
  // per-entity (translate by unit world pos, rotate by heading).
  // Either way, by the time we read piece.worldMatrix[12,13,14] it's
  // already in WORLD space — the unit's translation is baked in.
  //
  // Sandbox previously appeared to spawn particles at the wrong
  // offset.  That symptom was real but the cause turned out to be a
  // stale piece.worldMatrix (computed against an old _modelMatrix
  // from the previous tab's renderer state), not double-translation.
  //
  // Renderer calls computeWorldMatrix every frame; engine tick runs
  // AFTER the draw callback (onAfterFrame), so worldMatrix is fresh.
  // Falls back to the unit's centre when the piece has no matrix yet
  // (just-spawned unit, before the first draw).
  #pieceWorldPos(u, piece) {
    if (piece && piece.worldMatrix) {
      const m = piece.worldMatrix
      return [m[12], m[13], m[14]]
    }
    return [u.pos.x, u.pos.y + 14, u.pos.z]
  }

  // #aimAnglesFor — port of MvControls._aimAnglesFor.  Returns TA-unit
  // heading + pitch for the slot's AimX(heading, pitch) call.
  //
  // Coordinate-system bookkeeping:
  //   worldHeading + u.heading are angles measured CCW from +Z (the
  //     renderer / OpenGL right-handed convention).
  //   `rel` = worldHeading - u.heading = the angle the body would
  //     need to rotate CCW to face the target.
  //   TA's AimWeapon expects CW-positive heading from the body's
  //     forward (left-handed TA convention).  So `rel` and the TA
  //     value differ in SIGN.  The cob-binding compensates with
  //     `piece.rotate[1] = -rot[1]` when it pushes the animator's
  //     value into the render piece — that means we negate the TA
  //     value here so the animator → binding → renderer chain
  //     composes to land the turret on the target.  Without the
  //     negation the turret ends up mirrored across the body's
  //     forward axis.
  //
  // Pitch:
  //   * ballistic (FBI weapon.ballistic = true): solve the projectile-
  //     motion quadratic for the LOW-arc launch angle so the shell
  //     drops onto the target.  Gravity from this.gravity (renderer
  //     pushes updates via setGravity).  Out-of-range falls back to
  //     45° (max-range launch).
  //   * non-ballistic (laser / missile): aim along the direct line of
  //     sight, atan2(verticalOffset, horizontalDist).
  //   * no weapon data: pitch = 0.
  #aimAnglesFor(u, slot, target, originOverride = null) {
    // origin defaults to the unit centre; AimFromX can override it to
    // a piece world-pos so the pitch math measures Δy from the turret
    // tip rather than the body root.  Heading is unaffected by the
    // origin Y component, so the override mostly matters for ballistic
    // pitch on units with tall turrets / aircraft / commanders.
    const origin = originOverride || [u.pos.x, u.pos.y, u.pos.z]
    const dx = target[0] - origin[0]
    const dz = target[2] - origin[2]
    const horizDist = Math.hypot(dx, dz)
    const worldHeading = Math.atan2(dx, dz)
    let rel = worldHeading - u.heading
    while (rel > Math.PI) rel -= Math.PI * 2
    while (rel < -Math.PI) rel += Math.PI * 2
    const headingTA = -(rel / (Math.PI * 2)) * TA_TURN_FULL
    let pitchRad = 0
    const w = this.#weaponForSlot(u, slot)
    const targetY = target.length >= 3 ? target[1] : 0
    const vDelta = targetY - origin[1]
    if (horizDist > 0.0001 && w && w.ballistic && w.velocityWU > 0) {
      const v = w.velocityWU
      const g = this.gravity
      const v2 = v * v
      const d = horizDist
      const disc = v2 * v2 - g * (g * d * d + 2 * vDelta * v2)
      if (disc >= 0) {
        const root = Math.sqrt(disc)
        const tanLow = (v2 - root) / (g * d)
        pitchRad = Math.atan(tanLow)
      } else {
        pitchRad = Math.PI / 4
      }
    } else if (horizDist > 0.0001) {
      pitchRad = Math.atan2(vDelta, horizDist)
    }
    const pitchTA = (pitchRad / (Math.PI * 2)) * TA_TURN_FULL
    return { headingTA, pitchTA }
  }

  // #syncBinding bridges the sim and the renderer: pushes the unit's
  // current world pos into its binding (so emitted particles anchor at
  // the right world position) + advances the binding's particle /
  // audio pools + writes COB piece animations into the model.  The
  // binding itself is render-aware (it owns a ParticlePool + AudioPool),
  // but the writes here are pure data — no DOM, no GL state.  Renderers
  // read off the binding next frame.
  #syncBinding(u, dtMs) {
    const b = u.binding
    if (!b) return
    if (b.worldOffset) {
      b.worldOffset.x = u.pos.x
      b.worldOffset.y = u.pos.y
      b.worldOffset.z = u.pos.z
    }
    b._sync && b._sync(dtMs)
    // Particle motion (projectiles, smoke, sparks) must follow the
    // sim's playback rate AND the paused flag.  Without the pause
    // check, in-flight projectiles continue to fly across the
    // screen at full speed while the rest of the sim is frozen —
    // reads as "projectiles ignore game speed" because hitting Pause
    // visibly desyncs them from everything else.  rate==0 when paused
    // → no motion, no life decrement, no expire.
    if (b.particles) {
      const rate = this.runtime.paused ? 0 : (this.runtime.playbackRate || 1)
      b.particles.tick(dtMs * rate)
    }
    // Audio: silenced > runtime.paused.  When the engine has been
    // muted (a backgrounded tab), we keep the audio pool paused even
    // when the runtime ticks.  When un-silenced, fall back to the
    // runtime's own paused state.
    if (b.audio) b.audio.tick(this.runtime.playbackRate || 1, this._silenced || this.runtime.paused)
  }
}
