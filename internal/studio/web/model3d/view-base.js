// view-base.js
//
// Shared base for the Unit Editor (MvControls) and the Sandbox
// (SandboxView).  Owns the scaffolding both views were reimplementing
// independently:
//
//   - Status-line text helper
//   - Engine event subscription bookkeeping (auto-cleanup on dispose)
//   - SmokeTrailManager lifecycle + per-frame tick
//   - Hotkey wiring (delegates to unit-hotkeys.js)
//   - Sim-time scaling helper that respects runtime.paused + playback
//     rate uniformly across views
//   - The "fan-out an order to every selected unit" Command API:
//     issueMove, issueAttack, issueArmedFire, stop
//   - Camera tracking helpers: trackFirstSelected, untrack, toggleTracking
//   - getInspectorMv() abstract — each view returns the proxy shape
//     studio.js's refreshMvInspectors panels expect, so the inspector
//     loop becomes view-agnostic
//
// Subclasses override the following getters / methods:
//
//   get engine          — the GameEngine instance backing this view
//   get runtime         — the CobRuntime (typically engine.runtime)
//   get camera          — the OrbitCamera, optional (some views may
//                         not have one yet during init)
//   getSelectedUnits()  — Array<UnitInstance> currently selected.
//                         Single-unit views return their one unit.
//                         Multi-unit views map their selection set.
//   getInspectorMv()    — return the shape studio.js's panel
//                         renderers consume:
//                           { camera, renderer, cob: { runtime, unit?,
//                             particles?, audio?, hasScript?, ... } }
//
// Subclasses MUST call super() in their constructor.  No required
// constructor arguments — config flows through the getters above so
// SandboxView and MvControls can hand back their own state structures
// (this.scene, this.viewer) without contorting a base-class signature.

import { SmokeTrailManager } from './weapon-driver.js'
import { attachUnitHotkeys } from './unit-hotkeys.js'

export class BaseView {
  constructor() {
    // Engine subscriptions captured here so disposeBase() can detach
    // every listener in one sweep — views that subscribe directly via
    // engine.on(...) lose handler refs across hot-reload / tab swap
    // unless someone tracks them.
    this._engineSubs = []
    // SmokeTrailManager — lazy.  initSmokeTrails() builds one on
    // demand; subclass per-frame tick code calls tickSmokeTrails().
    this._smokeTrails = null
    // Status DOM element — subclasses point this at their own DOM
    // (sandbox has a per-tab statusEl; viewer has a single shared one
    // off ModelViewer).  setStatus() is a no-op when unset.
    this._statusEl = null
    // Detach closure returned by attachUnitHotkeys; cleared in
    // disposeBase().
    this._hotkeysDetach = null
  }

  // ── Subclass surface (NOT defined as getters here) ────────────────
  //
  // Subclasses expose engine / runtime / camera in whichever shape
  // fits — SandboxView assigns them as plain instance fields in
  // open(); MvControls returns them through getters that delegate
  // into this.viewer.cob / this.viewer.renderer.  Defining them as
  // getters on BaseView would shadow a subclass field-assignment
  // ("Cannot set property camera of #<BaseView> which has only a
  // getter"), so we just document the contract here and let the
  // subclass's own definition win.  BaseView reads them through
  // `this.engine` / `this.runtime` / `this.camera` and either form
  // works.  Default behaviour when a subclass forgets to provide
  // one: undefined — the Command-API helpers below guard on that.

  getSelectedUnits() { return [] }

  // getInspectorMv returns the shape studio.js's panel renderers
  // expect.  Default is a stub — every concrete view should override
  // and return a real mv-like object.
  getInspectorMv() {
    return {
      camera: this.camera || null,
      renderer: null,
      cob: {
        runtime: this.runtime,
        unit: null,
        hasScript: () => false,
        _lifecycle: 'created',
      },
    }
  }

  // ── Status line ───────────────────────────────────────────────────

  setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text
  }

  // ── Smoke-trail lifecycle ─────────────────────────────────────────

  initSmokeTrails() {
    if (!this._smokeTrails) this._smokeTrails = new SmokeTrailManager()
    return this._smokeTrails
  }

  // tickSmokeTrails advances the trail manager at the SIM clock rate.
  // Pause freezes the trails entirely (rate = 0), so puffs stop
  // streaming out of a frozen missile.  Returns the scaled dt the
  // caller can reuse for their own sub-systems if convenient.
  tickSmokeTrails(dtMs) {
    const rate = this.simRate()
    const dtSimMs = dtMs * rate
    if (this._smokeTrails) this._smokeTrails.tick(dtSimMs)
    return dtSimMs
  }

  // simRate returns the playback-rate multiplier honouring pause.
  // 0 when paused, otherwise runtime.playbackRate (or 1 when there's
  // no runtime yet).  Centralised so every subsystem (particles,
  // smoke trails, audio cadence, sub-frame interp) reads from one
  // place.
  simRate() {
    const rt = this.runtime
    if (!rt) return 1
    if (rt.paused) return 0
    return rt.playbackRate || 1
  }

  // ── Engine event subscriptions ────────────────────────────────────

  // subscribeEngine attaches a handler to the engine and remembers the
  // unsubscribe closure so disposeBase() tears it down.  Returns the
  // unsubscribe closure too in case the caller wants to detach early.
  subscribeEngine(eventName, handler) {
    const eng = this.engine
    if (!eng) return () => {}
    const unsub = eng.on(eventName, handler)
    this._engineSubs.push(unsub)
    return unsub
  }

  // ── Hotkey wiring ─────────────────────────────────────────────────

  // wireHotkeys attaches the shared unit-hotkey keymap.  Callers
  // pass adapter callbacks because viewer and sandbox route commands
  // differently (sandbox.setPendingCommand vs viewer._armSlotHotkey).
  // Replaces any previously-wired detach.  See unit-hotkeys.js for
  // the keymap definition.
  wireHotkeys(opts) {
    if (this._hotkeysDetach) {
      try { this._hotkeysDetach() } catch { /* ignore */ }
    }
    this._hotkeysDetach = attachUnitHotkeys(opts)
  }

  // ── Command API ───────────────────────────────────────────────────

  // issueMove fans a Move order out to every currently selected unit.
  // Cleans the autonomous attackTarget so #stepAttack stops overriding
  // moveTarget; surgically clears attack-source weapon slots (manual
  // fire stays alive so the user can keep shooting while reposition-
  // ing — TA muscle-memory).  Plays the ok1-bank ack on the first
  // unit (single voice so a 10-unit selection doesn't fire a chorus).
  // Returns the number of units updated.
  //
  // Formation move: when multiple units are selected, each unit walks
  // to (point + (unit.pos - centroid)) instead of stacking onto a
  // single tile.  That preserves the group's relative layout — a row
  // of three units stays a row at the destination, not a clump.  We
  // compute the centroid in one pass over the living selection so a
  // dead unit in the set doesn't skew the formation centre.  Single-
  // unit selection trivially has offset = 0 so the destination is
  // exactly the clicked point.
  issueMove(point) {
    const engine = this.engine
    const units = this.getSelectedUnits()
    if (!engine || !units.length || !point) return 0
    const live = units.filter((u) => u && !u.dead)
    if (!live.length) return 0
    let cx = 0, cz = 0
    for (const u of live) { cx += u.pos.x; cz += u.pos.z }
    cx /= live.length
    cz /= live.length
    let n = 0
    for (const u of live) {
      const offX = u.pos.x - cx
      const offZ = u.pos.z - cz
      u.moveTarget = { x: point[0] + offX, z: point[2] + offZ }
      u.attackTarget = null
      if (u.weaponSlots) {
        for (let slot = 0; slot < 3; slot++) {
          const s = u.weaponSlots[slot]
          if (s && s.target && s.target.source === 'attack') {
            engine.setWeaponTarget(u.id, slot, null)
          }
        }
      }
      n++
    }
    if (n > 0) this.playUnitSoundRandom(live[0], ['ok1', 'ok2', 'ok3', 'ok4', 'ok5'])
    return n
  }

  // issueAttack arms the autonomous attack-loop on a unit target.
  // The engine's #stepAttack walks each pursuer into range, then sets
  // its slot 0 weapon target so firing happens automatically once
  // aligned.  Skips self-targeting so a select-all + attack-target on
  // a member of the selection doesn't have units shooting themselves.
  // Plays the ok1-bank ack on the first pursuer (single voice).
  issueAttack(targetUnit) {
    const units = this.getSelectedUnits()
    if (!units.length || !targetUnit) return 0
    let n = 0
    let firstPursuer = null
    for (const u of units) {
      if (!u || u.dead || u === targetUnit) continue
      u.attackTarget = targetUnit
      if (!firstPursuer) firstPursuer = u
      n++
    }
    if (firstPursuer) this.playUnitSoundRandom(firstPursuer, ['ok1', 'ok2', 'ok3', 'ok4', 'ok5'])
    return n
  }

  // issueArmedFire targets a specific weapon SLOT — used by the armed-
  // Primary/Secondary/Tertiary cursor flow.  Accepts either a unit
  // (live-tracked aim point) or a [x,y,z] point (force-fire ground
  // location).  source tagging lets the autonomous attack loop tell
  // its own 'attack'-tagged slots apart from user-issued 'manual'
  // ones — see #stepAttack's cleanup branch.
  issueArmedFire(slotIdx, target, source = 'manual') {
    const engine = this.engine
    const units = this.getSelectedUnits()
    if (!engine || !units.length) return 0
    let n = 0
    for (const u of units) {
      if (!u || u.dead) continue
      if (target == null) {
        engine.setWeaponTarget(u.id, slotIdx, null)
      } else if (target.pos !== undefined) {
        // Unit ref — set attackTarget too so the engine walks the
        // unit into range when the target is out of weapon reach.
        if (u === target) continue
        u.attackTarget = target
        engine.setWeaponTarget(u.id, slotIdx, { unit: target }, { source })
      } else if (Array.isArray(target) || target.point) {
        const pt = target.point || target
        engine.setWeaponTarget(u.id, slotIdx, { point: [pt[0], pt[1] || 0, pt[2]] }, { source })
      }
      n++
    }
    return n
  }

  // stop halts every selected unit through engine.stopUnits — the
  // canonical "drop move + attack + weapon slots + run StopMoving +
  // TargetCleared" entry point.  Returns the count for status text.
  stop() {
    const engine = this.engine
    const units = this.getSelectedUnits()
    if (!engine || !units.length) return 0
    return engine.stopUnits(units.map((u) => u.id))
  }

  // ── Camera tracking ───────────────────────────────────────────────

  // trackFirstSelected locks the orbit camera onto the first unit in
  // the selection.  Returns true on success, false when there's no
  // camera or no selection.  Caller decides what status text to show.
  trackFirstSelected(label = 'Unit') {
    const units = this.getSelectedUnits()
    if (!this.camera || !units.length) return false
    const u = units[0]
    if (!u) return false
    this.camera.setTrackedTarget(u, u.name || label)
    return true
  }

  untrack() {
    if (!this.camera) return
    this.camera.setTrackedTarget(null)
  }

  // toggleTracking flips the current state — when tracking, untrack;
  // otherwise track the first selected unit.  Matches the T key
  // behaviour both views had wired separately.
  toggleTracking(label = 'Unit') {
    if (!this.camera) return false
    if (this.camera.trackedTarget) {
      this.untrack()
      return false
    }
    return this.trackFirstSelected(label)
  }

  // ── Disposal ──────────────────────────────────────────────────────

  // ── Scene-wide effect / audio aggregation ────────────────────────
  //
  // Both views' Effects + Audio panels show EVERY live binding's
  // particle pool / audio entries — not just the focused unit's.
  // The aggregators walk engine.units() and concatenate.  Lives on
  // BaseView so both viewer + sandbox use one implementation.
  //
  // Cost: O(total alive particles) per refresh tick (4 Hz inspector
  // throttle) — negligible for sandbox-scale fights and trivial for
  // the single-unit viewer.

  // _baseFxBufs — scratch arrays reused across refresh ticks so the
  // panel-open path doesn't allocate every 250 ms.  Auto-grows
  // (doubling) when alive-particle population exceeds capacity.
  // Per-instance so two open views don't fight over one shared
  // buffer.
  _ensureFxBufs(cap) {
    if (!this._baseFxBufs) {
      this._baseFxBufs = {
        capacity: 0,
        alive: null, kind: null,
        r: null, g: null, b: null,
        x: null, y: null, z: null,
        vx: null, vy: null, vz: null,
        life: null, life0: null,
      }
    }
    const b = this._baseFxBufs
    if (cap <= b.capacity) return b
    let next = Math.max(64, b.capacity || 64)
    while (next < cap) next *= 2
    b.capacity = next
    b.alive = new Uint8Array(next)
    b.kind  = new Uint16Array(next)
    b.r     = new Float32Array(next)
    b.g     = new Float32Array(next)
    b.b     = new Float32Array(next)
    b.x     = new Float32Array(next)
    b.y     = new Float32Array(next)
    b.z     = new Float32Array(next)
    b.vx    = new Float32Array(next)
    b.vy    = new Float32Array(next)
    b.vz    = new Float32Array(next)
    b.life  = new Float32Array(next)
    b.life0 = new Float32Array(next)
    return b
  }

  // aggregateParticlePool returns a virtual ParticlePool with the
  // count + flat per-attribute arrays the Effects panel iterates.
  // Concatenates every binding's ALIVE slots into the shared scratch
  // buffer; alive is all-1s so the panel's `if (!alive[i]) continue`
  // guard is a harmless no-op.  Returns {count: 0} when there are
  // no units / no particles, so the panel renders its "no particles
  // in flight" empty state.
  aggregateParticlePool() {
    const engine = this.engine
    if (!engine) return { count: 0 }
    // First pass: total alive across every binding.
    let total = 0
    for (const u of engine.units()) {
      const p = u.binding && u.binding.particles
      if (!p) continue
      for (let i = 0; i < p.count; i++) if (p.alive[i]) total++
    }
    if (total === 0) return { count: 0 }
    const b = this._ensureFxBufs(total)
    // Second pass: copy alive slots into the flat layout.
    let w = 0
    for (const u of engine.units()) {
      const p = u.binding && u.binding.particles
      if (!p) continue
      for (let i = 0; i < p.count; i++) {
        if (!p.alive[i]) continue
        b.alive[w] = 1
        b.kind[w]  = p.kind[i] | 0
        b.r[w]     = p.r[i];  b.g[w]  = p.g[i];  b.b[w]  = p.b[i]
        b.x[w]     = p.x[i];  b.y[w]  = p.y[i];  b.z[w]  = p.z[i]
        b.vx[w]    = p.vx[i]; b.vy[w] = p.vy[i]; b.vz[w] = p.vz[i]
        b.life[w]  = p.life[i]
        b.life0[w] = p.life0[i]
        w++
      }
    }
    return {
      count: w,
      alive: b.alive, kind: b.kind,
      r: b.r, g: b.g, b: b.b,
      x: b.x, y: b.y, z: b.z,
      vx: b.vx, vy: b.vy, vz: b.vz,
      life: b.life, life0: b.life0,
    }
  }

  // aggregateAudioPool returns a virtual AudioPool that fans count()
  // + each(cb) across every binding's pool.  Entries are passed by
  // ref so the panel's progress bar reads the live <audio>'s
  // currentTime directly.
  aggregateAudioPool() {
    const engine = this.engine
    if (!engine) return { count: () => 0, each: () => {} }
    // Snapshot the pools at call time so a unit despawn between
    // count() and each() invocations doesn't crash.
    const pools = []
    for (const u of engine.units()) {
      if (u.binding && u.binding.audio) pools.push(u.binding.audio)
    }
    return {
      count: () => { let n = 0; for (const p of pools) n += p.count(); return n },
      each:  (fn) => { for (const p of pools) p.each(fn) },
    }
  }

  // wrapCobWithAggregate returns a NON-mutating proxy of the given
  // cob binding with particles/audio overridden to the scene-wide
  // aggregators.  Object.create(cob) gives us a fresh own-property
  // surface that delegates everything else (hasScript, start,
  // listScripts, runtime, unit, etc.) to the binding via the
  // prototype chain.  Critical: assigning particles/audio directly
  // ONTO the binding would clobber its own pools and break particle
  // emission inside the binding's own _emitFireBurst /
  // _pushPulseLight etc.  This proxy keeps the binding's internals
  // intact.
  wrapCobWithAggregate(cob) {
    if (!cob) return cob
    const proxy = Object.create(cob)
    proxy.particles = this.aggregateParticlePool()
    proxy.audio = this.aggregateAudioPool()
    // _lifecycle default — the inspector's per-unit panels read this
    // to gate buttons pre-Create.  Sandbox / aircraft-Create paths
    // set it on the real binding; the proxy needs a sensible default
    // for the "no binding" stub-cob path that doesn't ship the field.
    if (!proxy._lifecycle && !cob._lifecycle) proxy._lifecycle = 'created'
    return proxy
  }

  // ── Unit acknowledgement sounds ──────────────────────────────────
  //
  // TA units carry a UnitSounds bank in their FBI: select1, ok1,
  // arrived1, activate, deactivate, etc.  playUnitSound looks up the
  // event key in the unit's resolved sounds map, picks a wav stem,
  // and routes the playback through the unit's own AudioPool so the
  // sim-speed slider + pause toggle apply and the Audio inspector
  // shows the entry with its source pos + progress.  Debounced at
  // 80ms per unit+event so a flurry of clicks doesn't stack Audio
  // objects.

  playUnitSound(unit, eventKey) {
    if (!unit || !unit.meta || !unit.meta.sounds || !unit.binding) return false
    const stem = unit.meta.sounds[eventKey]
    if (!stem) return false
    if (!this._unitSoundDebounce) this._unitSoundDebounce = new Map()
    const key = `${unit.id}:${eventKey}`
    const now = performance.now()
    const last = this._unitSoundDebounce.get(key) || 0
    if (now - last < 80) return false
    this._unitSoundDebounce.set(key, now)
    const pool = unit.binding.audio
    if (!pool) return false
    pool.play(stem, {
      vol: 0.85,
      kind: 'unit',
      source: `${unit.name || 'Unit'}: ${eventKey}`,
      pos: [unit.pos.x, unit.pos.y || 0, unit.pos.z],
    })
    return true
  }

  // playUnitSoundRandom picks one event from the list (filtered to
  // those actually present in the unit's sounds map) and plays it.
  // Lets a unit cycle through ok1..ok5 / arrived1..arrived5 the way
  // TA does, without callers tracking an index.
  playUnitSoundRandom(unit, eventKeys) {
    if (!unit || !unit.meta || !unit.meta.sounds) return false
    const present = eventKeys.filter((k) => unit.meta.sounds[k])
    if (present.length === 0) return false
    const pick = present[Math.floor(Math.random() * present.length)]
    return this.playUnitSound(unit, pick)
  }

  // disposeBase tears down the shared scaffolding (engine subs, hot-
  // keys, smoke trails).  Subclasses should call this from their own
  // dispose() — it's separate from a hypothetical override-able
  // dispose() so subclasses can pick the ordering relative to their
  // own teardown.
  disposeBase() {
    for (const unsub of this._engineSubs) {
      try { unsub() } catch { /* ignore */ }
    }
    this._engineSubs = []
    if (this._smokeTrails) {
      try { this._smokeTrails.clear() } catch { /* ignore */ }
      this._smokeTrails = null
    }
    if (this._hotkeysDetach) {
      try { this._hotkeysDetach() } catch { /* ignore */ }
      this._hotkeysDetach = null
    }
  }
}
