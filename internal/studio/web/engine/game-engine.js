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

import { CobRuntime } from './cob-runtime.js'
import { CobBinding } from './cob-binding.js'
import { stepSurfaceLocomotion, attackManeuver, shortestArc } from './locomotion.js'
import { angleToRadians } from './cob-opcodes.js'
import { makeProjectile, stepProjectile, hasModelProjectile } from './projectiles.js'

const SLOT_NAMES = ['Primary', 'Secondary', 'Tertiary']
const TA_TURN_FULL = 65536

// Default damage per shot for hit-scan combat.  The FBI weapon
// JSON doesn't currently expose the TDF damage= field, so every shot
// applies this constant when the target is a live unit.  When the API
// starts surfacing per-weapon damage we'll switch to w.weaponDamage
// here.  Tuned so a 100-HP skirmish unit takes ~8 hits to drop,
// matching the cadence the user expects to watch.
const DEFAULT_HIT_DAMAGE = 12

// Window in which back-to-back tick() calls coalesce into one.  See the
// per-frame-tick comment in tick() below for the reasoning.  Sized so a
// 60-fps cluster of N renderer onAfterFrame callbacks (~0.1 ms apart)
// folds to one step, while independent ~16.7 ms drivers never collide.
const ENGINE_TICK_COALESCE_MS = 3

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
  constructor({ runtime, gravity = 80, audioFactory = null } = {}) {
    // Each engine owns its own runtime by default — keeps per-tab sim
    // state cleanly isolated.  Caller can pass an existing runtime to
    // share scripts (e.g. AI vs. player on one shared sim) but that's
    // not the common path.
    this.runtime = runtime || new CobRuntime()
    // World gravity (wu/s²) for the ballistic aim solver.  The
    // renderer's environment owns the authoritative value; callers
    // push updates via setGravity() when the env changes.  Default
    // matches the studio's ground-world preset.
    this.gravity = gravity
    // Audio silencing flag — when set, every per-unit AudioPool gets
    // its setPaused(true) called each #syncBinding so a backgrounded
    // tab goes silent without pausing the simulation.  Independent of
    // runtime.paused: the engine + per-tick scripts keep running.
    this._silenced = false
    // audioFactory — host-supplied () => AudioPool used to allocate
    // each new binding's audio pool on addUnit.  The engine package is
    // headless and never imports a concrete AudioPool itself: renderer
    // hosts pass `audioFactory: () => new AudioPool()`, server-side
    // sims pass nothing and every binding gets the shared NullAudioPool
    // stub (zero-allocation no-op).  Keeps the cross-package import
    // direction one-way: game3d → engine, never the reverse.
    this._audioFactory = (typeof audioFactory === 'function') ? audioFactory : null
    // unitId → UnitInstance.  Map iteration order = insertion order
    // (per ECMAScript spec) so the inspector roster reads predictable.
    this._units = new Map()
    // event-name → Set<handler>.  Lazy-allocated so engines with no
    // subscribers don't pay for the map.
    this._listeners = new Map()
    // Per-frame tick coalesce — when more than one renderer observes
    // the same engine (the split-pane case), each renderer's
    // onAfterFrame hook calls engine.tick().  Without a guard the sim
    // would advance N× per paint frame, doubling movement speed,
    // doubling fire rate, etc.  We keep the wall-clock of the most
    // recent tick and short-circuit any follow-up call that lands
    // within ENGINE_TICK_COALESCE_MS — typical browser rAF cadence is
    // ~16.7 ms (60 Hz) so a 3 ms window catches the cluster of
    // back-to-back per-renderer calls without affecting independent
    // per-frame drivers.  The cached result is returned so callers
    // that read it (rare — most ignore the return value) see what the
    // primary call computed.
    this._lastTickWallMs = 0
    this._lastTickResult = null
    // Active model-projectiles (missiles / rockets / bombs) the engine
    // simulates each tick — see projectiles.js.  Views read projectiles()
    // and render a 3DO mesh per entry.  Plain bullets / lasers / shells stay
    // on the lightweight particle path and never land here.
    this._projectiles = []
    this._nextProjId = 1
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
    // unit type, so spawning N of the same unit would have them share
    // Piece.move/rotate/visible and stomp each other's pose every
    // frame (only the LAST tick wins).  Clone the piece tree into a
    // per-instance Model that aliases the same GPU buffers but owns
    // its own animated state.  Models created via adoptUnit (single-
    // unit callers) skip this path entirely.
    const instModel = (model && typeof model.cloneForInstance === 'function')
      ? model.cloneForInstance()
      : model
    const cobUnit = cobScript ? this.runtime.addUnit(cobScript, {}) : null
    // Audio pool is host-supplied via the audioFactory option — keeps
    // the engine package free of any concrete audio implementation
    // (browser <audio>, headless no-op, future WebAudio mixer).
    const audio = this._audioFactory ? this._audioFactory() : null
    const binding = (cobUnit && instModel) ? new CobBinding(instModel, cobUnit, { audio }) : null
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
      // Per-unit COB port state.  Engine units used to share a single
      // global port object, which made per-unit edits in the Controls
      // panel impossible (everything routed to one bucket).  Each
      // engine unit now owns its own with the inspector renderer's
      // expected shape.  Defaults match the historical values so
      // standing-orders + activation behave identically across callers.
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
    // historical port indices so COB scripts behave identically across
    // modes.
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
      // damage scripts toggling ARMORED).  Standard setUnitValue hook
      // so script semantics stay consistent.
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
  // unit instance WITHOUT creating new ones.  Used by single-unit
  // callers to share their already-loaded unit with an engine
  // instance for the sole purpose of running the weapon SM through
  // the engine — the caller's CobRuntime + binding + model already
  // exist (the renderer creates them on model load), so the engine
  // should attach to them rather than instantiate a parallel set.
  // Same fields as addUnit populates, just sourced from outside.
  // Returns the UnitInstance.
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
    // We don't wire the getUnitValue hook here — the host is expected
    // to manage its own HEALTH / BUILD port wiring through its
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
      // run mid-flight gets the latest reset.  Pulling this logic into
      // the engine lets every caller share one source of truth.
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
  // the documented name callers should reach for.
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
  //   skipRuntime  — don't advance runtime.tick(dtMs).  Single-unit
  //                  callers pass this when their renderer ticks the
  //                  binding (and therefore the runtime) per-frame; the
  //                  engine is along for the ride only to drive weapon SMs.
  //   skipMovement — don't run #stepMovement / #stepAttack.  Single-unit
  //                  callers pass this when the host owns movement
  //                  (with aircraft altitude + ship wakes + manual ground
  //                  walk the engine doesn't model).
  //   skipSync     — don't run #syncBinding.  Single-unit callers pass
  //                  this when their renderer ticks the binding directly
  //                  and pushes its own worldOffset.
  tick(dtMs, { skipRuntime = false, skipMovement = false, skipSync = false } = {}) {
    // Coalesce duplicate ticks within the same paint frame.  When two
    // renderers observe the same engine (the split-pane case), each
    // renderer's onAfterFrame hook will call tick() back-to-back; we
    // only want the sim to advance once per frame so movement / fire
    // rate / runtime time-base all stay correct.  A ENGINE_TICK_COALESCE_MS
    // window catches that cluster without affecting independent
    // ~16.7 ms-cadence drivers.  Returns the cached result so callers
    // that read the runtime.tick() return see the value the primary
    // call produced.
    const wall = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now()
    if (this._lastTickWallMs !== 0 && (wall - this._lastTickWallMs) < ENGINE_TICK_COALESCE_MS) {
      return this._lastTickResult
    }
    this._lastTickWallMs = wall
    const insts = skipRuntime ? null : this.runtime.tick(dtMs)
    const paused = !!this.runtime.paused
    const dtSec = (dtMs * (this.runtime.playbackRate || 1)) / 1000
    const simNowMs = this.runtime.simTimeMs || 0
    for (const u of this._units.values()) {
      if (u.dead) continue
      // Pause gates EVERY autonomous-sim phase, not just runtime.tick.
      // Without this the COB scripts freeze but units keep walking +
      // firing because #stepMovement / #stepWeapons / #stepAttack all
      // use wall-clock dt.  Pause should look like a freeze frame.
      if (!skipMovement && !paused) {
        this.#stepAttack(u, simNowMs, dtSec)
        this.#stepMovement(u, dtSec)
      }
      if (!paused) this.#stepWeapons(u, simNowMs)
      if (!skipSync) this.#syncBinding(u, dtMs)
    }
    // Advance in-flight model-projectiles (missiles / rockets / bombs).
    // Engine-owned in BOTH views, so it runs regardless of skipMovement —
    // only the pause gate stops it, like every other sim phase.
    if (!paused) this.#stepProjectiles(dtSec)
    // Cross-unit dynamic-light aggregation is now pull-side — the
    // view's per-frame hook calls engine.getSceneLight() and pushes
    // the result to its own renderer.  The engine itself is fully
    // headless: no renderer ref, no _pushSceneLight side-effect.
    return insts
  }

  // getSceneLight scans every unit's particle pool for the brightest
  // live light-emitter and returns it as a plain object the host
  // view can forward to its renderer's single dynamic-light slot.
  // Returns null when no live light source exists (host clears the
  // slot).  Cross-unit by design — each unit's binding also exposes
  // its own getSceneLight for the single-binding renderer path, but
  // multi-entity hosts want the scene-wide brightest because the
  // renderer's per-binding tick isn't running there.  Score formula
  // (lightStrength · max(r,g,b) · alpha/alpha0) mirrors the binding's
  // so the two paths agree on which particle wins.
  //
  // Pure read.  The engine holds no renderer ref — pull-side
  // decoupling per the engine/renderer split (Phase D).
  getSceneLight() {
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
    if (bestIdx < 0 || !bestUnit) return null
    const p = bestUnit.binding.particles
    // Particle positions are in WORLD coords for multi-entity mode
    // (the binding's worldOffset has already been baked in by the
    // spawn helper) — pass through unchanged.
    return {
      pos: [p.x[bestIdx], p.y[bestIdx], p.z[bestIdx]],
      color: [p.r[bestIdx], p.g[bestIdx], p.b[bestIdx]],
      strength: p.lightStrength[bestIdx],
    }
  }

  // #stepAttack — the SINGLE movement decision for engagement, shared by
  // the sandbox and the unit viewer (both tick the engine; the views only
  // render the resulting u.pos / u.heading / u.pos.y).  Two engagement
  // sources feed it:
  //   • u.attackTarget — an autonomous unit pursuit (sandbox plain-attack
  //     a unit).  Ground units walk into range + arm slot 0; aircraft fly
  //     the attack pattern around the unit.
  //   • an armed weapon slot's aim point — a force-fire (sandbox shift-
  //     click ground/ally, OR the unit viewer where EVERY shot is a force-
  //     fire at a clicked point).  Aircraft fly the same pattern around the
  //     point; ground units fire in place (the weapon SM aims + range-gates
  //     — they don't chase a clicked point).
  // Damage application happens in #stepWeapon on each shot.
  #stepAttack(u, _simNowMs, dtSec = 0) {
    // ── Tear down a dead / departed autonomous unit attackTarget ──
    const t = u.attackTarget
    if (t && (t.dead || !this._units.has(t.id))) {
      u.attackTarget = null
      // Withdraw every attack-tagged weapon slot so it stops firing at a
      // phantom enemy.  Manual (force-fire) slots are left alone.  A bomb run
      // in progress survives target death — the slot was already locked to
      // the cached aim point, so leave it alone and let the run finish.
      for (let slot = 0; slot < 3; slot++) {
        const s = u.weaponSlots[slot]
        if (s.target && s.target.source === 'attack') {
          if (u._bombRun && u._bombRun.slot === slot) continue
          this.setWeaponTarget(u.id, slot, null)
        }
      }
      // Drop a pursuit-issued moveTarget aimed at the dead prey's coffin
      // (walk-into-range rewrites it to the prey's position each tick), so
      // the unit doesn't keep walking to a corpse's spot after the kill.
      if (u.moveTarget &&
          Math.abs(u.moveTarget.x - t.pos.x) < 1 &&
          Math.abs(u.moveTarget.z - t.pos.z) < 1) {
        u.moveTarget = null
      }
    }

    // ── Sweep stale attack-tagged slots when there's no engagement ──
    // If the user issued Move (which clears attackTarget directly, not via
    // target-death) and no bomb run is in progress, the attack-tagged slot
    // would otherwise keep auto-firing forever.  A committed bomb run is the
    // ONE exception — those slots persist until their cached run completes.
    if (!u.attackTarget && !u._bombRun) {
      for (let slot = 0; slot < 3; slot++) {
        const s = u.weaponSlots[slot]
        if (s.target && s.target.source === 'attack') {
          this.setWeaponTarget(u.id, slot, null)
        }
      }
    }

    const canMove = !u.meta || u.meta.canMove !== false

    // ── Aircraft: fly an attack maneuver around whatever it's engaging ──
    // Gunships strafe an arc around the engagement; fixed-wing aircraft run
    // fly-by passes.  A live Move order overrides the maneuver (Move cancels
    // Attack, as in TA) — #stepMovement drives the move and the weapon SM
    // still fires if a pass brings the target into range.  #stepMovement
    // keeps the aircraft at cruise altitude while u._atk is set.
    if (canMove && u.meta && u.meta.isAircraft && dtSec > 0) {
      let ex = null, ez = null, eslot = 0, armUnit = null
      if (u.attackTarget && !u.attackTarget.dead) {
        armUnit = u.attackTarget; ex = armUnit.pos.x; ez = armUnit.pos.z
      } else {
        for (let s = 0; s < 3; s++) {
          const p = this.#slotAimXZ(u, s)
          if (p) { ex = p.x; ez = p.z; eslot = s; break }
        }
      }
      if (ex == null) { u._atk = null; return }
      const eweapon = this.#weaponForSlot(u, eslot)
      // Bombers (fixed-wing aircraft whose engaged weapon is a `dropped` bomb)
      // stay on approach until they're directly over the target so the bomb run
      // lays bombs along the target itself, not 40% of range short of it.
      const bomberMode = !!(eweapon && eweapon.dropped)
      // Drop-window half-length — re-derived here from the same weapon TDF
      // fields as the bomb-run gate in #stepWeapon (areaofeffect × 4 / spacing,
      // where spacing = carrier-speed × reload).  Passing it to attackManeuver
      // lets the bomber hold heading through the entire string and only bank
      // once it has flown clear of the FAR edge, so all 4-ish bombs land on a
      // straight line instead of curving away after bomb 2.  A small buffer
      // past the last release point keeps the bomber from cutting the run
      // short on the trailing edge.
      let bomberPassthrough = 0
      if (bomberMode && eweapon) {
        const carrierSpeed = Math.max(1, u.speed || 0)
        const reloadSec = (eweapon.reloadSec > 0) ? eweapon.reloadSec : 0.18
        const spacing = carrierSpeed * reloadSec
        const desiredRun = (eweapon.areaOfEffectWU > 0 ? eweapon.areaOfEffectWU : 32) * 4
        const bombsTotal = Math.max(2, Math.ceil(desiredRun / spacing))
        const halfRun = ((bombsTotal - 1) * spacing) / 2
        bomberPassthrough = Math.min(600, halfRun + 30)
      }
      // Move usually preempts the attack maneuver — the player asked the unit
      // to go somewhere, so the aircraft drops its pattern and obeys.  Bombers
      // are different: an attack-ground order is a sticky patrol-and-bomb task
      // in TA, and the player issuing Move mid-cycle is most often the bomb-
      // and-bail tactic (bombs already arming, the move just brings the carrier
      // home).  For those, the maneuver wins and the Move is queued (slot or
      // active bomb run keeps it on the run; Stop / new target is the only way
      // to abandon).  Non-bomber aircraft fall back to the original rule.
      const stickyBomber = bomberMode &&
        (u._bombRun || u.weaponSlots.some((s) => s.target && s.target.source === 'manual'))
      if (u.moveTarget && !stickyBomber) { u._atk = null; return }
      const range = this.#weaponRangeFor(u, eslot)
      // flybySide starts random so a flight of bombers attacking the same
      // target scatters to both sides on the first pass; the maneuver
      // toggles the sign on every subsequent egress so an individual
      // aircraft still alternates (figure-eight) across its own runs.
      if (!u._atk) u._atk = { atkPhase: 'approach', sweepPhase: 0, sweepCenter: null, egX: 0, egZ: 0, flybySide: Math.random() < 0.5 ? -1 : 1 }
      const st = {
        x: u.pos.x, z: u.pos.z, heading: u.heading, speed: u.speed || 0,
        atkPhase: u._atk.atkPhase, sweepPhase: u._atk.sweepPhase, sweepCenter: u._atk.sweepCenter,
        egX: u._atk.egX, egZ: u._atk.egZ, flybySide: u._atk.flybySide,
      }
      attackManeuver(st, ex, ez, u.meta, range, dtSec, { bomberMode, bomberPassthroughDist: bomberPassthrough })
      u.pos.x = st.x; u.pos.z = st.z; u.heading = st.heading; u.speed = st.speed
      u._atk = {
        atkPhase: st.atkPhase, sweepPhase: st.sweepPhase, sweepCenter: st.sweepCenter,
        egX: st.egX, egZ: st.egZ, flybySide: st.flybySide,
      }
      u.moveTarget = null   // maneuver owns movement; don't let #stepMovement double-drive
      // Auto-arm slot 0 only for autonomous unit pursuit — a force-fire slot
      // is already armed by the caller and re-arming would reset its aim.
      if (armUnit) this.setWeaponTarget(u.id, 0, { unit: armUnit }, { source: 'attack' })
      return
    }

    // ── Ground / ship / sub: walk into range of an autonomous unit ──
    // Only a unit attackTarget triggers the chase; force-fire points fire in
    // place via the weapon SM's own range gate.
    const at = u.attackTarget
    if (!at || at.dead) return
    const dist = Math.hypot(at.pos.x - u.pos.x, at.pos.z - u.pos.z)
    const range = this.#weaponRangeFor(u, 0)
    if (dist > range) {
      // Out of range — re-aim the move command at the prey's CURRENT
      // position each tick (target may be running) and drop slot 0's
      // weapon target so the SM doesn't burn aim threads while we walk.
      u.moveTarget = { x: at.pos.x, z: at.pos.z }
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
    this.setWeaponTarget(u.id, 0, { unit: at }, { source: 'attack' })
  }

  // #slotAimXZ returns the world XZ a weapon slot is currently aiming at
  // (its armed point, or a live unit target's position), or null when the
  // slot is unarmed / its unit target is gone.  Lets the aircraft attack
  // maneuver follow whatever the unit is actually trying to shoot — the key
  // to force-fire-at-point flying the same pattern as attack-a-unit.
  #slotAimXZ(u, slot) {
    const s = u.weaponSlots[slot]
    if (!s || !s.target) return null
    if (s.target.type === 'point' && s.target.point) {
      return { x: s.target.point[0], z: s.target.point[2] }
    }
    if (s.target.type === 'unit' && s.target.unit && !s.target.unit.dead) {
      return { x: s.target.unit.pos.x, z: s.target.unit.pos.z }
    }
    return null
  }

  // #stepMovement turns the unit toward its move-target at FBI
  // TurnRate, then walks forward at MaxVelocity once aligned.
  // Edge-triggers StartMoving / StopMoving scripts on isMoving
  // transitions so kbot/tank leg loops kick in/out properly.
  #stepMovement(u, dtSec) {
    const wasMoving = !!u.isMoving
    // Structures with no MaxVelocity in their FBI are explicitly
    // immobile — the FBI omits the field for factories (Adv. Aircraft
    // Plant, ARMLAB), power plants, and other buildings.  TA UX still
    // permits the player to drop a "move waypoint" on a factory so the
    // units it BUILDS inherit that order, but the factory itself does
    // not relocate.  Honour that: a u.moveTarget on a non-movable unit
    // is allowed as a stored waypoint (other systems may consume it),
    // we just don't apply per-tick translation here.  Without this
    // guard the `else 30` fallback below was treating a missing speed
    // as 30 wu/sec and walking factories across the field.
    const canMove = !u.meta || u.meta.canMove !== false
    if (u.moveTarget && canMove) {
      // Shared drive-and-steer integrator: the unit translates while it turns
      // toward the target so its path curves in an arc (turn radius =
      // speed / turnRate, both straight from the FBI), ramping up under
      // Acceleration and braking into the goal under BrakeRate.  The same
      // helper backs the unit-editor's Move so both views drive identically.
      const st = { x: u.pos.x, z: u.pos.z, heading: u.heading, speed: u.speed || 0 }
      const r = stepSurfaceLocomotion(st, u.moveTarget.x, u.moveTarget.z, u.meta, dtSec)
      u.pos.x = st.x
      u.pos.z = st.z
      u.heading = st.heading
      u.speed = st.speed
      if (r.arrived) {
        u.moveTarget = null
        u.isMoving = false
      } else {
        u.isMoving = true
      }
    } else if (u.meta && u.meta.isAircraft && u._atk && canMove) {
      // Attacking aircraft fly their pattern in #stepAttack (which runs just
      // before this and clears u.moveTarget so it "owns" movement): that step
      // already advanced u.pos/heading and ramped u.speed via attackManeuver.
      // Mark the unit as moving and leave its speed UNTOUCHED — the plain
      // `else` below would zero u.speed every tick, restarting the maneuver
      // from a standstill so the aircraft could never accelerate or fly its
      // arc.  The altitude block then keeps it at cruise.
      u.isMoving = true
    } else {
      u.isMoving = false
      u.speed = 0
    }
    // Aircraft altitude — lift to cruise while the unit has somewhere to be
    // (a move target or an active fire order), and settle to the ground once
    // it's idle with no orders so it lands.  Drives u.pos.y, which the sandbox
    // reads into each entity's transform, so aircraft visibly take off + land.
    // Climb / descent rates come from the FBI Acceleration / BrakeRate.
    if (u.meta && u.meta.isAircraft) {
      const hasFireOrder = u.weaponSlots && u.weaponSlots.some((s) => s.target)
      const airborne = u.isMoving || hasFireOrder
      // Cruise ceiling: a host may supply u.cruiseAltOverride to cap the
      // altitude for its camera (the unit viewer's close-up showroom clamps
      // a Hawk's 110 wu cruise so it stays framed).  The sandbox leaves it
      // unset and uses the raw FBI CruiseAltitude.  The climb/descend physics
      // + airborne decision below are identical either way — only the ceiling
      // differs, which is a per-view display concern, not a motion one.
      const cruise = (u.cruiseAltOverride > 0)
        ? u.cruiseAltOverride
        : ((u.meta.cruiseAltitude > 0)
          ? u.meta.cruiseAltitude : (u.meta.isHover ? 60 : 100))
      const altTarget = airborne ? cruise : 0
      const accel = (u.meta.acceleration > 0) ? u.meta.acceleration : 0.1
      const brake = (u.meta.brakeRate > 0) ? u.meta.brakeRate : 0.1
      const climbRate = Math.max(12, Math.min(80, accel * 100))
      const descendRate = Math.max(8, Math.min(40, brake * 10))
      const cur = u.pos.y || 0
      const rate = (altTarget > cur) ? climbRate : descendRate
      const step = rate * dtSec
      u.pos.y = (Math.abs(altTarget - cur) <= step)
        ? altTarget
        : cur + Math.sign(altTarget - cur) * step
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

  // #stepWeapon drives the aim thread lifecycle, reload timing, and burst cycling
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
    // Pre-Create gate: firing during the Create script causes static-
    // var reads before Create has initialised them.  Only consulted
    // when _lifecycle is set (single-unit callers write it; multi-
    // entity auto-Create never does, so the gate silently passes through).
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
    // Range gate — a unit only opens fire when the target is within this
    // slot's weapon range (from the weapon TDF).  Out-of-range targets get
    // chased into range by #stepAttack rather than shot at from afar.  Gates
    // the START of a burst only, so a volley that began in range still
    // empties even if the shooter drifts out mid-burst (e.g. a fly-by pass).
    // Applies to attack + manual targets, sandbox + unit-viewer alike.
    let tgx = null, tgz = null
    if (state.target.type === 'point' && state.target.point) { tgx = state.target.point[0]; tgz = state.target.point[2] }
    else if (Array.isArray(target)) { tgx = target[0]; tgz = target[2] }
    const inWeaponRange = (tgx == null) ||
      (Math.hypot(tgx - u.pos.x, tgz - u.pos.z) <= this.#weaponRangeFor(u, slot) * 1.05)
    // Aim-tolerance gate — the weapon TDF `tolerance` (TA angle units) is the
    // arc within which the unit may open fire.  Aircraft aim by pointing the
    // whole airframe (no rotating turret), so we compare the BODY heading to
    // the target bearing: the ARM Hawk's missile (tolerance 8000 ≈ 44°) only
    // fires once it's lined up, and the attack maneuver turns it to face first.
    // Turreted ground units aim via their COB AimX turret (the aim-thread gate
    // below already enforces their arc), so the body constraint is skipped for
    // them.  Gates the START of a burst, like the range gate.
    const inAimTolerance = this.#withinFireArc(u, w, tgx, tgz)
    // Drop-window gate for bombers: a `dropped` weapon on an aircraft only
    // STARTS firing when the carrier is close enough to the target that the
    // run will straddle it — first bomb dropped before, last bomb after, with
    // the centre of the string on the target.  Distance derived purely from
    // the weapon TDF: a run spread roughly 4 blast diameters along the flight
    // path, divided by the bomb spacing (carrier speed × reload) to pick the
    // bomb count, and half of that distance becomes the trigger range.  Once
    // a run is in progress (u._bombRun) the gate is suspended — bombs keep
    // dropping until the cached count empties even if the user issues Move.
    let inBombDropWindow = true
    if (w.dropped && u.meta && u.meta.isAircraft && tgx != null) {
      if (u._bombRun && u._bombRun.slot === slot) {
        inBombDropWindow = true   // committed run
      } else {
        const carrierSpeed = Math.max(1, u.speed || 0)
        const reloadSec = (w.reloadSec > 0) ? w.reloadSec : 0.18
        const spacing = carrierSpeed * reloadSec
        const desiredRun = (w.areaOfEffectWU > 0 ? w.areaOfEffectWU : 32) * 4
        const bombsTotal = Math.max(2, Math.ceil(desiredRun / spacing))
        const halfRun = ((bombsTotal - 1) * spacing) / 2
        const dist = Math.hypot(tgx - u.pos.x, tgz - u.pos.z)
        inBombDropWindow = dist <= halfRun
      }
    }
    const startBurst = !inBurst && reloadReady && (aimDoneOk || aimStuck) && inWeaponRange && inAimTolerance && inBombDropWindow
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
      // Model weapons (missiles / rockets / bombs) fly a simulated 3DO mesh
      // the engine owns; the view renders it and skips the dead-reckoned
      // particle.  The flag rides the 'fire' event so the particle path can
      // bow out for these while still playing the muzzle sound / smoke.
      const isModelProj = hasModelProjectile(w)
      this.emit('fire', {
        unit: u,
        slot,
        slotName,
        weapon: w,
        anchor,
        target,
        modelProjectile: isModelProj,
      })
      if (isModelProj) this.#spawnProjectile(u, slot, w, anchor, state.target, target)
      // Bomb-run bookkeeping (dropped weapons on aircraft).  The first shot in
      // a run snapshots the aim point + total bomb count so subsequent shots
      // keep dropping at the cached point — even if the user issues Move (the
      // TA "bomb-and-bail" tactic).  Slot is rebound to the cached point so
      // attackTarget death / clearance can't drift the run mid-flight.
      if (w.dropped && u.meta && u.meta.isAircraft) {
        if (!u._bombRun) {
          const carrierSpeed = Math.max(1, u.speed || 0)
          const reloadSec = (w.reloadSec > 0) ? w.reloadSec : 0.18
          const spacing = carrierSpeed * reloadSec
          const desiredRun = (w.areaOfEffectWU > 0 ? w.areaOfEffectWU : 32) * 4
          const bombsTotal = Math.max(2, Math.ceil(desiredRun / spacing))
          // Snapshot the aim point + remember the original arming source so
          // the run-end logic knows whether to recycle (force-fire ground)
          // or stop (autonomous unit attack — let #stepAttack re-engage).
          const originalSource = (state.target && state.target.source) || 'attack'
          let pt = null
          if (state.target.type === 'point' && state.target.point) pt = state.target.point.slice()
          else if (state.target.type === 'unit' && state.target.unit) {
            const tu = state.target.unit
            pt = [tu.pos.x, (tu.pos.y || 0), tu.pos.z]
            // Re-arm the slot at the cached point so the run's range / aim /
            // drop-window gates evaluate against the locked spot, not the
            // live unit (which might walk out of the window or die mid-run).
            // Preserve the original source tag so the Move-sweep and run-end
            // logic still see the run as "autonomous attack".
            this.setWeaponTarget(u.id, slot, { point: pt }, { source: originalSource })
          } else if (Array.isArray(target)) pt = [target[0], target[1], target[2]]
          if (pt) u._bombRun = { slot, point: pt, bombsLeft: bombsTotal, originalSource }
        }
        if (u._bombRun && u._bombRun.slot === slot) {
          u._bombRun.bombsLeft--
          if (u._bombRun.bombsLeft <= 0) {
            const originalSource = u._bombRun.originalSource
            u._bombRun = null
            // Force-fire (the user shift+clicked ground) is a sticky
            // "patrol-and-bomb here" order in TA — leave the slot armed so
            // the bomber loops back, reloads, and lays another string.  An
            // autonomous unit attack instead RELEASES the slot at the end of
            // the run, letting #stepAttack re-engage on the next tick: the
            // attackTarget may be dead, hiding, or out of reach.
            if (originalSource !== 'manual') {
              this.setWeaponTarget(u.id, slot, null)
            }
          }
        }
      }
      // Hit-scan damage for unit-vs-unit fire.  Plain bullets / lasers / shells
      // resolve damage at fire time (the engine doesn't yet model their per-
      // projectile flight + impact).  MODEL projectiles fly a real mesh and
      // apply blast-radius damage when they detonate via #stepProjectiles, so
      // skip the hit-scan path for those — otherwise a Thunder bomb would
      // damage the target twice (once on release, once on impact).  Point
      // targets (manual fire-at-ground) never deliver hit-scan damage either.
      if (!isModelProj &&
          state.target && state.target.type === 'unit' && state.target.unit && !state.target.unit.dead) {
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
      // commandFire weapons normally clear the target after one full burst
      // when the shot was manually issued — matches TA's D-key one-shot
      // behaviour (the user re-arms + clicks for a second discharge).
      // EXCEPTIONS:
      //   1. AUTONOMOUS attack arming (source 'attack' — set by #stepAttack
      //      to chase a unit) must keep the target so the cycle re-fires on
      //      the weapon's reload cadence.
      //   2. Aircraft `dropped` weapons re-fire on every pass — the cycle is
      //      the bomb run itself, not one-click-per-shot.  Preserving the
      //      slot lets a force-fire ground order patrol-and-bomb forever the
      //      way a TA bomber on a sticky attack-ground task does.
      //   3. The bomb-run block above may have cleared state.target on the
      //      run's last shot; the branch then has nothing left to clear, so
      //      just exit the slot for this tick.
      if (w.commandFire) {
        if (!state.target) return
        const isAirDropped = w.dropped && u.meta && u.meta.isAircraft
        if (!isAirDropped && state.burstShotsLeft === 0 && state.target.source !== 'attack') {
          state.target = null
          return
        }
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
  // #stepAttack to decide walk-or-fire.  Falls back to a generous
  // default when the unit has no weapon meta yet (FBI fetch races
  // the first attack order on freshly-spawned units).
  #weaponRangeFor(u, slot) {
    const w = this.#weaponForSlot(u, slot)
    if (w && w.rangeWU > 0) return w.rangeWU
    return 220
  }

  // weaponRangeFor — public accessor for slot N's engagement range (wu), so
  // the unit-editor's own mover can reuse the exact range the engine weapon
  // SM gates firing on (keeps editor + sandbox consistent).
  weaponRangeFor(unitId, slot) {
    const u = this._units.get(unitId)
    return u ? this.#weaponRangeFor(u, slot) : 220
  }

  // #withinFireArc enforces the weapon TDF `tolerance` (TA angle units, where
  // 65536 = a full turn) as a yaw firing arc.  Aircraft aim by pointing the
  // whole airframe — there's no rotating turret — so the body heading must be
  // within tolerance of the target bearing before the weapon may open fire
  // (the attack maneuver turns the unit to face first).  Turreted ground units
  // aim via their COB AimX turret, whose completion is gated separately by the
  // aim thread, so the body arc doesn't constrain them.  Returns true when
  // there's no target XZ, no tolerance specified, or the unit isn't an
  // airframe — i.e. "no constraint".
  #withinFireArc(u, w, tgx, tgz) {
    if (tgx == null) return true
    const tol = (w && w.tolerance > 0) ? w.tolerance : 0
    if (!tol || !u.meta || !u.meta.isAircraft) return true
    const bearing = Math.atan2(tgx - u.pos.x, tgz - u.pos.z)
    return Math.abs(shortestArc(bearing - u.heading)) <= angleToRadians(tol)
  }

  // projectiles — the live model-projectile list (missiles / rockets / bombs)
  // for the views to render.  Read-only; the engine owns the array.
  projectiles() { return this._projectiles }

  // #spawnProjectile registers one in-flight model weapon from a fire event.
  // Resolves the aim point (and the live unit id for homing), captures the
  // firing unit's velocity so a dropped bomb falls forward along its track,
  // and hands the rest to makeProjectile (all rates come from the weapon TDF).
  #spawnProjectile(u, slot, w, anchor, stateTarget, resolvedTarget) {
    let tgtPoint = null, tgtUnitId = null
    // stateTarget is the SM's normalised record ({type:'unit',unit} | {type:'point',point}).
    // resolvedTarget is the array returned by #resolveTarget — [x, y+lift, z] for a
    // unit, or the raw point for a point target.  For homing, we want the live unit
    // id off stateTarget; the aim coordinates come from the resolved array.
    if (stateTarget && stateTarget.type === 'unit' && stateTarget.unit && !stateTarget.unit.dead) {
      const tu = stateTarget.unit
      tgtPoint = [tu.pos.x, tu.pos.y, tu.pos.z]
      tgtUnitId = tu.id
    } else if (Array.isArray(resolvedTarget)) {
      tgtPoint = resolvedTarget
    } else if (stateTarget && stateTarget.type === 'point' && stateTarget.point) {
      tgtPoint = stateTarget.point
    }
    if (!tgtPoint) return
    const proj = makeProjectile({
      id: this._nextProjId++, ownerId: u.id, slot, weapon: w,
      anchor, target: tgtPoint, targetUnitId: tgtUnitId, gravity: this.gravity,
    })
    this._projectiles.push(proj)
    this.emit('projectile-spawn', { projectile: proj })
  }

  // #stepProjectiles advances every live model-projectile one tick, lets a
  // guided shot re-home on a still-living unit target, and emits
  // 'projectile-hit' (with hit=true if it reached the target vs. timed out)
  // as each expires.  Dead entries are compacted out after the pass.
  #stepProjectiles(dtSec) {
    if (this._projectiles.length === 0 || dtSec <= 0) return
    let anyDead = false
    for (const p of this._projectiles) {
      if (p.dead) { anyDead = true; continue }
      let opts
      if (p.targetUnitId != null) {
        const t = this._units.get(p.targetUnitId)
        if (t && !t.dead) opts = { targetPos: t.pos }
      }
      stepProjectile(p, dtSec, opts)
      if (p.dead) {
        anyDead = true
        // Area-of-effect damage on detonation: every live non-owner unit within
        // the weapon's blast radius takes the weapon's base damage, falling off
        // linearly to 25% at the edge.  Without this, dropped bombs that lay
        // along a target point (the "bomb-and-bail" Move case) hit visually but
        // do no damage — the hit-scan path only fires when the firing slot still
        // names the unit at trigger time.  Skips when the projectile timed out
        // mid-air rather than detonating.
        if (p.hit && p.aoeWU > 0) {
          const r = p.aoeWU
          const ownerId = p.ownerId
          for (const t of this._units.values()) {
            if (!t || t.dead || t.id === ownerId) continue
            const d = Math.hypot(t.pos.x - p.pos.x, t.pos.z - p.pos.z)
            if (d > r) continue
            const falloff = 1 - 0.75 * (d / r)
            this.applyDamage(ownerId, t.id, DEFAULT_HIT_DAMAGE * falloff)
          }
        }
        this.emit('projectile-hit', {
          projectile: p,
          pos: [p.pos.x, p.pos.y, p.pos.z],
          hit: p.hit,
          weaponName: p.weaponName,
        })
      }
    }
    if (anyDead) this._projectiles = this._projectiles.filter((p) => !p.dead)
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
    if (!piece) return fallback
    // Resolve against the unit's live transform (see #pieceWorldPos) so
    // the aim origin tracks the moved unit even when the engine's model
    // clone is never drawn.  Falls back to the raw worldMatrix then the
    // unit centre.
    if (typeof u.model.resolvePieceWorld === 'function') {
      const w = u.model.resolvePieceWorld(piece, u.pos.x, u.pos.y, u.pos.z, u.heading + Math.PI)
      if (w) return w
    }
    if (!piece.worldMatrix) return fallback
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

  // #pieceWorldPos returns the post-COB-anim WORLD position of a piece
  // (the muzzle a projectile exits from).  See the body for why we
  // recompute against the unit's live transform rather than trusting
  // piece.worldMatrix, and for the fallbacks.
  #pieceWorldPos(u, piece) {
    // Compose the piece's COB-animated model-local pose with the unit's
    // live world transform.  In the sandbox the engine animates a
    // per-instance model clone that NO renderer ever draws (each pane
    // draws its own pose-copy), so reading piece.worldMatrix straight
    // would hand back the identity matrix the clone was built with and
    // anchor every shot at the world origin.  resolvePieceWorld walks
    // the tree against translate(pos)·rotateY(heading + π) — the same
    // chain #refreshEntities / _applyRendererTransform feed the renderer
    // (the +π mirrors the loader's X-flip) — so the muzzle tracks the
    // unit wherever it has moved.  Falls back to the raw worldMatrix (a
    // model the renderer DID draw) then the unit centre.
    if (piece && u.model && typeof u.model.resolvePieceWorld === 'function') {
      const w = u.model.resolvePieceWorld(piece, u.pos.x, u.pos.y, u.pos.z, u.heading + Math.PI)
      if (w) return w
    }
    if (piece && piece.worldMatrix) {
      const m = piece.worldMatrix
      return [m[12], m[13], m[14]]
    }
    return [u.pos.x, u.pos.y + 14, u.pos.z]
  }

  // #aimAnglesFor returns TA-unit heading + pitch for the slot's
  // AimX(heading, pitch) call.
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
