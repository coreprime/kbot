// mv-controls.js — Controls overlay logic.
//
// Owns the Move + Primary/Secondary/Tertiary action buttons, arming
// state, canvas click → target resolution, and the per-frame move /
// aim / fire scheduler.  Lives separately from the inspector panels
// so studio.js doesn't grow another inline subsystem; called from
// onModelLoaded + the renderer's onAfterFrame hook.

// MvControls is a per-viewer object — created when a model loads,
// destroyed when the user switches tabs.  Holds the per-action arm
// state, the resolved targets, and the aim+fire scheduler state.
//
// All world coordinates are in the renderer's "unit-translation"
// space: relative XZ offsets the renderer applies to the model
// matrix.  The unit starts at (0,0) so the first Move target is
// already in this frame.

import { spawnProjectile, playWeaponSound } from '../../game3d/weapon-driver.js'
import { ArmedCursor } from '../../game3d/armed-cursor.js'
import { shouldForceTarget } from '../../game3d/force-target.js'
import { GameEngine } from '../../engine/game-engine.js'
import { hostCallbacks } from '../host-context.js'
import { stepSimSpeed } from '../common/sim-controls.js'
import {
  initSmokeTrails,
  tickSmokeTrails,
  simRate,
  subscribeEngine,
  wireHotkeys,
  wrapCobWithAggregate,
  appendParticleProjectiles,
  buildUnitMotion,
  disposeView,
} from '../common/view-helpers.js'

const SLOT_INDEX = { primary: 0, secondary: 1, tertiary: 2 }
const SLOT_NAMES = ['primary', 'secondary', 'tertiary']

export class MvControls {
  // viewer: ModelViewer.  Provides .cob, .renderer, .canvas, .unitMeta.
  // The Unit Editor and Sandbox previously shared a BaseView class —
  // it was deleted because the cross-section was a contamination
  // vector.  The handful of helpers that genuinely apply to both
  // (smoke trails, engine-sub bookkeeping, hotkey wiring, sim-rate)
  // live as free functions in ui/common/view-helpers.js and are
  // called explicitly here.
  constructor(viewer) {
    this.viewer = viewer
    // Engine subscription unsubscribe closures captured by
    // subscribeEngine(); _smokeTrails is the lazy SmokeTrailManager
    // installed by initSmokeTrails(); _hotkeysDetach is the close
    // returned by wireHotkeys().  disposeView() sweeps all three.
    this._engineSubs = []
    this._smokeTrails = null
    this._hotkeysDetach = null
    this.armed = null                       // null | 'move' | 'primary' | 'secondary' | 'tertiary'
    this.targets = {
      move: null,                           // [x, z] target XZ (relative to spawn).
      primary: null,                        // [x, z, y] aim target (y=0 = ground).
      secondary: null,
      tertiary: null,
    }
    // Live unit state.  Position is XZ delta from the spawn origin.
    // Heading is the body's CURRENT visual world-heading measured as
    // atan2 from +Z CCW.  TA 3DOs ship with the nose at -Z so the
    // unit's natural "out-of-the-box" pose is heading = π — that
    // way _applyRendererTransform passes π + π = 0 to setUnitTransform
    // (i.e., no rotation applied) and the model stays at its native
    // pose until the user actually moves.  As soon as Move runs, the
    // heading turns toward the target and the renderer applies the
    // matching rotation.
    //
    // `alt` is the unit's altitude offset (wu above ground).  Only
    // aircraft modulate this — it lerps toward CruiseAltitude on
    // Move-start and back to 0 on Move-stop, and the renderer
    // applies it as a Y translation in setUnitTransform.
    this.pos = { x: 0, z: 0 }
    this.heading = Math.PI
    this.alt = 0
    // Current forward ground speed (wu/sec), mirrored back from the engine
    // each tick (the engine is the mover).  0 = stationary.
    this.speed = 0
    this.wasLanded = true        // last frame's "alt <= 0.5" state — drives the Deactivate trigger on touchdown
    this.isMoving = false
    // Per-weapon aim-thread + fire timer.  thread is the live
    // CobThread spawned for AimX(heading, pitch); when it dies and
    // its returnValue is 1 (or the unit ships no Aim script), the
    // slot's reload timer starts ticking and FireX is spawned when
    // it elapses.
    // aimState tracks the per-slot aim thread, fire timing, and
    // burst-fire state.  `burstShotsLeft` is the remaining shots in
    // the current burst (0 between bursts); `nextBurstShotAtMs`
    // schedules the next intra-burst shot (TDF burstrate gap).
    // Both reset to 0/0 between full bursts so the reload-time gate
    // is the canonical "wait for next salvo" timer.
    //
    // NOTE: lastFireMs / nextBurstShotAtMs / threadStartMs values
    // are all on the runtime's `simTimeMs` clock — NOT
    // performance.now().  Slow-mo / fast-forward / pause all
    // propagate to fire cadence through that clock.
    const slotInit = () => ({
      thread: null, lastFireMs: -Infinity,
      burstShotsLeft: 0, nextBurstShotAtMs: 0,
    })
    // Per-slot list of ACTIVE in-flight projectiles for the Weapons
    // panel.  Each entry: { spawnSimMs, lifeMs, anchor:[x,y,z],
    // velocity:[vx,vy,vz], speed }.  Pruned each tick — once
    // (simTimeMs - spawnSimMs) >= lifeMs the entry is dropped.  Hard
    // cap at 32 entries as a safety net for pathological cases
    // (very long lifeMs + very fast burst weapons); the natural
    // pruning keeps the typical count to whatever's actually visible
    // in the scene at that moment.
    this.activeProjectiles = { primary: [], secondary: [], tertiary: [] }
    // Missile smoke-trail emitter — initSmokeTrails() lazily builds
    // the SmokeTrailManager on this._smokeTrails so spawnProjectile
    // can register a trail when it spawns a missile.  tick() advances
    // them via tickSmokeTrails() at the unified sim-rate.
    initSmokeTrails(this)
    this.aimState = {
      primary:   slotInit(),
      secondary: slotInit(),
      tertiary:  slotInit(),
    }
    // Hover preview — when the user hovers a Move/Primary/Secondary/
    // Tertiary button, _hoverPreview holds the slot key and an
    // <img> overlay drifts faded above the scene at the slot's
    // target world position.  Lazily created on first hover.
    this._hoverPreview = null
    this._previewOverlay = null
    // Per-event last-played timestamp.  Used as a debounce so a
    // rapid sequence of Move clicks doesn't pile audio elements on
    // top of each other (each click would otherwise spawn a fresh
    // Audio() that plays the same .wav concurrently).
    this._lastPlayedMs = new Map()
    // Camera-tracking state.  When true, the orbit camera's target
    // follows the unit's XZ each frame so the unit stays centred —
    // used to watch aircraft fly off into the distance without
    // losing them off-screen.  Toggled by the T key + the Renderer
    // panel checkbox; cleared automatically when the user does a
    // shift-pan (intentional camera move overrides auto-tracking).
    //
    // Defaults ON.  The unit editor is a showroom — the user almost
    // always wants the unit centred even when it walks/flies, and a
    // slow unit like the ARMBATS battleship moves off-screen in
    // ~3 seconds at default zoom otherwise.  Shift-pan still clears
    // it if the user wants to look at the scene independently.
    // Tracking starts OFF: camera stays put when the unit walks so
    // the user clearly sees the unit translating across the scene
    // (and confirms its body faces the destination).  Earlier this
    // defaulted ON with a lag-lerp follow, which had the side
    // effect of pinning the unit to screen-centre while the world
    // scrolled past — readable as "walking backwards" since the
    // ground appeared to move opposite to the unit's intent.  The
    // user can re-enable tracking via the T key or the Renderer
    // panel's Tracking checkbox at any time.
    this.tracking = false
    this._wireButtons()
    this._wireCanvas()
    this._wireKeyboard()
    // Reset the renderer's unit transform on construction.  The
    // renderer instance is reused across model loads, so the previous
    // unit's pos/alt/heading would otherwise persist — opening a
    // PeeWee after a Hawk would leave the kbot floating at the
    // Hawk's cruise altitude.  Pushing zeros via the renderer's
    // own setter keeps the legacy + new 4-arg paths in sync.
    if (this.viewer.renderer) {
      this.viewer.renderer.setUnitTransform(0, 0, 0, 0)
    }
  }

  // ── View contract surface ───────────────────────────────────────
  //
  // The view-helpers free functions and the inspector-refresh tick
  // read `view.engine` / `view.runtime` / `view.camera` /
  // `view.getSelectedUnits()` / `view.getInspectorMv()` — same
  // surface the Sandbox view exposes so both consumers can be
  // refreshed by one shared inspector loop.

  // Viewer always renders a single unit — getSelectedUnits returns
  // the adopted engine-side unit when there is one, or an empty
  // array before the engine is wired (very brief window during open).
  getSelectedUnits() { return this._engineUnit ? [this._engineUnit] : [] }
  get engine() { return this._engine }
  get runtime() { return this.viewer && this.viewer.cob ? this.viewer.cob.runtime : null }
  // camera returns the camera the Renderer panel + T-key + tracking
  // logic should read from / write to.  Two paths:
  //   - split-pane: the unit-editor's split-host writes
  //     `viewer._focusedCamera` to the camera of whichever pane the
  //     user last pointerdown'd on (primary or observer).  Reading
  //     that here makes the Renderer panel reflect the focused
  //     pane's camera + T-key affect THAT pane's tracking, not just
  //     the primary's.
  //   - single-pane (no split-host involvement): _focusedCamera is
  //     undefined; we fall back to the primary's renderer camera —
  //     identical to pre-split behaviour.
  get camera() {
    const focused = this.viewer && this.viewer._focusedCamera
    if (focused) return focused
    return this.viewer && this.viewer.renderer ? this.viewer.renderer.camera : null
  }

  // getInspectorMv returns the proxy shape studio.js's
  // refreshMvInspectors panels expect.  Effects + Audio aggregate
  // across every binding via wrapCobWithAggregate — the viewer
  // always has a single engine unit, so the aggregator's walk hits
  // exactly one binding.  Symmetric with sandbox's implementation:
  // both views use the SAME wrapper helper so the panels are 100%
  // common across view types.  The wrapper uses Object.create so it
  // doesn't mutate the live binding's own .particles / .audio refs
  // (which the binding's own emit helpers rely on).
  getInspectorMv() {
    const cob = this.viewer ? this.viewer.cob : null
    // Unit editor adopts a single unit into the engine — fetch it so the
    // Movement panel can read live speed/heading/atkPhase off it.  The
    // adopt path tags the engine unit so unitById finds it; fall through
    // to a null motion if the editor hasn't finished adoption yet.
    const engine = this.engine
    const adopted = (engine && this.viewer && this.viewer._adoptedUnitId != null)
      ? engine.unitById(this.viewer._adoptedUnitId) : null
    // Pose overlay (aircraft bank, hover wobble, ship sea-bob) — unit editor
    // is single-unit mode so we pass null and let the renderer fall through
    // to its single-unit _locoState + sea-bob sample.
    const renderer = this.viewer ? this.viewer.renderer : null
    const orient = (renderer && renderer.getUnitOrientation)
      ? renderer.getUnitOrientation(null) : null
    return {
      camera: this.camera,
      renderer,
      cob: cob ? wrapCobWithAggregate(this, cob) : null,
      unitMotion: buildUnitMotion(adopted, orient),
    }
  }

  // ── Scene-wide effect / audio aggregation ───────────────────────
  //
  // The Effects + Audio panels iterate EVERY live binding's particle
  // pool + audio entries — even in the unit editor, where the engine
  // currently holds exactly one adopted unit.  Single-unit walks are
  // a one-iteration loop; the aggregator stays uniform between views
  // so the panel-render code never has to branch on which view it's
  // staring at.
  //
  // _ensureFxBufs reuses scratch typed-array buffers across refresh
  // ticks (4 Hz inspector throttle) so the panel-open path doesn't
  // allocate every 250 ms.  Auto-grows (doubling) on demand.
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

  // aggregateParticlePool concatenates every binding's ALIVE particle
  // slots into the scratch buffer in flat-attribute form (kind / pos /
  // velocity / life), returning the shape the Effects panel reads.
  // Returns {count: 0} when there are no particles in flight so the
  // panel renders its "no particles" empty state.
  aggregateParticlePool() {
    const engine = this.engine
    if (!engine) return { count: 0 }
    let total = 0
    for (const u of engine.units()) {
      const p = u.binding && u.binding.particles
      if (!p) continue
      for (let i = 0; i < p.count; i++) if (p.alive[i]) total++
    }
    if (total === 0) return { count: 0 }
    const b = this._ensureFxBufs(total)
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

  // aggregateProjectiles returns a flat snapshot of every in-flight model
  // projectile owned by this view's engine, decorated with the owner's
  // unit-name + side so the Projectiles inspector can group / colour-tag
  // rows without reaching into the engine itself.  Symmetric with the
  // sandbox view's implementation — the shared Projectiles panel reads
  // off proxy.projectiles regardless of which view built it.
  aggregateProjectiles() {
    const engine = this.engine
    if (!engine) return []
    const out = []
    // Model-projectiles (bombs / homing missiles / mesh rockets) — full
    // engine flight records.
    for (const p of engine.projectiles()) {
      if (!p || p.dead) continue
      const owner = engine.unitById(p.ownerId) || null
      let liveTarget = null
      if (p.targetUnitId != null) {
        const tu = engine.unitById(p.targetUnitId)
        if (tu && !tu.dead) liveTarget = { x: tu.pos.x, y: tu.pos.y, z: tu.pos.z }
      }
      out.push({
        id: 'm-' + p.id,
        weaponName: p.weaponName || '',
        model: p.model || '',
        mode: p.mode || 'straight',
        origin:      { x: p.origin.x, y: p.origin.y, z: p.origin.z },
        destination: { x: p.target.x, y: p.target.y, z: p.target.z },
        liveTarget,
        pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
        vel: { x: p.vel.x, y: p.vel.y, z: p.vel.z },
        speed: p.speed || 0,
        ageSec: p.ageSec || 0,
        lifeSec: p.lifeSec || 0,
        owner: owner ? {
          id: owner.id,
          name: owner.name || '',
          side: owner.side | 0,
        } : null,
      })
    }
    // Particle-pool projectiles — bullets, plasma, shells, d-guns, the
    // dead-reckoned missiles from PeeWees / Guardians / Commanders / etc.
    appendParticleProjectiles(engine, out)
    return out
  }

  // aggregateAudioPool returns a virtual AudioPool that fans count()
  // + each(cb) across every binding's pool.  Entries are passed by
  // ref so the Audio panel's progress bar reads the live <audio>'s
  // currentTime directly.  Snapshots the pool list at call time so a
  // unit despawn between count() and each() can't crash the panel.
  aggregateAudioPool() {
    const engine = this.engine
    if (!engine) return { count: () => 0, each: () => {} }
    const pools = []
    for (const u of engine.units()) {
      if (u.binding && u.binding.audio) pools.push(u.binding.audio)
    }
    return {
      count: () => { let n = 0; for (const p of pools) n += p.count(); return n },
      each:  (fn) => { for (const p of pools) p.each(fn) },
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────

  // _isActive — true when THIS MvControls instance belongs to the
  // unit-editor tab the user is currently viewing.  Every unit tab
  // owns its own MvControls (round 34), but the action-grid buttons
  // (#mv-controls-actions) and document-level Space / +/- keys live
  // in shared DOM that doesn't change per tab.  Without this gate
  // every per-tab MvControls instance would process every click /
  // keypress, causing a click on tab B's Stop button to fire tab A's
  // Stop handler too (and the React Create banner's lifecycle would
  // bleed via the duplicated tick-side effects).  Reading the active
  // viewer through hostCallbacks routes the question back through
  // the canonical setActiveModelViewer write site in studio.js.
  _isActive() {
    const active = hostCallbacks.getActiveModelViewer?.() || null
    return !!active && active === this.viewer
  }

  _wireButtons() {
    const buttons = document.querySelectorAll('#mv-controls-actions .mv-ctrl-action')
    for (const btn of buttons) {
      const action = btn.dataset.ctrlAction
      btn.addEventListener('click', (e) => {
        // Skip when this MvControls isn't bound to the active tab —
        // every per-tab instance is listening on the same buttons,
        // and only the foreground one should react to the click.
        if (!this._isActive()) return
        e.stopPropagation()
        if (btn.disabled) return
        if (action === 'stop') {
          // Stop = clear every target + halt the unit immediately.
          // No "arm + click in scene" flow — just acts on the
          // existing targets.
          this._stopAllTargets()
          return
        }
        // Single-click arm (no toggle) — the next scene click sets
        // the target for this slot.  Re-clicking the same button
        // just re-arms; if a previous slot was armed, this replaces it.
        this.armed = action
        this._refreshButtons()
        this._refreshArmingClass()
        this._updateArmedCursor()
      })
      // Hover preview — when the user hovers a Move/Primary/Secondary/
      // Tertiary button with an existing target, the corresponding
      // cursor floats faded over the scene at the target position so
      // the user can see WHERE they previously committed.  Doesn't
      // apply to Stop (no target concept).
      if (action !== 'stop') {
        btn.addEventListener('mouseenter', () => {
          if (!this._isActive()) return
          this._hoverPreview = action; this._updateHoverPreview()
        })
        btn.addEventListener('mouseleave', () => {
          if (!this._isActive()) return
          if (this._hoverPreview === action) { this._hoverPreview = null; this._updateHoverPreview() }
        })
      }
    }
  }

  // _stopAllTargets is the Stop button's handler: clear move +
  // weapon targets, halt active motion (StopMoving fires), and drop
  // any in-flight aim threads so Fire* won't trigger again until the
  // user re-targets.  Also runs the unit's BOS `TargetCleared`
  // entry-point (when shipped) — this is what the live game engine
  // invokes when a target is dropped, and many units rely on it to
  // reset their internal `aimtype` global.  Commander is the
  // canonical example: AimPrimary's body short-circuits with
  // `if (aimtype == AIM_DGUN) return( FALSE )`, so a previous d-gun
  // fire (which sets aimtype = AIM_DGUN) permanently locks out the
  // laser unless TargetCleared / RestorePosition resets aimtype = 0.
  _stopAllTargets() {
    this.armed = null
    this.targets.move = null
    this.targets.primary = null
    this.targets.secondary = null
    this.targets.tertiary = null
    if (this.isMoving) this._stopMoving()
    for (const slot of ['primary', 'secondary', 'tertiary']) {
      const s = this.aimState[slot]
      if (s.thread && !s.thread.dead) s.thread.dead = true
      s.thread = null
      // Reset burst state too so a mid-burst Stop doesn't leak the
      // remaining shots into the next aim target.
      s.burstShotsLeft = 0
      s.nextBurstShotAtMs = 0
    }
    // Engine-side cleanup — clearing every weapon slot, force-
    // restarting TargetCleared / RestorePosition, dispatching
    // StopMoving — is all centralised in engine.stopUnits.  The
    // viewer just adds its own UI-state teardown above (armed
    // cursor, MvControls' per-slot aim threads, isMoving cancel)
    // and lets the engine helper handle the rest.  Symmetric with
    // sandbox's #stopSelected.
    if (this._engine && this._engineUnit) {
      this._engine.stopUnits([this._engineUnit.id])
    }
    this._refreshButtons()
    this._refreshArmingClass()
    this._updateArmedCursor()
  }

  _wireCanvas() {
    const canvas = this.viewer.canvas
    if (!canvas) return
    // Don't dataset-guard — each MvControls instance owns its own
    // handlers and must clear the previous instance's bindings on
    // dispose.  The previous design used a dataset flag for one-time
    // wiring, but every model load constructs a NEW MvControls; the
    // stale listener kept referencing the disposed instance's
    // `this.armed`, so canvas clicks did nothing for any unit opened
    // after the first.  Store handler refs so dispose() can detach.
    this._canvasHandlers = this._canvasHandlers || {}
    this._canvasHandlers.click = (e) => {
      // Compute the ground point against the PRIMARY canvas + renderer,
      // then hand it to the camera-agnostic commandAtGround.  Observer
      // split panes share that method (computing ground with their OWN
      // camera) so a click in any pane issues the same order.
      const ground = this._groundFromClick(e, canvas, this.viewer.renderer)
      this.commandAtGround(ground, { shiftKey: e.shiftKey })
    }
    // Cursor pointer-tracking lives inside the shared ArmedCursor
    // helper now — no per-event listener needed here.  _updateArmedCursor()
    // lazily constructs the ArmedCursor on the first arm and the
    // overlay wires its own mousemove/leave/enter.
    canvas.addEventListener('click', this._canvasHandlers.click)
    // Remember the canvas we attached to so dispose() can detach from
    // the SAME element even if the viewer hands us a new one later.
    this._wiredCanvas = canvas
  }

  // _groundFromClick unprojects a click event into a WORLD ground point
  // using the supplied canvas + renderer's camera.  Returns null when
  // the ray misses the ground.  Shared by the primary canvas handler
  // and the observer-pane routing (each passes its OWN canvas/renderer
  // so a click in a split pane resolves against the angle that pane
  // shows).
  _groundFromClick(e, canvas, renderer) {
    if (!canvas || !renderer || typeof renderer.canvasToGroundPoint !== 'function') return null
    const r = canvas.getBoundingClientRect()
    if (!r.width || !r.height) return null
    const cx = (e.clientX - r.left) * (canvas.width / r.width)
    const cy = (e.clientY - r.top)  * (canvas.height / r.height)
    return renderer.canvasToGroundPoint(cx, cy)
  }

  // commandAtGround applies the current command gesture at a WORLD
  // ground point — camera-agnostic so it works no matter which split
  // pane the click came from.  When a weapon slot is armed it sets that
  // slot's target; when nothing is armed it force-targets the primary
  // weapon (opt-in via Settings → "Force-target ground on click"); the
  // 'move' slot routes to _startMoving.  Returns silently when neither
  // gesture applies (the click falls through to the orbit camera).
  //
  // Unit-viewer observer panes (observer-view.js) compute `ground` with
  // their own renderer and call this on the PRIMARY's MvControls, so a
  // Move/Fire issued from the right-hand pane drives the same unit as
  // the left — matching the sandbox, where every pane already commands
  // the shared scene.
  commandAtGround(ground, { shiftKey = false } = {}) {
    if (!ground) return
    if (!this.armed) {
      // Force-target ground (opt-in) — unarmed left-click aims the
      // primary weapon at the point.  Routes through targets.primary +
      // the engine SM, identical to the armed-then-click path.
      if (!shouldForceTarget({ shiftKey, requireShift: false })) return
      this._ensureCreated()
      const cob = this.viewer.cob
      if (cob && cob.hasScript && cob.hasScript('TargetCleared')) {
        cob.start('TargetCleared', [0])
      }
      const s = this.aimState.primary
      if (s.thread && !s.thread.dead) s.thread.dead = true
      s.thread = null
      s.burstShotsLeft = 0
      s.nextBurstShotAtMs = 0
      this.targets.primary = [ground[0], ground[1], ground[2]]
      this._setEngineWeaponTarget('primary', [ground[0], ground[1], ground[2]])
      return
    }
    const slot = this.armed
    // First-action auto-Create so the unit is alive (MotionControl +
    // bCanAim set) by the time the command lands — see _ensureCreated.
    this._ensureCreated()
    // Reset BOS aim-state before each new weapon target so a stale
    // aimtype global doesn't short-circuit the next AimX.  Skipped for
    // Move + units without TargetCleared.
    if (slot !== 'move') {
      const cob = this.viewer.cob
      if (cob && cob.hasScript && cob.hasScript('TargetCleared')) {
        cob.start('TargetCleared', [0])
      }
      const s = this.aimState[slot]
      if (s.thread && !s.thread.dead) s.thread.dead = true
      s.thread = null
      s.burstShotsLeft = 0
      s.nextBurstShotAtMs = 0
    }
    if (slot === 'move') {
      this.targets.move = [ground[0], ground[2]]
      // The engine is the mover: _pushOrdersToEngine mirrors this.targets.move
      // onto the engine unit each tick (and the engine clears it on arrival,
      // which _readPoseFromEngine detects).  Issuing Move cancels any
      // in-progress attack maneuver — clear the engine's attackTarget if it
      // already exists (the viewer never sets one, but keep it consistent).
      if (this._engineUnit) this._engineUnit.attackTarget = null
      this._startMoving()
    } else {
      this.targets[slot] = [ground[0], ground[1], ground[2]]
      this._setEngineWeaponTarget(slot, [ground[0], ground[1], ground[2]])
    }
    this.armed = null
    this._refreshButtons()
    this._refreshArmingClass()
    this._updateArmedCursor()
  }

  // _updateArmedCursor delegates to the shared ArmedCursor helper
  // (game3d/armed-cursor.js) so both the single-unit editor and the
  // multi-unit Sandbox show the same TA cursor PNGs on the same
  // gestures.  Lazily created on first arm so a viewer that never
  // gets to a command click pays no DOM cost.
  _updateArmedCursor() {
    if (!this._armedCursor) {
      this._armedCursor = new ArmedCursor({
        canvas: this.viewer.canvas,
        host: document.getElementById('model-viewer-dialog') || document.body,
      })
    }
    this._armedCursor.setSlot(this.armed)
    // When the armed weapon is a `dropped` bomb, swap the targeting glyph
    // for the airstrike cursor — same gesture (click ground to aim) but the
    // user sees an air-attack reticle instead of the generic crosshair.
    const slotIdx = SLOT_INDEX[this.armed]
    const w = (slotIdx != null && this.viewer.unitMeta) ? this.viewer.unitMeta.weapons[slotIdx] : null
    this._armedCursor.setKind((w && w.dropped) ? 'airstrike' : null)
  }

  // ── External hooks ──────────────────────────────────────────────

  // onMetaLoaded is called by the host once the unit's FBI metadata
  // (movement + weapon refs) is in.  Enables / disables buttons
  // based on what the unit actually supports.
  onMetaLoaded() {
    this._refreshButtons()
    // Refresh the engine unit's meta ref so the weapon SM picks up
    // newly-loaded weaponSlots[].  Cheap; no-op when no engine yet.
    if (this._engineUnit) this._engineUnit.meta = this.viewer.unitMeta
    // Tell the renderer the unit's movement flavour so it can layer the
    // FBI-driven pose overlay (aircraft bank/pitch, hovercraft gyration) on
    // top of the move transform.  Aircraft bank; hovercraft (Category HOVER)
    // wobble; everything else gets a flat, overlay-free pose.
    const m = this.viewer.unitMeta
    const r = this.viewer.renderer
    if (r && typeof r.setUnitLocomotion === 'function') {
      r.setUnitLocomotion(m ? {
        hover: !!m.isHovercraft,
        aircraft: !!m.isAircraft,
        bankScale: m.bankScale,
        pitchScale: m.pitchScale,
      } : null)
    }
  }

  // _ensureEngine lazily builds a GameEngine that ADOPTS the viewer's
  // existing CobUnit + binding (rather than creating a parallel set).
  // Done once the viewer's COB is alive — the engine then owns the
  // per-slot weapon SM, the click handlers route through it via
  // setWeaponTarget(), and a 'fire' event subscriber spawns the
  // visible projectile via the shared weapon-driver.
  //
  // The engine here runs in "viewer-embedded" mode — its tick is
  // called with skipRuntime/skipMovement/skipSync because the renderer
  // ticks the binding (which advances the runtime) and MvControls
  // owns this viewer's movement + altitude + ground walk.  The engine
  // is along for the ride only to drive the weapon SM + ballistic
  // aim solver + firing-piece anchor — every weapon-related thing
  // that used to be duplicated.
  _ensureEngine() {
    if (this._engine) return this._engine
    const cob = this.viewer.cob
    if (!cob || !cob.unit || !cob.runtime) return null
    // Share the viewer's runtime so engine.runtime.simTimeMs reads the
    // same clock the binding's tick advances (otherwise reload + burst
    // gates would diverge from the rest of the sim).
    this._engine = new GameEngine({
      runtime: cob.runtime,
      gravity: this.viewer.renderer && typeof this.viewer.renderer.getGravity === 'function'
        ? this.viewer.renderer.getGravity() : 80,
    })
    this._engineUnit = this._engine.adoptUnit({
      name: this.viewer.cob?.unit?.name || 'viewer-unit',
      model: this.viewer.model,
      cobUnit: cob.unit,
      binding: cob,
      meta: this.viewer.unitMeta,
      x: this.pos.x, z: this.pos.z,
      headingRad: this.heading,
    })
    // Subscribe to 'fire' so each shot spawns a visible projectile.
    // The engine has already done the heavy lifting before emitting:
    //   ev.anchor — firing-piece world XYZ (via engine.#firingPieceFor
    //               which runs QueryX → cobUnit.pieceNames → model)
    //   ev.target — the SM's aim point (unit pos or static point)
    //   ev.weapon — the FBI weapon record
    // So the subscriber is just "hand all that to the shared
    // weapon-driver, and record the shot for the Weapons panel".
    // No duplicate firing-piece resolution or ballistic recompute
    // lives here any more — task #249 consolidated both into the
    // engine.
    // subscribeEngine() captures the unsubscribe closure onto
    // this._engineSubs so disposeView() can sweep every listener at
    // teardown.  Returns the closure to the caller too in case it
    // wants to detach early.
    subscribeEngine(this, 'fire', (ev) => {
      if (!ev.weapon || !ev.weapon.name) return
      // Model weapons (missiles / rockets / bombs) are flown by the
      // engine's projectile simulation and drawn as a real 3DO mesh
      // — the same short-circuit sandbox uses.  Without this guard
      // Thunder's gravity bombs (model=bomb + dropped=1) were also
      // getting a missile-class particle from spawnProjectile that
      // flew straight toward the aim point, on top of the real bomb
      // falling under gravity.  Still play the muzzle sound so the
      // discharge is audible.
      if (ev.modelProjectile) {
        try { playWeaponSound({ binding: this.viewer.cob, weapon: ev.weapon, anchor: ev.anchor }) } catch { /* ignore */ }
        return
      }
      const gravity = (this.viewer.renderer && typeof this.viewer.renderer.getGravity === 'function')
        ? this.viewer.renderer.getGravity() : 80
      let result = null
      try {
        result = spawnProjectile({
          binding: this.viewer.cob,
          weapon: ev.weapon,
          anchor: ev.anchor,
          target: ev.target,
          palette: this.viewer.palette,
          gravity,
          smokeTrails: this._smokeTrails,
        })
      } catch { /* ignore */ }
      // Push the in-flight shot onto the Weapons panel's per-slot
      // list so the panel can show what's currently visible in the
      // scene.  No-op for beams (lifeMs ~200 ms — ticks by quickly).
      if (result) {
        const slotKey = SLOT_NAMES[ev.slot]
        this._recordShot(slotKey, result.anchor, result.velocity, result.lifeMs)
      }
    })
    return this._engine
  }

  // _pushOrdersToEngine syncs the viewer's order + display state onto the
  // adopted engine unit each tick, BEFORE the engine moves it.  Move + fire
  // orders are written to the engine when issued (commandAtGround); here we
  // just keep the live meta ref + the camera-appropriate cruise ceiling
  // current, since the unit's FBI meta + the model bounds can load after the
  // engine unit is adopted.  The engine is the mover from here on.
  _pushOrdersToEngine() {
    const u = this._engineUnit
    if (!u) return
    const m = this.viewer.unitMeta
    u.meta = m
    // Display ceiling for THIS view's close-up camera (see _cruiseAltClamped).
    // The engine clamps the cruise altitude to this so a Hawk doesn't fly out
    // of frame; the climb/descend physics + airborne decision are unchanged.
    u.cruiseAltOverride = (m && m.isAircraft) ? this._cruiseAltClamped() : 0
    // Mirror the Move order onto the engine.  Re-pushing the same XZ each
    // tick is harmless (the integrator just keeps driving toward it); on the
    // tick the engine reaches the goal it clears u.moveTarget itself, and
    // _readPoseFromEngine sees the cleared flag and ends the move.  Fire
    // orders are pushed separately via _setEngineWeaponTarget on click; the
    // engine's attack maneuver follows whatever slot is armed.
    if (this.targets.move) {
      u.moveTarget = { x: this.targets.move[0], z: this.targets.move[1] }
    }
  }

  // _readPoseFromEngine mirrors the engine's freshly-computed pose back into
  // the viewer's pos / heading / alt / speed, pushes it to the renderer
  // (which derives the bank / pitch / hover-wobble overlay from the deltas)
  // and fires the move-complete lifecycle when the engine reports arrival.
  // This is the read side of "engine leads, the view renders the result".
  _readPoseFromEngine() {
    const u = this._engineUnit
    if (!u) return
    this.pos.x = u.pos.x
    this.pos.z = u.pos.z
    this.alt = u.pos.y || 0
    this.heading = u.heading
    this.speed = u.speed || 0
    // The engine clears u.moveTarget on arrival.  Mirror that into the
    // viewer's order state and run the StopMoving lifecycle (Deactivate +
    // "arrived" voice) exactly once on that edge.
    if (this.targets.move && !u.moveTarget) {
      this.targets.move = null
      this._stopMoving()
    }
    this._applyRendererTransform()
    this.wasLanded = this.alt <= 0.5
  }

  // setSilenced silences this viewer's audio.  Called from
  // switchToTab on the outgoing tab so backgrounded viewers go quiet
  // without freezing their sim.  Delegates to the engine which mutes
  // every adopted unit's AudioPool.
  setSilenced(s) {
    if (this._engine && typeof this._engine.setSilenced === 'function') {
      this._engine.setSilenced(!!s)
    }
    // Same hook is the canonical "this view is no longer in front"
    // signal — flip the armed-cursor overlay off so a backgrounded
    // tab's last-armed glyph doesn't sit frozen on the screen while
    // the user works in a sibling tab.  Re-enabled by the next
    // setSlot/setArmed call when the user comes back.
    if (this._armedCursor && typeof this._armedCursor.setVisible === 'function') {
      this._armedCursor.setVisible(!s)
    }
  }

  // _setEngineWeaponTarget pushes a slot's MvControls target into the
  // engine SM.  Used by the click handler so the engine starts driving
  // aim + reload + burst the moment the user picks a target.  Null
  // clears the slot — same behaviour as engine.clearWeaponTarget.
  _setEngineWeaponTarget(slotKey, point) {
    if (!this._ensureEngine()) return
    const slotIdx = SLOT_INDEX[slotKey]
    if (slotIdx === undefined) return
    if (point == null) {
      this._engine.setWeaponTarget(this._engineUnit.id, slotIdx, null)
    } else {
      this._engine.setWeaponTarget(this._engineUnit.id, slotIdx,
        { point: [point[0], point[1] || 0, point[2]] },
        { source: 'manual' })
    }
  }

  // tick is called from the renderer's per-frame callback.  dtMs is
  // wall-clock; rate / dtSimMs come from the shared simRate() helper
  // which returns 0 when paused and playbackRate otherwise — the same
  // gate the engine uses for particles, so sub-frame timing stays in
  // lock-step with sim-time everywhere.
  tick(dtMs) {
    if (!this.viewer.cob) return
    const rate = simRate(this)
    // Sim-scaled dtMs for sub-systems that gate on time but want to
    // honour slow-mo / fast-forward (ship wakes emit on a 100 ms
    // cadence; at 0.1× sim that should be 1000 ms wall, not 100).
    const dtSimMs = dtMs * rate
    // Engine-led motion — the unification.  The viewer pushes its order +
    // display state onto the adopted engine unit, then lets the engine be
    // the SINGLE mover: #stepAttack + #stepMovement compute pos / heading /
    // altitude here exactly as they do for the sandbox.  The viewer renders
    // the result by reading the pose straight back (_readPoseFromEngine).
    // We still pass skipRuntime (the renderer's binding.tick already advanced
    // the shared runtime this frame) and skipSync (the renderer pushes its
    // own worldOffset) — but movement is NO LONGER skipped.
    // Make sure the adopted engine unit exists (it's the mover): _ensureEngine
    // is otherwise lazy (first weapon command), which would leave a Move-only
    // unit with nothing to drive it now that the viewer no longer integrates
    // motion itself.
    this._ensureEngine()
    this._pushOrdersToEngine()
    if (this._engine) {
      this._engine.tick(dtMs, { skipRuntime: true, skipSync: true })
    }
    this._readPoseFromEngine()
    // Drop any projectile whose flight time has elapsed.  Done after
    // the engine tick so a brand-new entry from this tick isn't pruned
    // until at least one tick later.
    this._pruneActiveProjectiles()
    this._updateShipWake(dtSimMs)
    // Smoke-trail advance — tickSmokeTrails handles the pause +
    // playback-rate scaling internally.  At 0.01× a slow-
    // flying laser leaves puffs every 4 s wall ≈ 40 ms sim, matching
    // what the projectile's slowed velocity actually traces out.
    tickSmokeTrails(this, dtMs)
    // Hover-preview overlay tracks the camera (which may auto-rotate
    // or be orbited by the user), so the projected screen position
    // refreshes every frame.  Stop-button live-state too.
    this._updateHoverPreview()
    this._updateStopLive()
  }

  // _updateShipWake drops foamy puffs at the ship's wake1 / wake2
  // pieces on a fixed cadence while the unit is in motion.  Ship-
  // only — TA walkers and tanks do NOT emit engine smoke at their
  // feet, so this is gated on the unit metadata's isShip / isSub
  // flag.  The cob binding's _emitShipWake helper computes the
  // wake-piece world positions from the controller's authoritative
  // pos/heading (not from piece.worldMatrix, which lags one frame
  // behind a moving unit and would smear the puffs at the previous
  // position).  Cadence ~100 ms reads as a continuous foam trail
  // without flooding the pool on long sea crossings.
  //
  // dtSimMs is wall-time scaled by playbackRate so wake density
  // matches the ship's apparent motion — at 0.1× sim the ship
  // crawls and the trail correspondingly thins to 1/10th the rate.
  _updateShipWake(dtSimMs) {
    const meta = this.viewer.unitMeta
    if (!meta || !(meta.isShip || meta.isSub) || !this.isMoving) {
      this._wakeAccumMs = 0
      return
    }
    const cob = this.viewer.cob
    if (!cob || typeof cob._emitShipWake !== 'function') return
    this._wakeAccumMs = (this._wakeAccumMs || 0) + dtSimMs
    while (this._wakeAccumMs >= 100) {
      this._wakeAccumMs -= 100
      cob._emitShipWake([this.pos.x, this.alt || 0, this.pos.z], this.heading + Math.PI)
    }
  }

  // dispose tears everything down — called when the viewer reloads
  // a new model or the user closes the tab.  Cancels armed state,
  // clears targets, and kills any in-flight aim threads.
  dispose() {
    this.armed = null
    this.targets = { move: null, primary: null, secondary: null, tertiary: null }
    this._hoverPreview = null
    // Detach canvas listeners so a later MvControls instance gets a
    // clean slate.  Without this, the previous owner's stale closure
    // (referencing the disposed `this`) wins and Move / Fire clicks
    // silently miss for every unit opened after the first.
    if (this._wiredCanvas && this._canvasHandlers) {
      this._wiredCanvas.removeEventListener('click', this._canvasHandlers.click)
      this._wiredCanvas = null
      this._canvasHandlers = null
    }
    // disposeView tears down the view-helpers scaffolding (engine
    // event subscriptions, the SmokeTrailManager, the unit-hotkey
    // listener) in one sweep.  Called BEFORE the viewer canvas +
    // armed-cursor teardown so any RAF closures the engine handlers
    // might fire into see clean refs.
    disposeView(this)
    if (this._previewOverlay) {
      this._previewOverlay.remove()
      this._previewOverlay = null
    }
    if (this._armedCursor) {
      this._armedCursor.dispose()
      this._armedCursor = null
    }
    if (this.viewer.canvas) this.viewer.canvas.style.cursor = ''
    this._refreshArmingClass()
  }

  // resetState — called from the host's Reset button.  Clears
  // targets + position + heading and snaps the renderer back to
  // origin.
  resetState() {
    this.armed = null
    this.targets = { move: null, primary: null, secondary: null, tertiary: null }
    this.pos.x = 0; this.pos.z = 0
    this.alt = 0
    this.speed = 0
    // Same native-orientation default as the constructor — see comment
    // there for why heading starts at π (3DO nose-at-minus-Z convention).
    this.heading = Math.PI
    this.isMoving = false
    // Reset the adopted engine unit too — it's the mover, so without this
    // the next tick's _readPoseFromEngine would read its stale pose / orders
    // straight back and undo the reset.
    if (this._engineUnit) {
      const u = this._engineUnit
      u.pos.x = 0; u.pos.y = 0; u.pos.z = 0
      u.heading = Math.PI
      u.speed = 0
      u.moveTarget = null
      u.attackTarget = null
      u._atk = null
      u.isMoving = false
      for (let slot = 0; slot < 3; slot++) {
        if (this._engine) this._engine.setWeaponTarget(u.id, slot, null)
      }
    }
    for (const slot of ['primary', 'secondary', 'tertiary']) {
      const s = this.aimState[slot]
      if (s.thread && !s.thread.dead) s.thread.dead = true
      s.thread = null
      s.lastFireMs = -Infinity
    }
    this._applyRendererTransform()
    this._refreshButtons()
    this._refreshArmingClass()
  }

  // ── Per-frame movement ──────────────────────────────────────────

  // _ensureCreated runs Create exactly once on first user command, so
  // a freshly-loaded unit's static-vars + background threads are set
  // up before Move/Fire act on them.  Tracked via cob._lifecycle so
  // subsequent armed-clicks (or an explicit Create from the Actions
  // panel) don't double-spawn MotionControl etc.  Activate is handled
  // separately by _startMoving for aircraft.
  _ensureCreated() {
    const cob = this.viewer.cob
    if (!cob) return
    if (cob._lifecycle && cob._lifecycle !== 'unborn') return
    if (cob.hasScript && cob.hasScript('Create')) {
      // Cancel any in-flight auto-build ramp — the user has taken
      // explicit control via a canvas click that's auto-triggering
      // Create, and we don't want the ramp to keep advancing on
      // top of the script's setup.
      if (this.viewer._autoBuild) this.viewer._autoBuild = null
      cob.start('Create')
      // 'creating' (NOT 'created') so syncMvActionsRunning's tick
      // sweep can promote to 'created' once the Create thread dies.
      // Setting 'created' here would skip the promotion path and
      // leave Activate/Deactivate gating mis-aligned.
      cob._lifecycle = 'creating'
    } else {
      cob._lifecycle = 'created'
    }
  }

  _startMoving() {
    if (this.isMoving) return
    this.isMoving = true
    const cob = this.viewer.cob
    // StartMoving + altitude are the ENGINE's job now (it's the mover):
    // #stepMovement fires StartMoving on its u.isMoving transition and
    // lifts the unit to cruise.  Firing StartMoving here too would
    // double-spawn the leg-walk loop.  This method only runs the viewer's
    // order-time lifecycle: aircraft Activate + the "ordered" voice.
    const m = this.viewer.unitMeta
    if (m && m.isAircraft) {
      // Activate-style scripts (engines on) typically run when an
      // aircraft starts flying; trigger Activate if it exists AND
      // we haven't already activated, so the unit's idle pose
      // doesn't keep the wings folded mid-flight.
      if (cob.hasScript('Activate') && cob._lifecycle !== 'activated') {
        cob._lifecycle = 'activated'
        cob.start('Activate')
        // Activate sound fires once when the unit "powers on" — the
        // sound.tdf entry is shared with the COB Activate, so this
        // covers spinning rotors / unfolding wings audibly.
        this._playSound('activate')
      }
    }
    // "Move ordered" voice — TA's ok1/ok2/... sound bank.  Picks a
    // random ok* if multiple exist (matches the game's behaviour of
    // varying the response).
    this._playSoundRandom(['ok1', 'ok2', 'ok3', 'ok4', 'ok5'])
  }

  _stopMoving() {
    if (!this.isMoving) return
    this.isMoving = false
    const cob = this.viewer.cob
    // StopMoving + the descent are the ENGINE's job (it fires StopMoving on
    // arrival and settles the unit to the ground).  Here we run only the
    // viewer's order-completion lifecycle: aircraft Deactivate (its wings-
    // fold animation plays during the engine-driven descent, matching how
    // TA sequences a landing) + the "arrived" voice.
    const m = this.viewer.unitMeta
    if (m && m.isAircraft) {
      if (cob && cob.hasScript('Deactivate') && cob._lifecycle !== 'deactivated') {
        cob._lifecycle = 'deactivated'
        cob.start('Deactivate')
        this._playSound('deactivate')
      }
    }
    // "Order complete" voice — TA's arrived1+ sound bank.
    this._playSoundRandom(['arrived1', 'arrived2', 'arrived3', 'arrived4', 'arrived5'])
  }

  // _cruiseAltClamped returns the unit's effective cruise altitude
  // for studio display — capped against the model's bounding-box
  // height so a Hawk's 160 wu cruise alt doesn't fly out of frame
  // on a unit that's only 20 wu tall.  The clamp keeps the lifted
  // aircraft visible while still reading as obviously airborne
  // (roughly 2× the unit's own height above the ground).
  _cruiseAltClamped() {
    const m = this.viewer.unitMeta
    const raw = (m && m.cruiseAltitude) ? m.cruiseAltitude : 80
    const model = this.viewer.model
    if (!model || !model.bounds) return Math.min(raw, 60)
    const unitH = Math.max(1, model.bounds.max[1] - model.bounds.min[1])
    // Floor at 1.2× height (always noticeably airborne), cap at 3×
    // height (keeps the unit framed in the orbit camera).
    const minLift = unitH * 1.2
    const maxLift = unitH * 3.0
    return Math.max(minLift, Math.min(raw, maxLift))
  }

  // _playSound triggers an Audio() for the named sound-event.  The
  // event name is the sound.tdf key (select1, ok1, arrived1,
  // activate, deactivate, etc.); the actual .wav stem comes from
  // the unit's resolved sounds map.  Silently no-ops when the unit
  // has no sound for the event — common for buildings + utility
  // units.  Debounced at 80ms per event so a flurry of clicks
  // doesn't stack Audio objects.
  _playSound(eventKey) {
    const m = this.viewer.unitMeta
    const stem = m && m.sounds && m.sounds[eventKey]
    if (!stem) return
    const now = performance.now()
    const last = this._lastPlayedMs.get(eventKey) || 0
    if (now - last < 80) return
    this._lastPlayedMs.set(eventKey, now)
    // Route every unit sound through the binding's AudioPool so the
    // sim-speed slider + pause toggle apply, and the Audio inspector
    // panel shows the entry with its source pos + progress.  Pos is
    // the unit's current world location — sounds attach to where
    // the unit is when they START (the player's perception); the
    // pool doesn't follow the unit after that.
    const pool = this.viewer.cob && this.viewer.cob.audio
    if (!pool) return
    pool.play(stem, {
      vol: 0.85,
      kind: 'unit',
      source: `${(m && m.name) || 'Unit'}: ${eventKey}`,
      pos: [this.pos.x, this.alt || 0, this.pos.z],
    })
  }

  // _playSoundRandom picks one event from the list (only those
  // actually present in the unit's sounds map) and plays it.  Lets
  // a unit cycle through ok1..ok5 / arrived1..arrived5 the way TA
  // does, without the studio needing to track an index.
  _playSoundRandom(eventKeys) {
    const m = this.viewer.unitMeta
    if (!m || !m.sounds) return
    const present = eventKeys.filter((k) => m.sounds[k])
    if (present.length === 0) return
    const pick = present[Math.floor(Math.random() * present.length)]
    this._playSound(pick)
  }

  _applyRendererTransform() {
    // Heading-to-render conversion.  TA 3DOs author the unit with
    // its nose toward -Z, the model loader X-flips vertex positions,
    // and Mat4.rotateY uses the standard right-handed sign.  The
    // empirically-correct rotation that makes the unit walk +Z when
    // heading=0 (atan2(dx=0, dz=+1) = 0) is `heading + π` — without
    // the offset the unit shows its rear to the target.  The user-
    // reported "all inverted" behaviour traces to the canvas click
    // handler's target-projection (see _wireCanvas), where the
    // unproject occasionally maps a click to the OPPOSITE world
    // point relative to the unit's pos because of camera-orbit yaw.
    // Pose direction is correct; investigate target projection on
    // any further reports of swapped directions.
    this.viewer.renderer?.setUnitTransform(this.pos.x, this.alt, this.pos.z, this.heading + Math.PI)
    // Camera follows the unit so it stays in frame as it walks /
    // flies away.  Without this, ground units that walked past the
    // initial framing bounds (and especially aircraft that lifted
    // to cruiseAltitude) would silently leave the camera's view.
    // We update target.xyz to track the unit's current world
    // position; the orbit camera's distance / yaw / pitch stay
    // fixed so the user's chosen vantage is preserved.
    this._followCamera()
  }

  // _followCamera pans the orbit camera's target so the rendered
  // unit stays centred as it moves around the scene.  Runs when
  // EITHER the user opted in via T / the Renderer panel's Tracking
  // checkbox, OR auto-rotate is engaged — without the auto-rotate
  // path the showroom camera would spin around the unit's spawn
  // origin while the unit itself walked away, which reads as the
  // unit drifting out of frame instead of the camera orbiting it.
  // Tracks only X/Z, leaving Y at whatever the initial frameBounds()
  // set it to (Y tracking would defeat the visual point of an
  // aircraft lifting off — the camera would pan up at the same
  // rate as the unit, so the Hawk would appear stationary in the
  // frame while the ground sank).
  _followCamera() {
    // Auto-rotate still wants a snap to keep the unit centred — the
    // explicit-tracking path is owned by OrbitCamera.applyTracking
    // (called every frame from the renderer's onAfterFrame hook).
    const r = this.viewer.renderer
    if (!(r && r.autoRotate)) return
    const cam = this.viewer.camera
    if (!cam) return
    cam.target[0] = this.pos.x
    cam.target[2] = this.pos.z
    r?.requestRedraw()
  }

  // setTracking flips tracking on/off.  Routes through the camera's
  // setTrackedTarget — passes a synthesised ref that owns the
  // controller's live pos + viewer's model so OrbitCamera.applyTracking
  // can derive the unit's centre of mass each frame without poking
  // back into MvControls' internals.  Turning OFF unsets the camera's
  // tracked target entirely (matches the spec: clearing T unsets the
  // tracked unit).  Renderer panel's checkbox stays in sync via
  // `this.tracking` which the panel polls.
  setTracking(on) {
    const next = !!on
    this.tracking = next
    // Read from the focus-aware getter so a T-key press / Tracking-
    // checkbox toggle in the split-pane case affects whichever
    // pane's camera the user is looking at — not the primary's.
    // Single-pane callers get the primary camera (legacy behaviour).
    const cam = this.camera
    if (next) {
      // Build a tracking ref that reflects the unit's CURRENT pos +
      // model bounds each frame — the camera dereferences `.pos` and
      // `.model.bounds` per-frame, so live edits to either pick up
      // automatically without re-arming.
      const ctrl = this
      const ref = {
        get pos() { return { x: ctrl.pos.x, y: ctrl.alt || 0, z: ctrl.pos.z } },
        get model() { return ctrl.viewer.model },
        get name() { return ctrl.viewer.model?.name || 'Unit' },
      }
      if (cam) cam.setTrackedTarget(ref, ctrl.viewer.model?.name || 'Unit')
    } else if (cam) {
      cam.setTrackedTarget(null)
    }
    const cb = document.getElementById('mv-ci-track')
    if (cb && cb.checked !== next) cb.checked = next
  }

  // _wireKeyboard installs a document-level key handler for the
  // viewer hotkeys:
  //   T  — toggle camera tracking (snap-to-unit follow)
  //   M  — arm Move action (next canvas click sets the destination)
  //   A  — arm Primary weapon target
  //   F  — arm Secondary weapon target
  //   D  — arm Tertiary weapon target
  //   S  — Stop (clears every target + halts the unit)
  // Hotkeys go through _armSlot / _stopAllTargets so the visual
  // state (button highlight, armed cursor, refreshArmingClass) is
  // identical to clicking the on-screen buttons.  Skipped while
  // the user is typing in any input / textarea / contenteditable
  // and skipped while a modifier (ctrl/cmd/alt) is held so they
  // don't fight browser/page shortcuts.
  _wireKeyboard() {
    if (this._keyHandlerWired) return
    this._keyHandlerWired = true
    // Order keys (M/A/F/D/S/T) come from the shared unit-hotkeys
    // module via the wireHotkeys helper — viewer + sandbox both bind
    // the same keymap so muscle memory carries across.  Slot-arm
    // callbacks route into _armSlotHotkey (which respects the
    // disabled state of the visible Controls buttons), Stop into
    // _stopAllTargets, T into setTracking with the viewer's
    // tracking flag.  Allowed() always returns true here — the
    // viewer is always single-unit, so there's no "no selection"
    // edge case to gate on (button.disabled handles per-slot gating
    // inside _armSlotHotkey).
    wireHotkeys(this, {
      dialogId: 'model-viewer-dialog',
      // Round 35: gate the unit-hotkey allowed() check on per-tab
      // activeness — every per-tab MvControls subscribes the same
      // document keymap; the foreground one should be the only
      // listener that takes the hotkey.
      allowed: () => this._isActive(),
      onCommand: (cmd) => this._armSlotHotkey(cmd),
      onStop:    () => this._stopAllTargets(),
      onTrack:   () => this.setTracking(!this.tracking),
    })
    // Runtime-control keys (Space, +/-) stay viewer-specific — they
    // drive sim playback rate / paused state, not unit orders.
    document.addEventListener('keydown', (e) => {
      // Same per-tab gate as wireHotkeys above — without it the
      // backgrounded tab's MvControls also reacts to Space / +/-
      // and double-toggles the runtime / sim-speed.
      if (!this._isActive()) return
      const dlg = document.getElementById('model-viewer-dialog')
      if (!dlg || dlg.classList.contains('hidden')) return
      const tgt = e.target
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return
      if (tgt && tgt.isContentEditable) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Spacebar — toggle the runtime between paused and running.
      // Mirrors the merged Pause/Resume button so power-users can
      // drive the simulation without leaving the canvas.  e.key for
      // space is " " (single space) so we match that exactly rather
      // than the lowercased generic key code.
      if (e.key === ' ') {
        e.preventDefault()
        if (typeof window.mvToggleRuntimePaused === 'function') {
          window.mvToggleRuntimePaused()
        }
        return
      }
      // +/- (and bare =, _).  Shift + the key ZOOMS the focused
      // camera (consistent with the map editor + sandbox); the bare
      // key STEPS the sim speed.  On US layouts the "+/-" symbols
      // carry Shift (Shift+= → "+"), so reading e.shiftKey lines up
      // with the key faces the user presses.
      {
        const isPlus = e.key === '+' || e.key === '='
        const isMinus = e.key === '-' || e.key === '_'
        if (isPlus || isMinus) {
          e.preventDefault()
          if (e.shiftKey) {
            const cam = this.camera
            if (cam && typeof cam.zoomBy === 'function') {
              cam.zoomBy(isPlus ? 1 / 1.1 : 1.1)
              const r = this.viewer?.renderer
              if (r && !r.running) r.requestRedraw?.()
            }
          } else {
            stepSimSpeed(isPlus ? +1 : -1)
          }
          return
        }
      }
    })
  }

  // _armSlotHotkey arms the given slot — identical state mutation
  // to clicking the slot's on-screen button.  Skipped silently if
  // the unit doesn't support the action (no weapon in that slot,
  // can't move, etc.) so the keypress doesn't put the user into a
  // limbo state with armed cursor but no target ever reachable.
  _armSlotHotkey(slot) {
    // Look up the matching button and check its disabled state to
    // gate the hotkey — this respects the same enable/disable
    // logic the visible buttons use (e.g. no Weapon2 → button
    // disabled → hotkey no-ops).
    const btn = [...document.querySelectorAll('#mv-controls-actions .mv-ctrl-action')]
      .find((b) => b.dataset.ctrlAction === slot)
    if (!btn || btn.disabled) return
    this.armed = slot
    this._refreshButtons()
    this._refreshArmingClass()
    this._updateArmedCursor()
  }


  // _recordShot pushes a fresh projectile onto the slot's active-
  // projectiles list for the Weapons panel.  lifeMs is the expected
  // time-of-flight (range / velocity + slack for ballistic arcs);
  // entries are pruned by _pruneActiveProjectiles when their age
  // exceeds lifeMs.  Beam weapons pass a tiny lifeMs (~200 ms)
  // since the beam itself is instant — the entry only stays around
  // long enough for the user to see it tick by.  Cap at 32 entries
  // as a safety net.
  _recordShot(slot, anchor, velocity, lifeMs) {
    const list = this.activeProjectiles && this.activeProjectiles[slot]
    if (!list) return
    const speed = Math.hypot(velocity[0] || 0, velocity[1] || 0, velocity[2] || 0)
    const simMs = this.viewer.cob?.runtime?.simTimeMs ?? performance.now()
    list.push({
      spawnSimMs: simMs,
      lifeMs: Math.max(50, +lifeMs || 1000),
      anchor: [anchor[0], anchor[1], anchor[2]],
      velocity: [velocity[0], velocity[1], velocity[2]],
      speed,
    })
    while (list.length > 32) list.shift()
  }

  // _pruneActiveProjectiles drops every entry whose age (sim-time
  // since spawn) has reached its lifeMs.  Called once per tick from
  // tick() — keeps the per-slot lists trimmed to ACTUALLY in-flight
  // projectiles so the panel reads as "what's currently visible".
  _pruneActiveProjectiles() {
    const rt = this.viewer.cob?.runtime
    if (!rt) return
    const now = rt.simTimeMs
    for (const slot of ['primary', 'secondary', 'tertiary']) {
      const list = this.activeProjectiles[slot]
      if (!list || list.length === 0) continue
      let writeIdx = 0
      for (let i = 0; i < list.length; i++) {
        const e = list[i]
        if ((now - e.spawnSimMs) < e.lifeMs) list[writeIdx++] = e
      }
      list.length = writeIdx
    }
  }

  // ── Button state refresh ────────────────────────────────────────

  _refreshButtons() {
    const m = this.viewer.unitMeta || {}
    const cob = this.viewer.cob
    // Weapon buttons enable when EITHER:
    //   * the COB ships an Aim* or Fire* script (turrets, kbots) OR
    //   * the FBI declares a Weapon for that slot AND the COB has
    //     a Query* script (aircraft — engine auto-fires in real TA,
    //     so the BOS only ships QueryPrimary returning the projectile
    //     spawn piece).  The studio synthesises a muzzle flash at
    //     that piece when the user clicks Fire so VTOLs aren't
    //     stuck with permanently-grey weapon controls.
    const hasW = (idx) => !!(m.weapons && m.weapons[idx] && m.weapons[idx].name)
    const enabled = {
      move:      !!(m.canMove && cob),
      primary:   !!(cob && (cob.hasScript('AimPrimary')   || cob.hasScript('FirePrimary')   || (hasW(0) && cob.hasScript('QueryPrimary')))),
      secondary: !!(cob && (cob.hasScript('AimSecondary') || cob.hasScript('FireSecondary') || (hasW(1) && cob.hasScript('QuerySecondary')))),
      tertiary:  !!(cob && (cob.hasScript('AimTertiary')  || cob.hasScript('FireTertiary')  || (hasW(2) && cob.hasScript('QueryTertiary')))),
    }
    for (const btn of document.querySelectorAll('#mv-controls-actions .mv-ctrl-action')) {
      const action = btn.dataset.ctrlAction
      if (action === 'stop') continue  // never disabled; live state managed in tick
      btn.disabled = !enabled[action]
      btn.classList.toggle('armed', this.armed === action)
    }
  }

  _refreshArmingClass() {
    const dialog = document.getElementById('model-viewer-dialog')
    if (!dialog) return
    for (const cls of ['arming-move', 'arming-primary', 'arming-secondary', 'arming-tertiary']) {
      dialog.classList.remove('mv-controls-' + cls)
    }
    if (this.armed) dialog.classList.add('mv-controls-arming-' + this.armed)
  }

  // _updateStopLive flips a `.live` class on the Stop button whenever
  // there's something to stop — move target or any aim target.  Lets
  // the user see at a glance that Stop is "doing something" without
  // having to click and find out.
  _updateStopLive() {
    const stop = document.querySelector('#mv-controls-actions .mv-ctrl-action-stop')
    if (!stop) return
    const live = !!(this.targets.move || this.targets.primary || this.targets.secondary || this.targets.tertiary || this.isMoving)
    stop.classList.toggle('live', live)
  }

  // _updateHoverPreview drives the faded-cursor overlay above the
  // scene.  `_hoverPreview` is the slot the user is currently
  // hovering (move/primary/secondary/tertiary).  Lazily creates the
  // overlay <img> on first use; positioning + visibility refresh
  // every tick so camera orbit moves the overlay in lock-step.
  _updateHoverPreview() {
    const slot = this._hoverPreview
    const target = slot ? this.targets[slot] : null
    if (!slot || !target) {
      if (this._previewOverlay) this._previewOverlay.style.display = 'none'
      return
    }
    if (!this._previewOverlay) {
      const img = document.createElement('img')
      img.className = 'mv-ctrl-preview-cursor'
      // Stash inside the model-viewer dialog so tab switches hide it
      // with the rest of the viewer overlay.
      const host = document.getElementById('model-viewer-dialog') || document.body
      host.appendChild(img)
      this._previewOverlay = img
    }
    const img = this._previewOverlay
    // Pick the cursor matching the slot — same source the canvas
    // cursor uses, so the user sees the SAME glyph hovering at the
    // target as appears under their pointer when arming.
    const srcName = (slot === 'move') ? 'cursormove' : 'cursorattack'
    const wantSrc = `/api/studio/cursor/${srcName}`
    if (img.dataset.src !== wantSrc) {
      img.dataset.src = wantSrc
      img.src = wantSrc
    }
    // Project the target's world XYZ to canvas-local pixels.
    const renderer = this.viewer.renderer
    if (!renderer) { img.style.display = 'none'; return }
    // Move targets are stored as [x, z] (no Y); aim targets are
    // [x, y, z].  Project a ground-level point (y=0) for both.
    const wx = target.length === 2 ? target[0] : target[0]
    const wz = target.length === 2 ? target[1] : target[2]
    const screen = renderer.worldToCanvas([wx, 0, wz])
    if (!screen) { img.style.display = 'none'; return }
    const canvas = this.viewer.canvas
    const rect = canvas.getBoundingClientRect()
    img.style.display = ''
    img.style.left = (rect.left + screen.x) + 'px'
    img.style.top  = (rect.top  + screen.y) + 'px'
  }
}
