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

import { SFX_PROJECTILE_BULLET, SFX_PROJECTILE_SHELL, SFX_PROJECTILE_PLASMA, SFX_PROJECTILE_DGUN, SFX_PROJECTILE_LASER, SFX_PROJECTILE_MISSILE, SFX_SMOKE_WHITE } from './model3d/cob/cob-particles.js'

const TA_TICK_HZ = 30                       // FBI rates are per-frame at 30 Hz.
const TA_TURN_FULL = 65536                  // Full turn in TA angle units.

export class MvControls {
  // viewer: ModelViewer.  Provides .cob, .renderer, .canvas, .unitMeta.
  constructor(viewer) {
    this.viewer = viewer
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
    this.altTarget = 0           // where the altitude is heading
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
    // _flybySide alternates between +1 and -1 on consecutive
    // fly-by arcs (fixed-wing aircraft only) so the unit traces a
    // figure-eight pattern over the target rather than a tight
    // identical loop.  Lives on the instance so the value persists
    // across _updateMove ticks.
    this._flybySide = 1
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

  // ── Wiring ──────────────────────────────────────────────────────

  _wireButtons() {
    const buttons = document.querySelectorAll('#mv-controls-actions .mv-ctrl-action')
    for (const btn of buttons) {
      const action = btn.dataset.ctrlAction
      btn.addEventListener('click', (e) => {
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
        btn.addEventListener('mouseenter', () => { this._hoverPreview = action; this._updateHoverPreview() })
        btn.addEventListener('mouseleave', () => { if (this._hoverPreview === action) { this._hoverPreview = null; this._updateHoverPreview() } })
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
    // Run the unit's BOS target-cleared hook — the standard TA
    // mechanism for resetting per-aim state (aimtype, bAiming,
    // turret rotations).  Pass weapon index 0 as the legacy `which`
    // argument; the BOS scripts ignore it but the COB runtime
    // expects a value on the locals stack.  Force-restart by killing
    // any already-running TargetCleared / RestorePosition threads
    // first — without this the Stop button would silently no-op if
    // the user pressed it WHILE a previous Stop's TargetCleared was
    // still mid-animation, leaving the unit in a half-reset pose
    // until that thread finally drained.
    const cob = this.viewer.cob
    if (cob && cob.hasScript && cob.hasScript('TargetCleared')) {
      if (cob.unit && typeof cob.unit.killThreadsByName === 'function') {
        cob.unit.killThreadsByName('TargetCleared')
        cob.unit.killThreadsByName('RestorePosition')
      }
      cob.start('TargetCleared', [0])
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
      if (!this.armed) return
      // Allow normal canvas drag (orbit) when un-armed; only consume
      // the click when arming is active.
      const r = canvas.getBoundingClientRect()
      const cx = (e.clientX - r.left) * (canvas.width / r.width)
      const cy = (e.clientY - r.top)  * (canvas.height / r.height)
      const ground = this.viewer.renderer?.canvasToGroundPoint(cx, cy)
      if (!ground) return
      // The renderer applies the unit transform AFTER the click was
      // unprojected, so target XZ here is in absolute world space —
      // store the same coordinate system.
      const slot = this.armed
      // First-action auto-Create.  Task #125 made Create non-automatic
      // so users can watch the build-shadow animation, but the Controls
      // panel issues real commands to a finished unit — the user
      // expects Move/Fire to "just work" the first time.  Most BOS
      // scripts initialise state vars (bCanAim, MotionControl threads)
      // inside Create; without it, Move animates positionally but legs
      // never move, and Aim* blocks on `while (NOT bCanAim) sleep 100`
      // forever.  Auto-run Create lazily on first armed-click so the
      // unit is alive by the time the command lands.
      this._ensureCreated()
      // Reset BOS aim-state before every new weapon target.  Without
      // this, a previous slot's lingering `aimtype` global (e.g.
      // Commander's AIM_DGUN after firing the d-gun) makes the next
      // AimX script short-circuit with `return FALSE`, and the
      // weapon silently never fires.  We can't rely on the user
      // clicking Stop between actions — commandFire weapons clear
      // their own target after one shot, so the path d-gun → primary
      // never hits Stop.  Skipped for Move and for units without
      // the script.  Also kill our local aim-thread state so the
      // _updateWeapon loop spawns a FRESH AimX on the new target
      // rather than re-reading the stale dead thread's returnValue=0.
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
        this._startMoving()
      } else {
        this.targets[slot] = [ground[0], ground[1], ground[2]]
      }
      this.armed = null
      this._refreshButtons()
      this._refreshArmingClass()
      this._updateArmedCursor()
    }
    // Mousemove → track armed cursor.  Browsers don't animate
    // `cursor: url(...)` (it renders only the first APNG frame),
    // so when armed we hide the native cursor and float an
    // <img> overlay above the pointer — the same animated GAF that
    // appears on the hover-preview overlay.  Position uses
    // pageX/pageY so it works for both windowed + scrolled viewports.
    this._canvasHandlers.mousemove = (e) => {
      this._armedCursorX = e.clientX
      this._armedCursorY = e.clientY
      this._updateArmedCursor()
    }
    this._canvasHandlers.mouseleave = () => {
      // Hide the overlay when the pointer leaves the canvas so the
      // animated glyph doesn't appear to "stick" in place when the
      // user moves over to the Controls panel to disarm.
      this._armedCursorInside = false
      this._updateArmedCursor()
    }
    this._canvasHandlers.mouseenter = () => {
      this._armedCursorInside = true
      this._updateArmedCursor()
    }
    canvas.addEventListener('click', this._canvasHandlers.click)
    canvas.addEventListener('mousemove', this._canvasHandlers.mousemove)
    canvas.addEventListener('mouseleave', this._canvasHandlers.mouseleave)
    canvas.addEventListener('mouseenter', this._canvasHandlers.mouseenter)
    // Remember the canvas we attached to so dispose() can detach from
    // the SAME element even if the viewer hands us a new one later.
    this._wiredCanvas = canvas
  }

  // _updateArmedCursor renders/moves/hides the animated cursor
  // overlay.  Active only when an action is armed AND the pointer
  // is inside the canvas.  Mirrors the hover-preview overlay's
  // pattern: lazy-create the <img>, position it on the pointer,
  // swap src when the armed slot changes, set canvas cursor to
  // 'none' so we don't get a duplicate.
  _updateArmedCursor() {
    const slot = this.armed
    const inside = this._armedCursorInside !== false
    const canvas = this.viewer.canvas
    if (!slot || !inside) {
      if (this._armedCursorOverlay) this._armedCursorOverlay.style.display = 'none'
      if (canvas) canvas.style.cursor = ''
      return
    }
    if (!this._armedCursorOverlay) {
      const img = document.createElement('img')
      img.className = 'mv-ctrl-armed-cursor'
      const host = document.getElementById('model-viewer-dialog') || document.body
      host.appendChild(img)
      this._armedCursorOverlay = img
    }
    const img = this._armedCursorOverlay
    const srcName = (slot === 'move') ? 'cursormove' : 'cursorattack'
    const wantSrc = `/api/studio/cursor/${srcName}`
    if (img.dataset.src !== wantSrc) {
      img.dataset.src = wantSrc
      img.src = wantSrc
    }
    img.style.display = ''
    img.style.left = (this._armedCursorX || 0) + 'px'
    img.style.top  = (this._armedCursorY || 0) + 'px'
    // Hide the native cursor so the user only sees the animated
    // overlay — without this they'd see both glued together (the
    // CSS arming-class cursor + our overlay at the same spot).
    if (canvas) canvas.style.cursor = 'none'
  }

  // ── External hooks ──────────────────────────────────────────────

  // onMetaLoaded is called by the host once the unit's FBI metadata
  // (movement + weapon refs) is in.  Enables / disables buttons
  // based on what the unit actually supports.
  onMetaLoaded() { this._refreshButtons() }

  // tick is called from the renderer's per-frame callback.  dtMs is
  // wall-clock, scaled by runtime.playbackRate so slow-mo applies.
  tick(dtMs) {
    if (!this.viewer.cob) return
    const rate = this.viewer.cob.runtime?.playbackRate ?? 1
    const dtSec = (dtMs * rate) / 1000
    // Sim-scaled dtMs for sub-systems that gate on time but want to
    // honour slow-mo / fast-forward (ship wakes emit on a 100 ms
    // cadence; at 0.1× sim that should be 1000 ms wall, not 100).
    const dtSimMs = dtMs * rate
    this._updateMove(dtSec)
    this._updateAltitude(dtSec)
    this._updateWeapon('primary')
    this._updateWeapon('secondary')
    this._updateWeapon('tertiary')
    this._updateShipWake(dtSimMs)
    // Smoke-trail emitter — moved off setInterval(wall-clock 40 ms)
    // onto the per-frame tick so trail puffs scale with sim speed.
    // At 0.01× a slow-flying laser leaves puffs every 4 s wall ≈
    // 40 ms sim, matching what the projectile's slowed velocity
    // actually traces out.
    this._tickSmokeTrails(dtSimMs)
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
      this._wiredCanvas.removeEventListener('click',      this._canvasHandlers.click)
      this._wiredCanvas.removeEventListener('mousemove',  this._canvasHandlers.mousemove)
      this._wiredCanvas.removeEventListener('mouseleave', this._canvasHandlers.mouseleave)
      this._wiredCanvas.removeEventListener('mouseenter', this._canvasHandlers.mouseenter)
      this._wiredCanvas = null
      this._canvasHandlers = null
    }
    // Drop any live smoke trails so the unit-swap doesn't leave
    // them emitting puffs into the next unit's pool.  No interval
    // handles to clear — trails are ticked from this.tick() and the
    // tick won't run after disposal anyway.
    if (this._trails) this._trails.length = 0
    if (this._previewOverlay) {
      this._previewOverlay.remove()
      this._previewOverlay = null
    }
    if (this._armedCursorOverlay) {
      this._armedCursorOverlay.remove()
      this._armedCursorOverlay = null
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
    // Same native-orientation default as the constructor — see comment
    // there for why heading starts at π (3DO nose-at-minus-Z convention).
    this.heading = Math.PI
    this.isMoving = false
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
      cob.start('Create')
      cob._lifecycle = 'created'
    } else {
      cob._lifecycle = 'created'
    }
  }

  _startMoving() {
    if (this.isMoving) return
    this.isMoving = true
    const cob = this.viewer.cob
    // StartMoving is optional — many tank-style scripts don't ship it.
    if (cob.hasScript('StartMoving')) cob.start('StartMoving')
    // Aircraft climb to cruise altitude when motion starts.  Hover
    // and fixed-wing both rise; the difference shows up in how they
    // behave at the target (hover stops, fighter loops back).
    const m = this.viewer.unitMeta
    if (m && m.isAircraft) {
      this.altTarget = this._cruiseAltClamped()
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
    if (cob.hasScript('StopMoving')) cob.start('StopMoving')
    // Aircraft descend to ground when their move target is cleared.
    // The descent runs in _updateAltitude below; Deactivate fires
    // immediately on STOP (not on touchdown) so the wings-fold
    // animation plays DURING the descent rather than after the
    // unit has already settled — matches how TA itself sequences
    // the landing: deactivate animation runs while the aircraft
    // glides down to the ground.
    const m = this.viewer.unitMeta
    if (m && m.isAircraft) {
      this.altTarget = 0
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

  // _updateAltitude lerps `this.alt` toward `this.altTarget` using
  // the FBI Acceleration / BrakeRate values to derive realistic
  // climb + descent rates.  Ground/sea units leave both alt +
  // target at 0 so this is a no-op for them.  Deactivate fires from
  // _stopMoving (not on touchdown) so the wings-fold animation
  // plays DURING descent — by the time we reach alt=0 the unit is
  // already in its deactivated pose.
  _updateAltitude(dtSec) {
    const m = this.viewer.unitMeta
    if (!m || !m.isAircraft) {
      this.alt = 0
      this.altTarget = 0
      return
    }
    const startAlt = this.alt
    // FBI Acceleration / BrakeRate drive how briskly the aircraft
    // climbs + descends.  We scale them to a perceptible "gradual
    // lift" pace (the studio camera frames the unit close, so a
    // realistic ~3 m/s rotor lift would feel glacial here).  Each
    // value is clamped to a [floor, ceiling] band so under-spec
    // FBIs still produce visible motion and over-spec ones (e.g.
    // BrakeRate=9 for Hawk) don't snap the unit to the ground.
    //   climbRate  = Acceleration * 100, clamped to [12, 80] wu/sec
    //   descendRate = BrakeRate    * 10,  clamped to [8,  40] wu/sec
    // For Hawk (accel 0.45, brake 9) ⇒ climb 45 wu/sec, descend 40
    // wu/sec — lifts to its clamped cruise alt (~25 wu) in ~0.6s,
    // settles back down in ~0.6s.  For Brawler (accel 0.16, brake
    // 4) ⇒ climb 16 wu/sec, descend 40 wu/sec — slower lift, fast
    // settle, which matches the heavier-hover feel.
    const accel = m.acceleration || 0.1
    const brake = m.brakeRate || 0.1
    const climbRate   = Math.max(12, Math.min(80, accel * 100))
    const descendRate = Math.max(8,  Math.min(40, brake * 10))
    const rate = (this.altTarget > this.alt) ? climbRate : descendRate
    const step = rate * dtSec
    if (Math.abs(this.altTarget - this.alt) <= step) {
      this.alt = this.altTarget
    } else {
      this.alt += Math.sign(this.altTarget - this.alt) * step
    }
    // Push the new Y onto the renderer.  Calling
    // _applyRendererTransform here (not just from _updateMove)
    // means an aircraft descending after Stop is cleared still
    // visibly drops to the ground — _updateMove returns early when
    // the move target is null, so the Y change would otherwise be
    // computed but never pushed to the GPU.
    if (this.alt !== startAlt) this._applyRendererTransform()
    // Touchdown bookkeeping — no longer fires Deactivate (that
    // moved to _stopMoving so the fold animation plays during
    // descent).  Just keeps wasLanded in sync for any future
    // transition-edge logic.
    this.wasLanded = this.alt <= 0.5
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
    try {
      const audio = new Audio(`/api/studio/sound/${encodeURIComponent(stem)}`)
      audio.volume = 0.85
      // Fire-and-forget — Chromium occasionally rejects play() when
      // there's no user gesture; swallowing the rejection keeps the
      // controls path silent rather than spraying console errors.
      const p = audio.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      // Ignore — older browsers without the Audio constructor just
      // skip the sound.
    }
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

  _updateMove(dtSec) {
    const target = this.targets.move
    if (!target) return
    const m = this.viewer.unitMeta || {}
    const dx = target[0] - this.pos.x
    const dz = target[1] - this.pos.z
    const dist = Math.hypot(dx, dz)
    // Fixed-wing aircraft (aircraft && !hover) can't stop mid-air —
    // they fly through the target and arc back.  When we get close,
    // we recompute the target as a fly-by point on the far side of
    // the requested location, offset perpendicular to the approach
    // so the unit traces a wide arc through it.  Hover aircraft +
    // ground/sea units stop normally on arrival.
    const isFixedWingAir = !!(m.isAircraft && !m.isHover)
    const arriveThreshold = isFixedWingAir ? 40 : 0.5
    if (dist < arriveThreshold) {
      if (isFixedWingAir) {
        // Pick a new target: continue past the current one, offset
        // sideways by ~120 wu so the unit banks back around.  Each
        // arc-end picks the side opposite the last, giving a rough
        // figure-eight pattern over the target rather than a tight
        // circle that the user might mistake for hovering.
        const fwdX = Math.sin(this.heading)
        const fwdZ = Math.cos(this.heading)
        // Perpendicular (right-hand side of heading): rotateY(-π/2).
        const sx = fwdZ, sz = -fwdX
        this._flybySide = (this._flybySide || 1) * -1
        const lead = 220, lateral = 140 * this._flybySide
        this.targets.move = [
          target[0] + fwdX * lead + sx * lateral,
          target[1] + fwdZ * lead + sz * lateral,
        ]
        return  // recompute next tick against new target
      }
      // Arrived (hover / ground / sea).
      this.pos.x = target[0]
      this.pos.z = target[1]
      this.targets.move = null
      this._stopMoving()
      this._applyRendererTransform()
      return
    }
    // Desired heading: atan2 with renderer convention (+Z forward).
    const want = Math.atan2(dx, dz)
    const turnRate = this._turnRateRadPerSec()
    let dh = want - this.heading
    // Shortest-arc unwrap.
    while (dh >  Math.PI) dh -= Math.PI * 2
    while (dh < -Math.PI) dh += Math.PI * 2
    const turnStep = turnRate * dtSec
    if (Math.abs(dh) > turnStep) {
      this.heading += Math.sign(dh) * turnStep
    } else {
      this.heading = want
    }
    // Forward advance.  Three movement models:
    //   * Fixed-wing aircraft: always full speed, never clamped —
    //     trace a banking arc through the target.
    //   * Ships (+ hover units): translate WHILE turning.  Real
    //     boats arc around the target; they don't pivot in place.
    //     Speed scales with how close to aligned we are
    //     (cos(dh)² so a 90° misalignment gives 0 forward speed, a
    //     30° gives ~75%) — this keeps the unit visibly moving from
    //     the moment Move is clicked instead of sitting at the
    //     spawn point rotating for 13 seconds (ARMBATS at TurnRate
    //     64 is the canonical example).
    //   * Ground units (kbots, tanks): pivot in place, then walk
    //     once aligned.  Matches the legged + tracked feel.
    const isShipOrHover = !!(m.isShip || m.isSub || m.isHover)
    const aligned = (Math.abs(dh) <= turnStep) || isFixedWingAir
    if (aligned || isShipOrHover) {
      const speed = this._maxVelocityWUPerSec()
      let scale = 1
      if (isShipOrHover && !aligned) {
        const cosA = Math.cos(dh)
        scale = Math.max(0, cosA * cosA)        // cos² — 0 at 90°, 0.75 at 30°
      }
      const baseStep = speed * dtSec * scale
      const step = isFixedWingAir
        ? speed * dtSec                          // always full speed, never clamped — fighter doesn't slow at the target
        : Math.min(baseStep, dist)
      this.pos.x += Math.sin(this.heading) * step
      this.pos.z += Math.cos(this.heading) * step
    }
    this._applyRendererTransform()
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
    const r = this.viewer.renderer
    if (!this.tracking && !(r && r.autoRotate)) return
    const cam = this.viewer.camera
    if (!cam) return
    // Lag-lerp the camera target toward the unit instead of snapping.
    // A perfect snap keeps the unit pinned to screen-centre as it
    // walks, which reads as "stationary unit, moving world" — users
    // (correctly) report it as "the unit isn't moving."  Lerping at
    // ~12% per frame leaves the unit visibly ahead of camera-centre
    // while it walks (so motion is obvious), and the camera catches
    // up within ~half a second after the unit stops so the view ends
    // re-centred on the target.  AutoRotate paths still want the snap
    // because that camera orbits CONTINUOUSLY and a lag would feel
    // sluggish; gate the lerp on the explicit `tracking` flag only.
    if (this.tracking) {
      const k = 0.12
      cam.target[0] += (this.pos.x - cam.target[0]) * k
      cam.target[2] += (this.pos.z - cam.target[2]) * k
    } else {
      cam.target[0] = this.pos.x
      cam.target[2] = this.pos.z
    }
    r?.requestRedraw()
  }

  // setTracking flips tracking on/off.  Public so the Renderer
  // panel's checkbox + the studio-level T-key handler can both
  // drive it.  Turning ON ALWAYS re-snaps the camera onto the
  // unit — even if tracking was already on, because the user may
  // have just panned the view away (shift-pan clears tracking;
  // re-pressing T then explicitly wants the snap back).  Turning
  // OFF just updates the flag so the next _applyRendererTransform
  // call leaves the camera alone.
  setTracking(on) {
    const next = !!on
    this.tracking = next
    if (next) this._followCamera()
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
    document.addEventListener('keydown', (e) => {
      const dlg = document.getElementById('model-viewer-dialog')
      if (!dlg || dlg.classList.contains('hidden')) return
      const tgt = e.target
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return
      if (tgt && tgt.isContentEditable) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = (e.key || '').toLowerCase()
      if (k === 't') { e.preventDefault(); this.setTracking(!this.tracking); return }
      if (k === 'm') { e.preventDefault(); this._armSlotHotkey('move'); return }
      if (k === 'a') { e.preventDefault(); this._armSlotHotkey('primary'); return }
      if (k === 'f') { e.preventDefault(); this._armSlotHotkey('secondary'); return }
      if (k === 'd') { e.preventDefault(); this._armSlotHotkey('tertiary'); return }
      if (k === 's') { e.preventDefault(); this._stopAllTargets(); return }
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

  _maxVelocityWUPerSec() {
    // FBI MaxVelocity is in "FBI units / frame" at 30 FPS.  TA unit
    // distances are roughly equivalent to world units in our viewer
    // at the renderer's scale, so the raw FBI number * 30 gives a
    // reasonable walking speed.  Fall back to a sensible default
    // when meta hasn't loaded.
    const m = this.viewer.unitMeta
    const v = (m && m.maxVelocity) ? m.maxVelocity : 1.0
    return v * TA_TICK_HZ
  }
  _turnRateRadPerSec() {
    // FBI TurnRate is TA-angle units per frame.  Convert to radians
    // per second: rad/sec = (TA/frame) * (2π / 65536) * 30.
    const m = this.viewer.unitMeta
    const t = (m && m.turnRate) ? m.turnRate : 600
    return (t / TA_TURN_FULL) * Math.PI * 2 * TA_TICK_HZ
  }

  // ── Per-frame aim + fire ────────────────────────────────────────

  _updateWeapon(slot) {
    const target = this.targets[slot]
    if (!target) return
    const cob = this.viewer.cob
    if (!cob) return
    const state = this.aimState[slot]
    const aimScript = 'Aim' + capitalise(slot)
    const fireScript = 'Fire' + capitalise(slot)
    const hasAim = cob.hasScript(aimScript)
    const hasFire = cob.hasScript(fireScript)
    // Sim-time clock — at 0.5× playback `now` advances at half wall
    // rate, so a 2 s reload waits 4 s of wall time but stays 2 s in
    // sim time.  When the user pauses the runtime, simTimeMs freezes
    // and the weapon's reload + burst gates freeze with it, matching
    // the rest of the simulation.
    const now = cob.runtime.simTimeMs
    const reloadMs = this._reloadMs(slot)
    const sinceLastFire = now - (state.lastFireMs ?? -Infinity)
    const reloadReady = sinceLastFire >= reloadMs
    // Aim-completion state.  When AimX returns 1, the thread dies
    // with returnValue=1 — that's our "you may fire" signal.  Units
    // without an AimX script (aircraft, mostly) get an implicit
    // "always ready" via hasAim=false.
    const aimDoneOk = !hasAim || (state.thread && state.thread.dead && state.thread.returnValue === 1)
    // Stuck-aim detection — if AimX has been running for longer
    // than 2× reload without dying, the unit's walk animation is
    // probably wrestling with our turret pieces (PeeWee's walklegs
    // keeps the upper arms swinging, so AimPrimary's
    // wait-for-turn on lloarm/luparm never settles).  Treat the
    // aim as done so the user still sees the weapon discharge —
    // matches TA's behaviour of firing on the reload cadence even
    // when the turret isn't perfectly aligned with the target.
    const aimAgeMs = state.threadStartMs ? (now - state.threadStartMs) : 0
    const aimStuck = hasAim && state.thread && !state.thread.dead && aimAgeMs > reloadMs * 2
    // Fire when the reload's elapsed AND we're either aim-ready
    // or aim has been stuck too long.
    // Burst-fire support — TDF `burst` declares how many shots per
    // burst (EMG = 3) and `burstrate` the inter-shot delay (EMG =
    // 0.1 s).  Reload only starts after the full burst has been
    // emitted.  burstShotsLeft holds the in-flight burst counter:
    // 0 = ready to start a new burst (gated on reloadReady),
    // >0 = mid-burst (gated on the intra-burst timer).
    const w = this._weaponForSlot(slot)
    const burstSize = (w && w.burst > 1) ? w.burst : 1
    const burstGapMs = (w && w.burstRateSec > 0) ? w.burstRateSec * 1000 : 0
    const inBurst = state.burstShotsLeft > 0
    const burstReady = inBurst && now >= state.nextBurstShotAtMs
    const startBurst = !inBurst && reloadReady && (aimDoneOk || aimStuck)
    if (startBurst || burstReady) {
      state.lastFireMs = now
      if (startBurst) {
        // Initialise the burst counter to (burstSize - 1) because
        // we're about to fire shot #1 right now.  Subsequent shots
        // tick the counter down each pass.
        state.burstShotsLeft = burstSize - 1
      } else {
        state.burstShotsLeft -= 1
      }
      // Schedule the next intra-burst shot.  Zero burstGap collapses
      // to "next tick" which fires every frame (≤ 16 ms) — fine for
      // weapons that don't bother with the field.
      state.nextBurstShotAtMs = now + burstGapMs
      if (hasFire) {
        // Standard path: start the Fire* script — the cob-binding's
        // start() hook auto-injects a muzzle burst at the flare
        // piece so the user sees the shot.
        cob.start(fireScript)
      } else if (cob._emitFireBurst) {
        // Aircraft fallback — the BOS ships QueryPrimary (returning
        // the projectile spawn piece) but no Fire script, since the
        // game engine auto-fires aircraft.  Synthesise the visual
        // by hand: emit a muzzle flash at the flare/query piece so
        // the studio user sees the weapon "fire" even though no
        // script ran.  Reuses the binding's existing burst helper.
        cob._emitFireBurst(fireScript)
      }
      // Travelling projectile + weapon sound — spawned for every
      // shot in the burst regardless of which path above ran, so
      // the user sees a shell/bullet/plasma bolt fly from the firing
      // piece toward the target and hears the weapon's TDF-defined
      // soundstart.
      this._spawnProjectile(slot, target)
      // Kill the stale aim thread only on the FIRST shot of a burst
      // — keeping it alive across the burst lets the turret track
      // the target while shots are still cycling out.  The reload
      // gate above only fires once per burst, so subsequent burst
      // shots don't trigger a new aim thread anyway.
      if (startBurst) {
        if (state.thread && !state.thread.dead) state.thread.dead = true
        state.thread = null
        state.threadStartMs = null
      }
      // commandfire=1 (d-gun, etc.) — TA's "fire once on explicit
      // command" flag.  After the burst's first shot lands, drop the
      // target so the slot doesn't re-fire on the next reload.  The
      // user re-arms + clicks Tertiary again for a second shot, which
      // matches the in-game D-key behaviour.  Burst-mid shots still
      // run (matters when a hypothetical commandfire weapon ships
      // burst>1; vanilla d-gun is single-shot).
      if (w && w.commandFire && state.burstShotsLeft === 0) {
        this.targets[slot] = null
      }
    }
    // Always keep an aim thread in flight so the turret tracks the
    // target — without this, after firing we'd have no aim running
    // and the turret would just sit at its last position.  Spawn a
    // fresh one if none alive (covers both the just-fired case and
    // the "AimPrimary returned 1 mid-tick" case).
    if (hasAim && (!state.thread || state.thread.dead)) {
      const { heading, pitch } = this._aimAnglesFor(target, slot)
      state.thread = cob.unit.startThread(aimScript, [heading | 0, pitch | 0])
      state.threadStartMs = now
    } else if (!hasAim && !state.thread) {
      // No aim script — synthesise a "always ready" pseudo-thread.
      state.thread = { dead: true, returnValue: 1 }
    }
  }

  _aimAnglesFor(target, slot) {
    // Compute the turret-local heading + pitch that points at `target`.
    //
    // Coordinate-system bookkeeping (the part that bit me before):
    //   worldHeading + this.heading are angles measured CCW from +Z
    //     (the renderer / OpenGL right-handed convention).
    //   `rel` = worldHeading - this.heading = the angle the body
    //     would need to rotate CCW to face the target.
    //   TA's AimWeapon, however, expects CW-positive heading from
    //     the body's forward (left-handed TA convention).  So `rel`
    //     and the TA value differ in SIGN.
    //   The cob-binding compensates with `piece.rotate[1] = -rot[1]`
    //     when it pushes the animator's value into the render piece,
    //     which means we negate the TA value here so the
    //     animator → binding → renderer chain composes to land the
    //     turret on the target.  Without the negation the turret
    //     ends up mirrored across the body's forward axis.
    const dx = target[0] - this.pos.x
    const dz = target[2] - this.pos.z
    const horizDist = Math.hypot(dx, dz)
    const worldHeading = Math.atan2(dx, dz)
    let rel = worldHeading - this.heading
    while (rel >  Math.PI) rel -= Math.PI * 2
    while (rel < -Math.PI) rel += Math.PI * 2
    const headingTA = -(rel / (Math.PI * 2)) * TA_TURN_FULL
    // Pitch — three flavours:
    //   * ballistic weapon (FBI weapon.ballistic = true):  solve the
    //     projectile-motion quadratic for the low-arc launch angle so
    //     the shell drops onto the target after the right time of flight.
    //     Gravity comes from the active environment (Lunar gives a
    //     visibly flatter arc).  Out-of-range targets fall back to 45°.
    //   * non-ballistic (laser / missile):  aim along the direct line
    //     of sight, atan2(verticalOffset, horizontalDist).
    //   * no slot info or no weapon data:  pitch=0 (treat as
    //     line-of-sight aimed horizontally — preserves the old
    //     studio-default behaviour for ad-hoc Aim calls).
    let pitchRad = 0
    const w = this._weaponForSlot(slot)
    // `target[1]` is the world-Y of the resolved click (water/ground).
    // The unit itself can be at altitude (aircraft), so subtract its
    // current alt to get the vertical delta the projectile must cover.
    // 2-element move targets (no Y) fall back to ground = 0.
    const targetY = target.length >= 3 ? target[1] : 0
    const vDelta = targetY - (this.alt || 0)
    if (horizDist > 0.0001 && w && w.ballistic && w.velocityWU > 0) {
      const v = w.velocityWU
      const g = this.viewer.renderer && typeof this.viewer.renderer.getGravity === 'function'
        ? this.viewer.renderer.getGravity()
        : 80
      // Standard ballistic-launch-angle quadratic:
      //   tan(θ) = ( v² ± √( v⁴ - g(g·d² + 2·h·v²) ) ) / (g·d)
      // Take the MINUS root for the low / direct-fire arc (the PLUS root
      // is the high / mortar arc — also valid but visually less
      // representative of what TA cannons do).
      const v2 = v * v
      const d  = horizDist
      const disc = v2 * v2 - g * (g * d * d + 2 * vDelta * v2)
      if (disc >= 0) {
        const root = Math.sqrt(disc)
        const tanLow = (v2 - root) / (g * d)
        pitchRad = Math.atan(tanLow)
      } else {
        // Target out of range — pin the barrel at 45°, the maximum-
        // range launch angle, so the user at least sees the cannon
        // try.  Real TA refuses to fire in this case.
        pitchRad = Math.PI / 4
      }
    } else if (horizDist > 0.0001) {
      pitchRad = Math.atan2(vDelta, horizDist)
    }
    const pitchTA = (pitchRad / (Math.PI * 2)) * TA_TURN_FULL
    return { heading: headingTA, pitch: pitchTA }
  }

  // _spawnProjectile spawns a travelling particle from the slot's
  // firing piece (QueryPrimary/Secondary/Tertiary on the model)
  // heading toward `target` at the FBI-defined `weaponvelocity`.
  // Ballistic weapons get gravity from the active environment so
  // shells arc visibly; non-ballistic travel in a straight line.
  // Lifetime is sized so the projectile expires at roughly its
  // weapon range — matches TA's behaviour of "fire and forget"
  // ammo that disappears once it would have flown past max range.
  // Also plays the weapon's TDF soundstart (cannhvy1 for ARM_BATS
  // etc.) when defined.
  _spawnProjectile(slot, target) {
    const mv = this.viewer
    const cob = mv.cob
    if (!cob || !cob.particles || !mv.model) return
    const w = this._weaponForSlot(slot)
    if (!w) return
    // Resolve the firing piece (flare / barrel / firept).  Reuse
    // the same name-list cob-binding._emitFireBurst uses so the
    // bullet exits exactly where the muzzle flash lights up.
    const firePiece = this._firingPieceFor(slot)
    const anchor = this._pieceWorldPos(firePiece)
    if (!anchor) return
    // Aim vector: target − firingPiece, normalised.  Non-ballistic
    // weapons fly straight at this; ballistic ones launch at the
    // pitch the solver computed for the AimX call so the trajectory
    // actually intersects the target.
    const dx = target[0] - anchor[0]
    const dy = (target.length >= 3 ? target[1] : 0) - anchor[1]
    const dz = target[2] - anchor[2]
    const horiz = Math.hypot(dx, dz)
    if (horiz < 0.001) return
    // Beam weapons (lasers, the d-gun's TDF also sets it but we
    // routed dgun separately above for the giant green orb).  Real
    // TA draws a brief coloured line from muzzle to target — we fake
    // it by lighting up a chain of static pulse particles along the
    // line, which read as a continuous beam for the few frames they
    // live.  No travel time, no gravity, no projectile sound past
    // the start.  Skip the standard projectile path.
    if (w.beamWeapon && !/disintegrator|dgun|d_gun/i.test(w.name)) {
      this._spawnLaserBeam(w, anchor, [target[0], (target.length >= 3 ? target[1] : 0), target[2]])
      if (w.soundStart) this._playWeaponSound(w.soundStart)
      return
    }
    const v = +w.velocityWU || 200
    let vx, vy, vz
    if (w.ballistic) {
      // Re-run the ballistic solver to keep the projectile + the
      // turret in agreement.  Pitch comes from the same launch-
      // angle formula used in _aimAnglesFor (in radians here, not
      // TA-angle units).
      const g = (mv.renderer && typeof mv.renderer.getGravity === 'function')
        ? mv.renderer.getGravity() : 80
      const v2 = v * v
      const disc = v2 * v2 - g * (g * horiz * horiz + 2 * dy * v2)
      let pitchRad
      if (disc >= 0) {
        pitchRad = Math.atan((v2 - Math.sqrt(disc)) / (g * horiz))
      } else {
        pitchRad = Math.PI / 4  // out of range, max-range launch
      }
      const horizDir = [dx / horiz, dz / horiz]
      const cosP = Math.cos(pitchRad)
      vx = horizDir[0] * v * cosP
      vz = horizDir[1] * v * cosP
      vy = v * Math.sin(pitchRad)
    } else {
      const len = Math.hypot(dx, dy, dz)
      vx = (dx / len) * v
      vy = (dy / len) * v
      vz = (dz / len) * v
    }
    // Lifetime: range / velocity gives the time-of-flight at top
    // speed.  Multiply by 1.5 for ballistic arcs (which travel a
    // longer path along the arc) so the shell doesn't vanish
    // mid-flight on a long shot.  Clamp the floor so super-fast
    // weapons don't blink out.
    const range = +w.rangeWU || (v * 3)
    const lifeFactor = w.ballistic ? 1.5 : 1.0
    const lifeMs = Math.max(300, (range / v) * 1000 * lifeFactor)
    // Pick a visual kind for the projectile.  Heuristics on weapon
    // name + ballistic flag — TA has dozens of weapons and we
    // don't ship per-weapon visuals, so this groups them into a
    // handful of distinct looks (cannon shells, kbot bullets,
    // missiles + plasma).  Caller can extend later.
    let kind = SFX_PROJECTILE_BULLET
    // D-Gun first — disintegrator / dgun names map to the big green
    // orb regardless of any laser/plasma keyword that might appear in
    // a variant's name.  Checked BEFORE the laser/plasma fallback so
    // a hypothetical "PLASMA_DISINTEGRATOR" still reads as the d-gun.
    // Missile next — TDF's `smoketrail` / `selfprop` flags + the
    // `model=missile|rocket` name are the canonical way TA marks a
    // self-propelled smoke-trailing projectile.  Picking these BEFORE
    // the ballistic check lets the AAS missile (ballistic in the
    // tracking sense, but not arc-cannon ballistic) take the missile
    // visual instead of the artillery-shell one.
    if (/disintegrator|dgun|d_gun/i.test(w.name)) kind = SFX_PROJECTILE_DGUN
    else if (w.smokeTrail || w.selfProp || /missile|rocket/i.test(w.model || '')) kind = SFX_PROJECTILE_MISSILE
    else if (w.ballistic) kind = SFX_PROJECTILE_SHELL
    else if (/laser|plasma|emg|emp|beam/i.test(w.name)) kind = SFX_PROJECTILE_PLASMA
    const emitOpts = {
      velocity: [vx, vy, vz],
      gravity: w.ballistic ? (mv.renderer?.getGravity?.() || 80) : 0,
      lifeMs,
      noFade: true,
    }
    cob.particles.emit(kind, anchor, emitOpts)
    // Smoke trail — for missile-class projectiles, register a tick
    // hook that drops a smoke puff at the projectile's CURRENT world
    // position every ~40 ms while it's alive, so the user sees a
    // visible wake instead of a lone dot.  We don't track the actual
    // particle slot (the pool compacts dead entries, invalidating
    // indexes); instead the hook recomputes the position from launch
    // + velocity + elapsed time and decays itself when the projectile
    // would have expired.
    if (kind === SFX_PROJECTILE_MISSILE) {
      this._scheduleSmokeTrail(anchor, [vx, vy, vz], emitOpts.gravity, lifeMs)
    }
    // Weapon-start sound.  Falls back gracefully via /api/studio/sound
    // — if the .wav isn't in the VFS the audio fetch 404s silently
    // and we just play nothing for that shot.
    if (w.soundStart) this._playWeaponSound(w.soundStart)
  }

  // _spawnLaserBeam draws a single-frame beam from `anchor` to
  // `target` by emitting a chain of bright pulse particles along the
  // line.  TDF `beamweapon=1` is the canonical "instant-hit" flag —
  // real TA renders a coloured beam visible for one or two frames,
  // never a travelling sprite.  Our pool doesn't render lines, so we
  // approximate with ~one particle per 8 wu of beam length (capped),
  // each living ~160 ms so the whole streak flashes briefly then
  // fades.  The tint comes from the TDF `color` palette index (or
  // `color2` as a fallback) resolved through the model viewer's
  // palette; weapons without a palette ref fall back to a default
  // yellow-green pulse that's clearly readable on any backdrop.
  _spawnLaserBeam(w, anchor, target) {
    const cob = this.viewer.cob
    if (!cob || !cob.particles) return
    const dx = target[0] - anchor[0]
    const dy = target[1] - anchor[1]
    const dz = target[2] - anchor[2]
    const len = Math.hypot(dx, dy, dz)
    if (len < 0.001) return
    const color = this._laserColor(w)
    // One pulse per ~4 wu — with the 28-wu pulse size each blob
    // overlaps its neighbour by ~85%, so the chain reads as a single
    // wide stripe rather than discrete dots.  Cap at 120 to keep the
    // pool sane on a max-range shot (e.g. range 480 → 120 pulses).
    const segs = Math.max(16, Math.min(120, Math.round(len / 4)))
    for (let i = 0; i <= segs; i++) {
      const t = i / segs
      const p = [anchor[0] + dx * t, anchor[1] + dy * t, anchor[2] + dz * t]
      cob.particles.emit(SFX_PROJECTILE_LASER, p, {
        color,
        velocity: [0, 0, 0],
        gravity: 0,
        noFade: false,
      })
    }
  }

  // _laserColor returns the laser tint [r,g,b,a] in 0..1 floats from
  // the weapon's TDF palette indices.  TA's `color=` is the brightest
  // shade (used for the beam core); `color2=` is the darker rim — we
  // just use `color` since our beam is a single colour.  The model
  // viewer's palette is loaded once on first model load; if it isn't
  // ready yet we fall back to a TA-green default so the beam still
  // appears (cosmetic-only, no functional regression).
  _laserColor(w) {
    const pal = this.viewer.palette
    const idx = (w.colorIdx > 0) ? w.colorIdx : (w.color2Idx > 0 ? w.color2Idx : 0)
    if (pal && idx > 0) {
      const c = pal.colorFor(idx)
      // Boost above 1.0 so the additive blend produces the bright
      // saturated beam look TA's hand-drawn sprites give.  Capped at
      // 2.0 to stay readable when overlapping multiple shots.
      return [Math.min(2, c[0] * 1.8), Math.min(2, c[1] * 1.8), Math.min(2, c[2] * 1.8), 1]
    }
    return [0.45, 1.80, 0.45, 1]
  }

  // _scheduleSmokeTrail registers a smoke-trail emitter for a
  // projectile.  Each frame, _tickSmokeTrails() advances the trail's
  // sim-time clock and drops puffs at 40 ms sim-intervals — at 0.1×
  // playback that's 400 ms wall, matching the projectile's slowed
  // velocity so puffs trace the actual flight path.  Used for
  // missiles (TDF `smoketrail=1`).  Stored on `this._trails` so
  // dispose() can drop them when the unit unloads.
  //
  // Was an interval-driven emitter; moved to per-frame so trail
  // cadence scales with runtime.playbackRate (slow-mo doesn't pile
  // puffs into a tight clump at the projectile's slow position).
  _scheduleSmokeTrail(anchor, velocity, gravity, lifeMs) {
    const cob = this.viewer.cob
    if (!cob || !cob.particles) return
    if (!this._trails) this._trails = []
    this._trails.push({
      anchor:   [anchor[0], anchor[1], anchor[2]],
      velocity: [velocity[0], velocity[1], velocity[2]],
      gravity,
      lifeMs,
      ageMs: 0,
      nextEmitMs: 0,
    })
  }

  // _tickSmokeTrails advances every live trail by dtSimMs and emits
  // puffs at 40 ms sim-intervals.  Trails older than their declared
  // lifeMs are pruned in-place.  Called from the per-frame tick.
  _tickSmokeTrails(dtSimMs) {
    if (!this._trails || !this._trails.length) return
    const cob = this.viewer.cob
    if (!cob || !cob.particles) return
    const INTERVAL_MS = 40
    let writeIdx = 0
    for (let i = 0; i < this._trails.length; i++) {
      const t = this._trails[i]
      t.ageMs += dtSimMs
      if (t.ageMs >= t.lifeMs) continue  // drop expired
      while (t.ageMs >= t.nextEmitMs) {
        t.nextEmitMs += INTERVAL_MS
        const elapsed = Math.min(t.ageMs, t.lifeMs) / 1000
        const px = t.anchor[0] + t.velocity[0] * elapsed
        const py = t.anchor[1] + t.velocity[1] * elapsed - 0.5 * t.gravity * elapsed * elapsed
        const pz = t.anchor[2] + t.velocity[2] * elapsed
        cob.particles.emit(SFX_SMOKE_WHITE, [px, py, pz], {
          size: 4,
          lifeMs: 800,
          riseSpeed: 1.5,
          drift: 0.8,
        })
      }
      this._trails[writeIdx++] = t
    }
    this._trails.length = writeIdx
  }

  // _firingPieceFor picks the model piece a slot's projectile should
  // exit from.  PRIMARY path: invoke the unit's QueryX script in
  // synchronous "query mode" — runQuery executes the script start-
  // to-finish in the current frame (no sleep / wait / turn allowed)
  // and returns whatever piece index ended up in locals[0], which
  // is the BOS-convention out-parameter slot for Query scripts:
  //
  //     QueryPrimary(piecenum) { piecenum = rfire; }
  //
  // PeeWee toggles between rfire/lfire via the `gun` static var, so
  // each shot's query call alternates barrels exactly like the in-
  // game engine does.  Fallback (no QueryX, or query refused to run
  // because it tried to yield) is the legacy name-heuristic scan.
  _firingPieceFor(slot) {
    const model = this.viewer.model
    const cob = this.viewer.cob
    if (!model) return null
    // Synchronous QueryX — single source of truth for the firing
    // piece when the unit ships one (almost every TA weapon-bearing
    // unit does).  runQuery returns null when the unit has no such
    // script OR when the script can't resolve in one tick — fall
    // through to the name heuristics in either case.
    const queryName = 'Query' + slot.charAt(0).toUpperCase() + slot.slice(1)
    if (cob && cob.unit && cob.hasScript(queryName)) {
      // Pass a single 0-arg so the script's `piecenum` parameter
      // (always declared as arg 0 in TA BOS) gets a stable starting
      // value.  Whatever the script writes to it propagates back
      // through locals[0].
      const pieceIdx = cob.unit.runQuery(queryName, [0])
      // pieceIdx indexes the COB header's piece-name table (the
      // order pieces are declared in the BOS `piece` statement) —
      // NOT the 3DO DFS-flat order.  PeeWee's COB declares
      // torso,ruparm,luparm,rfire,lfire,rloarm,lloarm so rfire=3,
      // but the 3DO DFS flat[3] is rleg.  Resolve the index through
      // the COB piece-name table, then look the piece up on the
      // model by name so renderer + COB stay in sync.
      const names = cob.unit.pieceNames || []
      if (pieceIdx != null && pieceIdx >= 0 && pieceIdx < names.length) {
        const p = model.findPiece(names[pieceIdx])
        if (p) return p
      }
    }
    // Fallback name-heuristic (used by units without a QueryX or
    // when a query script tried to yield).  Same logic the muzzle
    // burst helper uses so the projectile + flash share an anchor.
    const idx = { primary: 1, secondary: 2, tertiary: 3 }[slot] || 1
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

  // _pieceWorldPos extracts the world-space (post-COB-anim) position
  // of a piece by reading the translation column of its worldMatrix.
  // computeWorldMatrix is called on every render frame by the
  // hover-highlight + reflection passes, so by the time this fires
  // the matrix is fresh.  Falls back to the unit's own world XYZ
  // when the piece is null / has no world matrix yet.
  _pieceWorldPos(piece) {
    if (piece && piece.worldMatrix) {
      const m = piece.worldMatrix
      return [m[12], m[13], m[14]]
    }
    return [this.pos.x, this.alt, this.pos.z]
  }

  // _playWeaponSound is a thin wrapper around the Audio() flow used
  // for unit sounds — separate function so per-shot debounce can
  // diverge from the unit-sound debounce in future (rapid-fire EMGs
  // shouldn't drop the second 80 ms shot's noise, for example).
  _playWeaponSound(stem) {
    if (!stem) return
    try {
      const audio = new Audio(`/api/studio/sound/${encodeURIComponent(stem)}`)
      audio.volume = 0.7
      const p = audio.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch { /* ignore */ }
  }

  // _weaponForSlot returns the FBI weapon record for a slot string.
  // Used by the aim solver to decide whether to compute a ballistic
  // launch angle.  Returns null when the FBI hasn't loaded yet or
  // the slot has no weapon.
  _weaponForSlot(slot) {
    const m = this.viewer.unitMeta
    if (!m || !m.weapons) return null
    const idx = { primary: 0, secondary: 1, tertiary: 2 }[slot]
    if (idx === undefined) return null
    const w = m.weapons[idx]
    return (w && w.name) ? w : null
  }

  _reloadMs(slot) {
    const m = this.viewer.unitMeta
    if (!m || !m.weapons) return 1500
    const idx = { primary: 0, secondary: 1, tertiary: 2 }[slot]
    const w = m.weapons[idx]
    if (!w || !w.reloadSec) return 1500
    return Math.max(100, w.reloadSec * 1000)
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

function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1) }
