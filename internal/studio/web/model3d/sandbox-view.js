// sandbox-view.js
//
// Multi-unit Sandbox viewer.  Sets up:
//
//   - A shared WebGL context + ModelRenderer (entity-mode)
//   - An OrbitCamera framed on the spawn ring
//   - A SandboxScene that owns N CobUnit + CobBinding pairs
//   - Spawn / select / command UI hooks
//
// Built as a sibling to ModelViewer rather than a subclass — the two
// share the renderer + loader + palette but differ in everything
// else (single vs multi unit, free camera vs scene camera, click-
// gestures, etc.).  Keeping them separate avoids twisting either
// class out of shape.

import { ModelLoader } from './model-loader.js'
import { ModelRenderer } from './model-renderer.js'
import { OrbitCamera } from './orbit-camera.js'
import { TextureCache } from './texture-cache.js'
import { TAPalette } from './palette.js'
import { SandboxScene } from './sandbox-scene.js'
import { attachOrbitControls } from './camera-controls.js'
import { ArmedCursor } from './armed-cursor.js'
import { spawnProjectile, SmokeTrailManager, SFX_FIRE_FLASH } from './weapon-driver.js'
import { shouldForceTarget } from './force-target.js'
import { teamColorForSide } from './team-colors.js'

export class SandboxView {
  constructor({ canvas, statusEl, onModelLoaded } = {}) {
    // Per-tab canvas — caller (studio.js activateSandboxTab) creates
    // a fresh <canvas> element for each tab and passes it in here.
    // The canvas is appended into a host stage by attach() and pulled
    // out by detach(), so an inactive tab's GL context lives on but
    // its surface is no longer in the DOM tree (no draw-through, no
    // bleed into the active tab's frame).  Falls back to creating
    // its own canvas if the caller didn't pass one — preserves the
    // single-canvas legacy path.
    this.canvas = canvas || (() => {
      const c = document.createElement('canvas')
      c.className = 'model-viewer-canvas'
      return c
    })()
    this.statusEl = statusEl
    this.onModelLoaded = onModelLoaded
    this.renderer = null
    this.camera = null
    this.palette = null
    this.loader = null
    this.scene = null
    this._resizeObserver = null
    // Pointer state for click vs drag-rect gesture distinction.
    // _pointerDownXY captures the screen position when the user
    // pressed mouse-down; if pointer-up lands within DRAG_THRESHOLD,
    // we treat it as a click; otherwise as a drag.
    this._pointerDownXY = null
    this._dragRect = null  // {x0, y0, x1, y1} during drag
    // Pending command — set by the user clicking Move / Attack
    // buttons; the next canvas click consumes it as the target.
    // Stays as 'move' or 'attack'; reset to null after the command.
    this._pendingCmd = null
    // Pending placement — set when the user picks a unit in the spawn
    // dialog.  Holds the loaded model + (optional) preloaded COB so
    // a mouse-driven ghost preview can follow the cursor on the
    // ground plane.  Click confirms the spawn at the current ghost
    // pos; Escape / right-click cancels.
    this._placement = null  // { name, model, cobScript, pos: {x, z} }
  }

  // attach mounts this tab's canvas into the given stage element.
  // Idempotent — if the canvas is already the only child it's a
  // no-op.  Called on tab activation; detach() pulls it back out
  // on the way to the next tab so the inactive viewer's canvas is
  // OUT of the DOM and can't bleed through.
  attach(stage) {
    if (!stage || !this.canvas) return
    if (this.canvas.parentNode === stage) return
    stage.appendChild(this.canvas)
  }

  detach() {
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas)
    }
  }

  async open() {
    this.#setStatus('Initialising sandbox…')
    if (!this.renderer) {
      const palette = await TAPalette.load()
      this.palette = palette
      const gl = this.canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false })
      if (!gl) {
        this.#setStatus('WebGL unavailable in this browser.')
        return
      }
      const textureCache = new TextureCache(gl)
      this.loader = new ModelLoader({ gl, palette, textureCache })
      this.renderer = new ModelRenderer({ canvas: this.canvas, textureCache, gl })
      this.camera = new OrbitCamera({})
      this.renderer.setCamera(this.camera)
      this.#observeResize()
      await this.renderer.init()
      this.renderer.start()
      // Orbit / pan / zoom gestures come from the same shared module
      // the unit editor uses (camera-controls.js) so left-drag-orbit,
      // wheel-zoom, shift-pan, ctrl-pan, right-drag-pan all behave
      // identically across both views.  Returns a detach() closure
      // that dispose() invokes to release the canvas listeners.
      this._detachCamera = attachOrbitControls({
        canvas: this.canvas,
        renderer: this.renderer,
        camera: this.camera,
        dialogId: 'model-viewer-dialog',
        // onUserInteract fires when the user takes manual control —
        // pan, key-scroll, T-key.  Use it to drop unit-tracking (the
        // user is driving the camera by hand; chasing the unit would
        // fight the gesture) and the Tracking checkbox readout.
        onUserInteract: (kind) => {
          if (kind === 'pan' && this.camera && this.camera.trackedTarget) {
            this.setTracking(false)
          }
        },
        // Sandbox claims plain left-drag for placement-drag only —
        // every other case falls through to camera-controls so plain
        // left-drag orbits exactly like the unit editor.  Drag-rect
        // selection is left out for now: it competes with the orbit
        // gesture users explicitly asked for, and click-to-select +
        // shift-click-add are enough for the multi-unit cases the
        // sandbox needs.  _pendingCmd / _placement claim falls through
        // first because those have higher priority than camera moves.
        //
        // Holding ALT on left-drag claims the gesture for rectangle
        // selection — a modifier-gated escape hatch for the power-user
        // workflow without re-stealing the default orbit gesture.
        onLeftDragStart: (e) => {
          if (this._pendingCmd) return false
          if (this._placement) return this.#beginPlacementDrag(e)
          if (e.altKey) return this.#beginDragSelect(e)
          return false
        },
      })
      // Armed cursor (Move / Attack glyph) uses the shared ArmedCursor
      // helper — same animated TA cursor PNGs the unit editor shows
      // when the user clicks Move / Primary / etc, so both views feel
      // like the same product.
      this._armedCursor = new ArmedCursor({
        canvas: this.canvas,
        host: document.getElementById('model-viewer-dialog') || document.body,
      })
    }
    if (!this.scene) {
      this.scene = new SandboxScene({ palette: this.palette })
      // Push the active world's gravity into the engine so the
      // ballistic aim solver agrees with the projectile flight sim.
      // Renderer environments differ (Lunar = lighter, default = 80
      // wu/s²); without the sync, cannon turrets would aim for one
      // gravity while shells fly under another and miss.
      if (typeof this.renderer.getGravity === 'function') {
        this.scene.engine.setGravity(this.renderer.getGravity())
      }
      // Hand the renderer to the engine for cross-unit dynamic light
      // aggregation — every tick the engine picks the globally
      // strongest light-emitting particle (across all units) and
      // pushes it to the renderer's pulse-light slot.  Without this
      // a Commander's laser firing in the Sandbox produced no
      // illumination on nearby units; the Viewer path got the light
      // for free because binding.tick handles it for the single unit.
      this.scene.engine.setRenderer(this.renderer)
      // Active missile smoke-trail emitter.  spawnProjectile schedules
      // a trail whenever it spawns a missile-kind projectile and we
      // pass this manager in; the per-frame onAfterFrame tick advances
      // it.  Shared SmokeTrailManager class (weapon-driver.js) so the
      // single-unit Viewer and the multi-unit Sandbox use one impl.
      this._smokeTrails = new SmokeTrailManager()
      // Wire the rendering side of the game engine.  The engine is
      // headless — it emits 'fire' / 'death' / etc. and we translate
      // those into particles + sounds.  Subscriptions return
      // unsubscribe closures; we hold them so dispose() can cleanly
      // detach (no stale handlers calling into a freed view).
      this._engineSubs = []
      const eng = this.scene.engine
      this._engineSubs.push(eng.on('fire', (ev) => {
        // Spawn the visible projectile through the shared weapon
        // driver.  Passing the SmokeTrailManager lets spawnProjectile
        // register a missile trail inline when the chosen visual
        // kind is SFX_PROJECTILE_MISSILE — saves us duplicating the
        // missile-vs-bullet classification here.  No-ops cleanly when
        // the unit has no FBI weapon meta.
        if (!ev.weapon || !ev.weapon.name) return
        const gravity = (typeof this.renderer.getGravity === 'function')
          ? this.renderer.getGravity() : 80
        try {
          spawnProjectile({
            binding: ev.unit.binding,
            weapon: ev.weapon,
            anchor: ev.anchor,
            target: ev.target,
            palette: this.palette,
            gravity,
            smokeTrails: this._smokeTrails,
          })
        } catch { /* ignore */ }
      }))
      this._engineSubs.push(eng.on('death', (ev) => {
        // Death puff so the kill reads visually.  Engine has already
        // marked the unit dead + cleared its orders.
        const b = ev.unit && ev.unit.binding
        if (!b || !b.particles) return
        b.particles.emit(SFX_FIRE_FLASH, ev.anchor, {
          size: 32, lifeMs: 600, color: [1.6, 0.6, 0.2, 1.0],
        })
      }))
    }
    // Sandbox uses the FLAT TA-tile grid as its ground — the textured
    // terrain mode that ModelRenderer defaults to has rolling hills,
    // which leaves spawned units floating above wherever the bumpy
    // surface dips below y=0.  Flat ground matches the "blank
    // battlefield" the sandbox advertises.
    if (typeof this.renderer.setGroundMode === 'function') {
      this.renderer.setGroundMode('grid')
    }
    // Sandbox is a strategic top-down view — auto-rotate makes the
    // ground spin away under the units and prevents the user from
    // building any spatial intuition about where they spawned things.
    // Off by default; user can re-enable from the unit-editor menu
    // if they want a tour shot.
    if (typeof this.renderer.setAutoRotate === 'function') {
      this.renderer.setAutoRotate(false)
    } else {
      this.renderer.autoRotate = false
    }
    // Empty-scene framing — camera looks at a generous patch of
    // ground so spawned units have room around the origin.  Tighter
    // initial distance than the prior 950 wu sweep so the grid
    // pattern is legible from the first frame.
    this.camera.target = [0, 0, 0]
    this.camera.distance = 220
    this.camera.yaw = 215 * Math.PI / 180
    this.camera.pitch = 45 * Math.PI / 180
    // Drop the entities array onto the renderer so the entity-mode
    // path engages even before the first spawn (empty array → falls
    // back to single-unit path with this.model = null, which paints
    // sky + ground only — exactly the "open flat map" view we want).
    this.#refreshEntities()
    // Hook the renderer's per-frame callback to advance the scene
    // tick + refresh the entities array each frame so any movement /
    // animation applied per-tick is visible immediately.
    this.renderer.onAfterFrame = (dtMs) => {
      if (this.scene) this.scene.tick(dtMs)
      // Advance any in-flight missile smoke trails — scaled by
      // playback rate so slow-mo doesn't bunch puffs at the slowed
      // projectile's position.  Shared SmokeTrailManager owns the
      // emit cadence + position re-derivation.
      // Trail cadence + position math run on sim-time, so they must
      // mirror the engine's particle gate: scale by playbackRate, AND
      // freeze (rate = 0) when the runtime is paused — otherwise
      // smoke puffs keep streaming out of frozen projectiles.
      const rt = this.scene && this.scene.runtime
      const rate = rt ? (rt.paused ? 0 : (rt.playbackRate || 1)) : 1
      this._smokeTrails.tick(dtMs * rate)
      this.#refreshEntities()
      // Re-position the shift-preview overlays every frame so they
      // track moving units + animated paths.  Cheap when the preview
      // isn't active (early-out inside).
      this.#refreshShiftPreview()
    }
    this.#wirePointer()
    this.#refreshDefaultCursor()
    this.#setStatus('Sandbox ready — click "Spawn Unit" to add a unit to the field.')
    if (this.onModelLoaded) this.onModelLoaded(null, null)
  }

  // spawn loads geometry + COB for `name` and adds a unit instance to
  // the scene at (x, z).  Returns the new UnitInstance (or null on
  // failure).  Loader caches by name so repeated spawns of the same
  // unit reuse the parsed model + uploaded textures.
  async spawn(name, { x = 0, z = 0, headingRad = 0, side = 0 } = {}) {
    if (!this.loader || !this.scene) return null
    try {
      const model = await this.loader.load(name)
      let cobScript = null
      try {
        const r = await fetch(`/api/studio/cob/${encodeURIComponent(name)}?decompile=0`)
        if (r.ok) {
          const j = await r.json()
          cobScript = j
        }
      } catch { /* unit has no COB — fine, it'll just stand */ }
      const inst = this.scene.addUnit({ name, model, cobScript, x, z, headingRad, side })
      // Auto-run Create on spawn so the unit immediately settles into
      // its idle pose (flares hidden, panels at rest) without the user
      // having to click anything per-unit.  Skipped silently when the
      // unit has no Create script.
      if (inst.cobUnit && inst.cobUnit.scriptNames && inst.cobUnit.scriptNames.includes('Create')) {
        try { inst.cobUnit.start('Create') } catch { /* ignore */ }
      }
      // Fetch FBI / weapon metadata in the background.  The shared
      // weapon driver needs weapons[0..2] to spawn proper TA
      // projectiles (laser beams, missiles, shells) — without this
      // sandbox firing falls back to a bare muzzle flash + hit-scan.
      // Fetch is fire-and-forget; if it 404s the unit just stays in
      // its no-weapons state without breaking anything.
      this.#fetchUnitMeta(inst).catch(() => { /* ignore */ })
      this.#refreshEntities()
      this.#setStatus(`Spawned ${name} at (${x.toFixed(0)}, ${z.toFixed(0)}) — ${this.scene.unitCount()} unit${this.scene.unitCount() === 1 ? '' : 's'} on field.`)
      return inst
    } catch (err) {
      this.#setStatus(`Spawn failed: ${err.message || err}`)
      return null
    }
  }

  // #fetchUnitMeta loads FBI + weapon-TDF data for a freshly spawned
  // unit and stows it on `inst.meta`.  The shared weapon driver reads
  // this to pick projectile kind / ballistic flag / velocity / range /
  // sound.  Same backend endpoint the unit editor's mvFetchUnitMeta
  // uses so both views see identical data.
  async #fetchUnitMeta(inst) {
    if (!inst || !inst.name) return
    try {
      const resp = await fetch(`/api/studio/unit/${encodeURIComponent(inst.name)}`)
      if (!resp.ok) return
      inst.meta = await resp.json()
    } catch { /* ignore */ }
  }

  // beginPlacement loads the unit's geometry + COB up front (so the
  // ghost preview snaps in without a network round-trip on every
  // mouse move) and enters placement mode.  The next canvas click on
  // the ground plane commits the spawn at the cursor; Escape or
  // right-click cancels.  Calling this with a unit that's already
  // pending placement is a no-op.
  async beginPlacement(name, { side = 0 } = {}) {
    if (!this.loader || !this.scene) return false
    if (this._placement && this._placement.name === name && this._placement.side === side) return true
    this.#setStatus(`Loading ${name}…`)
    try {
      const model = await this.loader.load(name)
      let cobScript = null
      try {
        const r = await fetch(`/api/studio/cob/${encodeURIComponent(name)}?decompile=0`)
        if (r.ok) cobScript = await r.json()
      } catch { /* no COB — the spawn still works, the unit just won't animate */ }
      // Initial position — drop the ghost on whatever the camera is
      // currently looking at so it's immediately visible.  Mouse-move
      // takes over from the first event onwards.
      const tx = (this.camera && this.camera.target) ? this.camera.target[0] : 0
      const tz = (this.camera && this.camera.target) ? this.camera.target[2] : 0
      this._placement = { name, model, cobScript, side: (side | 0), pos: { x: tx, z: tz } }
      this.#refreshEntities()
      this.#setStatus(`Placing ${name} — click to confirm, Esc to cancel.`)
      return true
    } catch (err) {
      this.#setStatus(`Load failed: ${err.message || err}`)
      return false
    }
  }

  // cancelPlacement drops the ghost without spawning.
  cancelPlacement() {
    if (!this._placement) return
    this._placement = null
    this.#refreshEntities()
    this.#refreshDefaultCursor()
    this.#setStatus('Placement cancelled.')
  }

  // setSilenced silences this view's audio — called from switchToTab
  // on the outgoing tab so backgrounded sandboxes go quiet without
  // freezing their sim.  The engine's runtime + weapon SMs keep
  // ticking so units continue to walk, fire, and die; only the audio
  // pool is paused.
  setSilenced(s) {
    if (this.scene && typeof this.scene.setSilenced === 'function') {
      this.scene.setSilenced(!!s)
    }
  }

  // #beginPlacementDrag handles the click-then-drag flow for unit
  // spawn placement.  Pointer-down locks the ghost position; drag
  // updates the heading the unit will spawn facing; pointer-up
  // commits the spawn.  Single-shot by default — placement clears
  // after the commit so the user doesn't accidentally drop more
  // units on subsequent clicks.  Holding Shift on release keeps the
  // placement mode active (chain-spawn for the same unit type).
  //
  // Pure-click (no drag) is treated as a zero-vector drag: spawn at
  // the down-point with default heading.
  #beginPlacementDrag(e) {
    if (!this._placement) return false
    const canvas = this.canvas
    const rect = canvas.getBoundingClientRect()
    const sxStart = e.clientX - rect.left
    const syStart = e.clientY - rect.top
    const startWorld = this.#screenToGround(sxStart, syStart)
    if (!startWorld) return false
    // Freeze the ghost position at the down-point — the mousemove
    // handler reads _placementDrag and skips its usual "ghost follows
    // cursor" path so the user sees the ghost rotate, not slide.
    this._placement.pos.x = startWorld[0]
    this._placement.pos.z = startWorld[2]
    this._placementDrag = { startWorld, headingRad: 0 }
    try { canvas.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    const onMove = (ev) => {
      const cur = this.#screenToGround(ev.clientX - rect.left, ev.clientY - rect.top)
      if (!cur) return
      const dx = cur[0] - startWorld[0]
      const dz = cur[2] - startWorld[2]
      // Below a small threshold (~3 wu) keep the previous heading —
      // jittery sub-wu motion shouldn't flip the ghost orientation.
      if (dx * dx + dz * dz < 9) return
      this._placementDrag.headingRad = Math.atan2(dx, dz)
      this.#refreshEntities()
    }
    const onUp = (ev) => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      try { canvas.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      const drag = this._placementDrag
      this._placementDrag = null
      // Commit the spawn — pointer-down position, drag-derived heading.
      const p = this._placement
      const inst = this.scene.addUnit({
        name: p.name,
        model: p.model,
        cobScript: p.cobScript,
        x: startWorld[0],
        z: startWorld[2],
        headingRad: drag ? drag.headingRad : 0,
        side: p.side | 0,
      })
      if (inst) {
        this.#fetchUnitMeta(inst).catch(() => { /* ignore */ })
        if (inst.cobUnit && inst.cobUnit.scriptNames && inst.cobUnit.scriptNames.includes('Create')) {
          try { inst.cobUnit.start('Create') } catch { /* ignore */ }
        }
        this.#setStatus(`Spawned ${p.name} at (${startWorld[0].toFixed(0)}, ${startWorld[2].toFixed(0)}) — ${this.scene.unitCount()} unit${this.scene.unitCount() === 1 ? '' : 's'} on field.`)
      }
      // Single-shot placement unless Shift held — TA convention is
      // one spawn per Build click; chain-spawn (shift) is the power-
      // user shortcut for dropping multiple of the same unit fast.
      if (!ev.shiftKey) {
        this._placement = null
      }
      // Suppress the trailing click event so #onClick doesn't fire a
      // second commit (or worse, a selection click) right after up.
      this._suppressNextClick = true
      this.#refreshEntities()
      this.#refreshDefaultCursor()
    }
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    return true
  }

  // #beginDragSelect starts a rectangle-selection gesture.  Called
  // from the camera-controls onLeftDragStart hook when the user
  // presses left mouse with no modifier and no command armed.
  // Returns true to claim the gesture (camera-controls skips orbit
  // for this drag); false declines.
  //
  // The actual rectangle starts INVISIBLE — we only commit to the
  // marquee on the FIRST move past a small threshold, so a plain
  // click-to-select still fires through the normal click handler
  // when the user releases without moving.  Hit-test runs on
  // pointer-up against every unit's screen-space projection inside
  // the rect; matches selectAdd into the scene.
  #beginDragSelect(e) {
    if (!this.scene) return false
    const canvas = this.canvas
    const rect = canvas.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const state = {
      startX, startY,
      x: startX, y: startY,
      moved: false,
      el: null,
      canvasRect: rect,
    }
    try { canvas.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    const onMove = (ev) => {
      state.x = ev.clientX
      state.y = ev.clientY
      const dx = state.x - state.startX
      const dy = state.y - state.startY
      // Threshold so a regular click-release doesn't draw a marquee
      // for a single frame.  6 px matches the studio's other drag-
      // vs-click discriminator (placement / hover).
      if (!state.moved && (dx * dx + dy * dy) > 36) {
        state.moved = true
        state.el = this.#createDragRectElement()
      }
      if (state.el) this.#updateDragRectElement(state)
    }
    const onUp = (ev) => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      try { canvas.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      // Tear down the rect element and run hit-test only when an
      // actual drag took place.  Pure-click (no movement) falls
      // through to the normal click handler which fires after up.
      if (state.el) {
        state.el.remove()
        // Suppress the trailing 'click' event so the empty-ground
        // click handler doesn't run AFTER our drag-select committed
        // — otherwise pure-empty drags would clear the selection we
        // just made.  Flag is consumed on the next click.
        this._suppressNextClick = true
        this.#applyDragRectSelection(state.startX, state.startY, state.x, state.y)
      }
    }
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    return true
  }

  // #createDragRectElement lazy-builds the marquee div.  Inline style
  // so we don't depend on a CSS rule in studio.css — keeps the
  // sandbox feature self-contained.  Animated dashes come from a
  // background-position CSS animation; the dash pattern is layered
  // as four 1-pixel borders made of repeating linear gradients so
  // the four edges of the rectangle can animate independently.
  #createDragRectElement() {
    const el = document.createElement('div')
    el.className = 'sandbox-drag-rect'
    el.style.cssText = [
      'position: fixed',
      'pointer-events: none',
      'z-index: 9999',
      'border: 1px dashed rgba(140, 220, 255, 0.95)',
      'background: rgba(140, 220, 255, 0.10)',
      'box-shadow: 0 0 6px rgba(140, 220, 255, 0.35)',
      // Background-position animation drives the marching-ants
      // effect via a linear-gradient stripe.  The dashed border
      // itself doesn't animate in CSS, so we layer a stroked
      // pseudo-pattern over it via background-size + animation.
      'animation: sandboxDragRectMarch 0.6s linear infinite',
      'left: 0',
      'top: 0',
      'width: 0',
      'height: 0',
    ].join('; ')
    // Inject the @keyframes once.  Idempotent — checking by id keeps
    // re-mounts cheap.
    if (!document.getElementById('sandbox-drag-rect-css')) {
      const style = document.createElement('style')
      style.id = 'sandbox-drag-rect-css'
      style.textContent = `
        @keyframes sandboxDragRectMarch {
          from { background-position: 0 0, 8px 0, 0 0, 0 8px; }
          to   { background-position: 16px 0, -8px 0, 0 16px, 0 -8px; }
        }
        .sandbox-drag-rect {
          background-image:
            repeating-linear-gradient(90deg, rgba(140,220,255,0.95) 0 4px, transparent 4px 8px),
            repeating-linear-gradient(90deg, transparent 0 8px, rgba(140,220,255,0.95) 8px 12px),
            repeating-linear-gradient(0deg, rgba(140,220,255,0.95) 0 4px, transparent 4px 8px),
            repeating-linear-gradient(0deg, transparent 0 8px, rgba(140,220,255,0.95) 8px 12px);
          background-size: 16px 1px, 16px 1px, 1px 16px, 1px 16px;
          background-position: 0 0, 0 100%, 0 0, 100% 0;
          background-repeat: repeat-x, repeat-x, repeat-y, repeat-y;
          border: 1px solid transparent !important;
        }
      `
      document.head.appendChild(style)
    }
    document.body.appendChild(el)
    return el
  }

  // #updateDragRectElement positions the marquee from the drag state
  // (start + current).  Uses viewport coords so the element can sit
  // outside the canvas and clamp visually.
  #updateDragRectElement(state) {
    const x = Math.min(state.startX, state.x)
    const y = Math.min(state.startY, state.y)
    const w = Math.abs(state.x - state.startX)
    const h = Math.abs(state.y - state.startY)
    const s = state.el.style
    s.left = x + 'px'
    s.top = y + 'px'
    s.width = w + 'px'
    s.height = h + 'px'
  }

  // #applyDragRectSelection hit-tests every unit's screen-space
  // centroid against the rectangle (viewport coords) and selects
  // every match.  Replaces the previous selection (TA RTS feel) —
  // hold Shift on release to ADD to selection instead (Modifier
  // check happens at the start of the gesture; we mirror it by
  // peeking at the global last-shift state if available, else just
  // replace).
  #applyDragRectSelection(x0, y0, x1, y1) {
    const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) }
    const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) }
    if (!this.scene) return
    // Replace selection by default — TA convention.  (No shift-add
    // wiring yet; the gesture grabs pointer events directly via
    // capture so e.shiftKey isn't easily threaded here.  Punt to
    // a follow-up if needed.)
    this.scene.selectClear()
    let n = 0
    for (const u of this.scene.units()) {
      if (u.dead) continue
      const screen = this.#worldToScreen(u.pos.x, u.pos.y + 12, u.pos.z)
      if (!screen) continue
      const rect = this.canvas.getBoundingClientRect()
      const vx = screen[0] + rect.left
      const vy = screen[1] + rect.top
      if (vx >= lo.x && vx <= hi.x && vy >= lo.y && vy <= hi.y) {
        this.scene.selectAdd(u.id)
        n++
      }
    }
    if (n > 0) this.#setStatus(`Selected ${n} unit${n === 1 ? '' : 's'}.`)
    else this.#setStatus('Selection cleared.')
  }

  // #refreshShiftPreview shows / hides the destination + attack-target
  // overlay for every selected unit while Shift is held.  Move targets
  // get the TA move cursor PNG; attack targets get the attack cursor.
  // A flowing trail of arrow icons interpolates between each unit's
  // current world position and its move target — animation comes
  // from a per-frame phase offset so the icons appear to scroll
  // toward the destination.
  //
  // Lazily-builds a host container in document.body to hold the
  // overlay elements; hides the host when the preview is inactive
  // so we don't pay a per-frame layout cost off-Shift.
  #refreshShiftPreview() {
    if (!this._shiftPreviewHost) {
      const host = document.createElement('div')
      host.id = 'sandbox-shift-preview'
      host.style.cssText = 'position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 9998;'
      document.body.appendChild(host)
      this._shiftPreviewHost = host
      this._shiftPreviewEls = []  // pool of {kind, el} for reuse
    }
    const host = this._shiftPreviewHost
    if (!this._shiftPreview || !this.scene) {
      host.style.display = 'none'
      return
    }
    host.style.display = ''
    // Phase 0..1 — drives the flowing trail.  6 s period reads as
    // "slow flow toward target" without distracting from the actual
    // sim.  performance.now() keeps the animation independent of the
    // sim's pause / playback rate.
    const phase = (performance.now() % 6000) / 6000
    // Build / refresh per selected unit.  For each unit:
    //   - One marker at the move OR attack target (whichever is set)
    //   - 6 trail icons evenly spaced from unit pos → move target
    let elIdx = 0
    const pool = this._shiftPreviewEls
    const ensureEl = (kind, badge = null) => {
      let entry
      if (elIdx < pool.length) {
        entry = pool[elIdx]
        if (entry.kind !== kind) {
          // Re-skin the existing element — cheaper than re-creating.
          entry.el.style.backgroundImage = `url('/api/studio/cursor/${kind}')`
          entry.kind = kind
        }
        entry.el.style.display = ''
      } else {
        const el = document.createElement('div')
        el.style.cssText = [
          'position: fixed',
          'width: 32px', 'height: 32px',
          'margin-left: -16px', 'margin-top: -16px',
          'background-size: contain',
          'background-repeat: no-repeat',
          'pointer-events: none',
          'image-rendering: pixelated',
          `background-image: url('/api/studio/cursor/${kind}')`,
        ].join('; ')
        host.appendChild(el)
        entry = { kind, el, badge: null }
        pool.push(entry)
      }
      // Slot badge — a small "2" / "3" lozenge in the bottom-right
      // corner of the icon so the user can tell Primary vs Secondary
      // vs Tertiary attack targets at a glance.  Lazily created the
      // first time a glyph wants one; toggled on/off per frame so
      // re-used pool entries don't keep a stale digit visible.
      if (badge) {
        if (!entry.badge) {
          const b = document.createElement('div')
          b.style.cssText = [
            'position: absolute',
            'right: -4px',
            'bottom: -4px',
            'min-width: 14px',
            'height: 14px',
            'padding: 0 3px',
            'box-sizing: border-box',
            'background: rgba(20, 20, 20, 0.85)',
            'color: #fff',
            'font: bold 10px/14px ui-sans-serif, system-ui, sans-serif',
            'text-align: center',
            'border: 1px solid rgba(255, 255, 255, 0.6)',
            'border-radius: 7px',
            'pointer-events: none',
          ].join('; ')
          entry.el.style.position = 'fixed' // keep the host positioning model
          entry.el.appendChild(b)
          entry.badge = b
        }
        entry.badge.textContent = badge
        entry.badge.style.display = ''
      } else if (entry.badge) {
        entry.badge.style.display = 'none'
      }
      elIdx++
      return entry.el
    }
    const canvasRect = this.canvas.getBoundingClientRect()
    const projW = (x, y, z) => {
      const screen = this.#worldToScreen(x, y, z)
      if (!screen) return null
      return [screen[0] + canvasRect.left, screen[1] + canvasRect.top]
    }
    // Helper — pull a target position from a weapon slot's stored
    // record.  Returns null when the slot isn't engaged or the unit
    // target died.  Mirrors the engine's #resolveTarget shape but is
    // safe to call on the snapshot side without engine plumbing.
    const slotPos = (slotState) => {
      const t = slotState && slotState.target
      if (!t) return null
      if (t.type === 'unit') {
        const u = t.unit
        if (!u || u.dead) return null
        return [u.pos.x, u.pos.y + 12, u.pos.z]
      }
      if (t.type === 'point' && t.point) {
        return [t.point[0], (t.point[1] || 0) + 4, t.point[2]]
      }
      return null
    }
    const SLOT_BADGE = [null, '2', '3']
    for (const id of this.scene.selected) {
      const u = this.scene.unitById(id)
      if (!u || u.dead) continue
      // Move marker + trail — flow of cursormove glyphs from the
      // unit's current pos to its destination.  Drawn first so the
      // attack markers (which sit on top in z-order via DOM order)
      // overlap cleanly.  Reset opacity / size each frame because
      // the pool entries are reused across kinds.
      const resetGlyph = (el) => {
        el.style.opacity = '1'
        el.style.width = '32px'
        el.style.height = '32px'
        el.style.marginLeft = '-16px'
        el.style.marginTop = '-16px'
      }
      if (u.moveTarget) {
        const tx = u.moveTarget.x
        const tz = u.moveTarget.z
        const targetScreen = projW(tx, 0, tz)
        if (targetScreen) {
          const marker = ensureEl('cursormove')
          resetGlyph(marker)
          marker.style.left = targetScreen[0] + 'px'
          marker.style.top  = targetScreen[1] + 'px'
          const TRAIL_N = 6
          const fromX = u.pos.x, fromZ = u.pos.z
          const dx = tx - fromX, dz = tz - fromZ
          const dist = Math.hypot(dx, dz)
          // Don't render trail dots for very short paths (less than
          // ~one marker spacing) — they'd overlap the destination glyph.
          if (dist > 30) {
            for (let i = 0; i < TRAIL_N; i++) {
              const t = ((i + phase) % TRAIL_N) / TRAIL_N
              if (t > 0.92) continue
              const px = fromX + dx * t
              const pz = fromZ + dz * t
              const ps = projW(px, 0, pz)
              if (!ps) continue
              const dot = ensureEl('cursormove')
              dot.style.left = ps[0] + 'px'
              dot.style.top  = ps[1] + 'px'
              dot.style.opacity = String(0.25 + 0.55 * t)
              dot.style.width = '20px'
              dot.style.height = '20px'
              dot.style.marginLeft = '-10px'
              dot.style.marginTop = '-10px'
            }
          }
        }
      }
      // Attack markers — one per active weapon slot.  Sources:
      //   1. u.attackTarget    → autonomous attack pursuit (slot 0)
      //   2. weaponSlots[N]    → engine SM's current aim point per
      //                          slot — fires the moment aim+reload
      //                          align.  Includes both manual fire
      //                          orders and the autonomous attack
      //                          loop's slot-0 fill.  Iterated last
      //                          so the badge denotes the WEAPON slot
      //                          driving each glyph.
      // Deduplicated by world position so attackTarget + slot 0
      // pointing at the same enemy doesn't render two glyphs on top
      // of each other.
      const drawn = []
      const drawAttack = (pos, badge) => {
        // Dedupe: skip if any prior glyph for THIS unit is at the
        // same world XZ (within 1 wu).  Avoids stacking attackTarget
        // and slot0 glyphs when they point at the same enemy.
        for (const d of drawn) {
          if (Math.abs(d[0] - pos[0]) < 1 && Math.abs(d[2] - pos[2]) < 1) return
        }
        const ps = projW(pos[0], pos[1], pos[2])
        if (!ps) return
        drawn.push(pos)
        const el = ensureEl('cursorattack', badge)
        resetGlyph(el)
        el.style.left = ps[0] + 'px'
        el.style.top  = ps[1] + 'px'
      }
      if (u.attackTarget && !u.attackTarget.dead) {
        // Autonomous attack — primary by convention.
        drawAttack([u.attackTarget.pos.x, u.attackTarget.pos.y + 12, u.attackTarget.pos.z], null)
      }
      if (u.weaponSlots) {
        for (let slot = 0; slot < 3; slot++) {
          const pos = slotPos(u.weaponSlots[slot])
          if (!pos) continue
          drawAttack(pos, SLOT_BADGE[slot])
        }
      }
    }
    // Hide unused pool entries (e.g. selection shrank since last
    // frame — leftover elements would otherwise sit on screen).
    for (let i = elIdx; i < pool.length; i++) {
      pool[i].el.style.display = 'none'
    }
  }

  // #refreshDefaultCursor routes the ambient-cursor decision through
  // the shared ArmedCursor overlay so the user sees the TA animated
  // glyph (cursornormal idle, cursorselect when hovering a unit)
  // instead of a static-first-frame CSS cursor: url(...) which most
  // browsers refuse to animate.  Armed slot (move / attack / fire)
  // takes priority over the ambient slot — set via setArmed inside
  // setPendingCommand.  When placement is active the placement
  // ghost is the visual cursor; we suppress both ambient + armed
  // overlays via setAmbient(null) + setArmed(null).
  #refreshDefaultCursor() {
    if (!this.canvas) return
    if (!this._armedCursor) {
      this.canvas.style.cursor = 'none'
      return
    }
    if (this._placement) {
      // Placement ghost handles the "what am I about to drop"
      // affordance — keep the overlay quiet so it doesn't fight.
      this._armedCursor.setAmbient(null)
      this._armedCursor.setArmed(null)
      return
    }
    // Ambient = select-on-unit-hover OR normal-when-empty.  _lastHoverUnitId
    // is maintained by #onMouseMove — pick the matching glyph here so
    // both the keyboard-driven path (setPendingCommand release) and
    // the mouse-driven hover loop converge on the same state.
    const ambient = this._lastHoverUnitId ? 'select' : 'normal'
    this._armedCursor.setAmbient(ambient)
    this._armedCursor.setArmed(this._pendingCmd)
  }

  // setPendingCommand — called by the controls UI when the user
  // clicks Move / Attack / Primary / Secondary / Tertiary.  Next
  // canvas click consumes it.  Drives the shared ArmedCursor
  // overlay so the cursor visually matches what the unit editor
  // shows for the same gesture.  Passing null disarms.
  //
  // Accepted slots:
  //   'move'                    — next click sets move target
  //   'attack'                  — generic primary-weapon attack
  //   'primary' / 'secondary' / 'tertiary'
  //                             — fire the named weapon slot at the
  //                               next click target (matches the
  //                               unit-editor's Controls panel
  //                               arm-then-target semantics).
  setPendingCommand(cmd) {
    const valid = (cmd === 'move' || cmd === 'attack' ||
                   cmd === 'primary' || cmd === 'secondary' || cmd === 'tertiary')
    this._pendingCmd = valid ? cmd : null
    // #refreshDefaultCursor drives the ArmedCursor overlay's
    // armed+ambient slot pair — armed wins over ambient so the cmd
    // glyph trumps the idle "select" / "normal" hover state without
    // needing a separate code path here.
    this.#refreshDefaultCursor()
    if (this._pendingCmd) {
      const what = (cmd === 'move') ? 'a destination' : 'a target unit'
      const label = cmd[0].toUpperCase() + cmd.slice(1)
      this.#setStatus(`${label} — click ${what}.`)
    }
  }

  // ── Internals ──────────────────────────────────────────────────

  // #refreshEntities builds the entity array the renderer iterates
  // each frame.  Cheap: just an array of refs into scene units, run
  // every frame so adds / removes show up immediately.
  #refreshEntities() {
    if (!this.renderer || !this.scene) return
    const entities = []
    for (const u of this.scene.units()) {
      if (!u.model) continue
      // Auto-lift by -bounds.min[1] so the unit's bottom-most
      // vertex sits flush with the ground plane (y = 0).  Different
      // units use different model-origin conventions — some have it
      // at the feet (min.y ≈ 0), some at the centre of mass (min.y
      // negative).  Without this lift, units with a non-zero min.y
      // float above (or sink into) the flat ground.
      const lift = u.model.bounds ? -u.model.bounds.min[1] : 0
      // Heading offset by +π — mirrors the single-unit viewer's
      // _applyRendererTransform convention (mv-controls.js:792).
      // The model loader X-flips every vertex (so right-handed GL
      // matches TA's left-handed authoring), which has the side
      // effect of pointing the unit's "front" at the OPPOSITE of
      // its logical heading.  +π compensates so the unit faces the
      // direction it walks.  Without this fix, units appear to
      // moonwalk backwards toward their move target.
      // Per-unit team colour from the unit's side field — engine owns
      // the side index, team-colors.js maps it to the renderer's
      // [r,g,b] tuple (or null for side 0, the "no recolour" sentinel
      // that keeps the model's authored ARM blue).
      entities.push({
        model: u.model,
        binding: u.binding,
        buildPercent: u.buildPercent,
        transform: { x: u.pos.x, y: u.pos.y + lift, z: u.pos.z, headingRad: u.heading + Math.PI },
        selected: this.scene.isSelected(u.id),
        teamColor: teamColorForSide(u.side),
      })
    }
    // Placement ghost — appended LAST so it draws over the live units
    // (renderer iterates entities in order).  The renderer checks
    // ent.ghost and emits a translucent green wireframe instead of a
    // solid main pass.
    if (this._placement && this._placement.model) {
      const p = this._placement
      const lift = p.model.bounds ? -p.model.bounds.min[1] : 0
      // Ghost heading — defaults to π (the renderer's +π offset
      // produces a unit facing +Z, the conventional "up" on the
      // overhead grid).  When the user click-drags during placement
      // we accumulate a heading override on _placementDrag; render
      // the ghost with that direction so the user previews where the
      // unit will face on release.
      const headingRad = (this._placementDrag && Number.isFinite(this._placementDrag.headingRad))
        ? this._placementDrag.headingRad + Math.PI
        : Math.PI
      entities.push({
        model: p.model,
        transform: { x: p.pos.x, y: lift, z: p.pos.z, headingRad },
        ghost: true,
      })
    }
    this.renderer.setEntities(entities)
  }

  #wirePointer() {
    if (this._pointerWired) return
    this._pointerWired = true
    const canvas = this.canvas
    canvas.addEventListener('click', (e) => this.#onClick(e))
    canvas.addEventListener('contextmenu', (e) => this.#onContextMenu(e))
    canvas.addEventListener('mousemove', (e) => this.#onMouseMove(e))
    // Esc cancels placement.  T toggles camera tracking of the first
    // selected unit (mirrors the unit-editor's T-key behaviour, but
    // resolves the target via the scene's selection set since there's
    // no single "viewed unit").  Bound on window because the canvas
    // doesn't take focus by default and Esc/T there feel more "global
    // shortcut" than per-element.
    // Shift toggle — show / hide the destination + path-trail overlay
    // even when the mouse isn't moving.  The mousemove handler also
    // sets _shiftPreview but only fires when the cursor moves.
    const updateShift = (down) => {
      if (!this.scene) return
      const want = down && this.scene.selected.size > 0
      if (want === this._shiftPreview) return
      this._shiftPreview = want
      this.#refreshShiftPreview()
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') updateShift(true)
    })
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') updateShift(false)
    })
    window.addEventListener('blur', () => updateShift(false))
    window.addEventListener('keydown', (e) => {
      const dlg = document.getElementById('model-viewer-dialog')
      const sandboxActive = dlg && dlg.classList.contains('sandbox-mode') && !dlg.classList.contains('hidden')
      if (!sandboxActive) return
      const tgt = e.target
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return
      if (tgt && tgt.isContentEditable) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'Escape') {
        e.preventDefault()
        // Cascade: placement → armed cmd → selection.  Each Escape
        // press peels off one level of "in progress" state so the
        // user can back out of a multi-step gesture without losing
        // their entire context in one keystroke.
        if (this._placement) {
          this.cancelPlacement()
        } else if (this._pendingCmd) {
          this.setPendingCommand(null)
          this.#setStatus('Cancelled.')
        } else if (this.scene && this.scene.selected.size > 0) {
          this.scene.selectClear()
          this.#setStatus('Selection cleared.')
        }
        return
      }
      const k = (e.key || '').toLowerCase()
      if (k === 't') {
        e.preventDefault()
        this.toggleTracking()
        return
      }
      // Order hotkeys — mirror the unit-editor mapping so muscle
      // memory carries across both views:
      //   M  arm Move          A  arm Primary attack
      //   F  arm Secondary     D  arm Tertiary (d-gun etc)
      //   S  Stop (clears every target slot + halts).
      // No-op when nothing is selected so a stray keystroke doesn't
      // arm a cursor that has nobody to dispatch to.  The unit editor
      // has its own copy of these — keeping the two in sync requires
      // editing both keymaps when adding new shortcuts.
      if (k === 'm' || k === 'a' || k === 'f' || k === 'd') {
        if (!this.scene || this.scene.selected.size === 0) return
        e.preventDefault()
        const cmd = (k === 'm') ? 'move'
                  : (k === 'a') ? 'primary'
                  : (k === 'f') ? 'secondary'
                  : /* k === 'd' */ 'tertiary'
        this.setPendingCommand(cmd)
        return
      }
      if (k === 's') {
        if (!this.scene || this.scene.selected.size === 0) return
        e.preventDefault()
        this.#stopSelected()
        return
      }
    })
  }

  // #stopSelected halts every selected unit completely — drops every
  // movement / attack target AND withdraws weapon slots from the
  // engine SM (otherwise the per-tick #stepWeapon keeps cycling
  // reloads at a phantom target).  Mirrors the Stop button + S
  // hotkey behaviour the unit editor uses.  Pulled out as a method
  // so the keymap above and the Controls grid handler in studio.js
  // can share one implementation if we wire it up later.
  #stopSelected() {
    if (!this.scene) return
    const engine = this.scene.engine
    for (const id of this.scene.selected) {
      const u = this.scene.unitById(id)
      if (!u) continue
      u.moveTarget = null
      u.attackTarget = null
      for (let slot = 0; slot < 3; slot++) {
        engine.setWeaponTarget(u.id, slot, null)
      }
      if (u.binding && u.binding.hasScript('StopMoving')) {
        try { u.binding.start('StopMoving') } catch { /* ignore */ }
      }
      if (u.binding && u.binding.hasScript('TargetCleared')) {
        try { u.binding.start('TargetCleared', [0]) } catch { /* ignore */ }
      }
    }
    if (this._pendingCmd) this.setPendingCommand(null)
    this.#setStatus(`Stopped ${this.scene.selected.size} unit(s).`)
  }

  // toggleTracking — T-key handler.  Flips the current state.
  toggleTracking() {
    this.setTracking(!this.camera?.trackedTarget)
  }

  // setTracking arms / disarms tracking explicitly.  Used by the
  // Renderer panel's Tracking checkbox so it can drive the state
  // directly (the T-key handler routes through here too via
  // toggleTracking).  When arming, picks the FIRST selected unit;
  // refuses (with a status hint) if nothing's selected so the
  // gesture always reads as deliberate.  When disarming, unsets the
  // camera's tracked target entirely.
  setTracking(on) {
    if (!this.camera) return
    if (!on) {
      this.camera.setTrackedTarget(null)
      this.#setStatus('Tracking off.')
      return
    }
    if (!this.scene || this.scene.selected.size === 0) {
      this.#setStatus('Tracking — select a unit first.')
      return
    }
    const firstId = [...this.scene.selected][0]
    const u = this.scene.unitById(firstId)
    if (!u) return
    this.camera.setTrackedTarget(u, u.name || `Unit ${u.id}`)
    this.#setStatus(`Tracking ${u.name || 'unit'}.`)
  }

  // #onMouseMove updates the ghost preview's position to follow the
  // cursor on the ground plane.  Cheap: just a screen-to-ground
  // unproject; the renderer re-builds the entity transforms each
  // frame anyway.
  #onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    // Placement-ghost track — while ONLY hovering (no pointer-down
    // drag in progress), the ghost follows the cursor on the ground
    // plane.  Once a click-drag starts (_placementDrag set in
    // #beginPlacementDrag), the ghost LOCKS to the pointer-down
    // position so the user sees it rotate-in-place to face the drag
    // direction.  Without this gate the mousemove handler kept
    // updating p.pos to wherever the cursor was, dragging the unit
    // around the field instead of just spinning it.
    if (this._placement) {
      if (!this._placementDrag) {
        const world = this.#screenToGround(sx, sy)
        if (world) {
          this._placement.pos.x = world[0]
          this._placement.pos.z = world[2]
          this.#refreshEntities()
        }
      }
      return
    }
    // Hover cursor — when the pointer is over a unit, the ambient
    // slot should flip to 'select' (cursorselect glyph).  Off a unit
    // it returns to 'normal'.  Cheap re-pick per move; the hover-id
    // diff suppresses redundant overlay swaps.  Routed through
    // #refreshDefaultCursor so the armed-vs-ambient priority is the
    // single point of decision.
    if (!this._pendingCmd) {
      const picked = this.#pickUnitAt(sx, sy)
      const hoverId = picked ? picked.id : 0
      if (hoverId !== this._lastHoverUnitId) {
        this._lastHoverUnitId = hoverId
        this.#refreshDefaultCursor()
      }
    }
    // Shift-preview — when the user holds Shift with units selected,
    // overlay each selected unit's move-destination + attack-target
    // glyphs at the projected world position.  Released → overlays
    // hide.  Cheap: just toggles a flag the per-frame refresh reads.
    this._shiftPreview = !!e.shiftKey && this.scene && this.scene.selected.size > 0
    this.#refreshShiftPreview()
  }

  // #onContextMenu — right-click.  In placement mode it cancels the
  // ghost.  Otherwise (selection present) it issues a Move / Attack
  // command directly without needing to click the toolbar button —
  // classic RTS gesture.
  #onContextMenu(e) {
    e.preventDefault()
    if (this._placement) {
      this.cancelPlacement()
      return
    }
    if (!this.scene || this.scene.selected.size === 0) return
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    // Hit-test for unit under cursor first.  If we hit a unit that's
    // NOT in the selection set, it's an attack target.  Otherwise we
    // fall through to a ground-move at the click location.
    const hit = this.#pickUnitAt(sx, sy)
    if (hit && !this.scene.selected.has(hit.id)) {
      let n = 0
      for (const id of this.scene.selected) {
        if (id === hit.id) continue
        const u = this.scene.unitById(id)
        if (u) { u.attackTarget = hit; n++ }
      }
      this.#setStatus(`Attack — ${n} unit(s) targeting ${hit.name} (HP ${hit.health}).`)
      return
    }
    const world = this.#screenToGround(sx, sy)
    if (!world) return
    // Right-click Move — same semantics as the M-then-click flow above:
    // drops autonomous attackTarget + any attack-sourced weapon slot,
    // but leaves manual fire (source='manual') alive so the user can
    // re-position a firing unit without losing their armed shot.
    const engine = this.scene.engine
    let n = 0
    for (const id of this.scene.selected) {
      const u = this.scene.unitById(id)
      if (!u) continue
      u.moveTarget = { x: world[0], z: world[2] }
      u.attackTarget = null
      for (let slot = 0; slot < 3; slot++) {
        const s = u.weaponSlots[slot]
        if (s && s.target && s.target.source === 'attack') {
          engine.setWeaponTarget(u.id, slot, null)
        }
      }
      n++
    }
    this.#setStatus(`Move — ${n} unit(s) heading to (${world[0].toFixed(0)}, ${world[2].toFixed(0)}).`)
  }

  #onClick(e) {
    if (!this.scene) return
    // Drag-select gestures end with a synthetic click event — swallow
    // it so the "click empty ground → no-op + status update" handler
    // doesn't wipe the selection we just made.  Flag is set by the
    // drag-rect on pointerup and consumed here.
    if (this._suppressNextClick) {
      this._suppressNextClick = false
      return
    }
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    // Placement mode — left-click commits the spawn at the current
    // ghost position.  The model + COB have already been loaded by
    // beginPlacement, so this lands instantly without a network
    // hitch.  Spawn count + tag are passed through to addUnit so the
    // roster + Runtime panels pick it up on the next refresh tick.
    if (this._placement) {
      const p = this._placement
      const world = this.#screenToGround(sx, sy)
      const x = world ? world[0] : p.pos.x
      const z = world ? world[2] : p.pos.z
      const inst = this.scene.addUnit({
        name: p.name,
        model: p.model,
        cobScript: p.cobScript,
        x, z,
        headingRad: 0,
        side: p.side | 0,
      })
      // Fetch FBI meta for this placed unit too — same path as
      // spawn() so click-placed units get the shared weapon-driver
      // projectiles when they fire.
      this.#fetchUnitMeta(inst).catch(() => { /* ignore */ })
      // Auto-run Create on spawn so the unit immediately settles into
      // its idle pose (flares hidden, panels at rest).
      if (inst && inst.cobUnit && inst.cobUnit.scriptNames && inst.cobUnit.scriptNames.includes('Create')) {
        try { inst.cobUnit.start('Create') } catch { /* ignore */ }
      }
      this.#setStatus(`Spawned ${p.name} at (${x.toFixed(0)}, ${z.toFixed(0)}) — ${this.scene.unitCount()} unit${this.scene.unitCount() === 1 ? '' : 's'} on field.`)
      // Single-shot placement by default: one click drops one unit and
      // exits placement mode so the user is back to selection.  Hold
      // Shift on the click to KEEP placement live for drop-rows of the
      // same unit type.  Mirrors the Spawn tooltip + matches the
      // pointer-drag handler in #beginPlacementDrag.
      if (e.shiftKey) {
        this.#refreshEntities()
      } else {
        this.cancelPlacement()
      }
      return
    }
    // Project the click into world coords on the ground plane via
    // the camera's screen-to-world helper (if available).  Fall back
    // to selecting the nearest unit by screen-projected distance.
    const world = this.#screenToGround(sx, sy)
    // If a command is pending (Move / Attack), consume it.
    if (this._pendingCmd === 'move' && world && this.scene.selected.size > 0) {
      // Move command — clear the autonomous attack pursuit so
      // #stepAttack doesn't overwrite the user-supplied moveTarget
      // every tick (chasing the old enemy).  Manual weapon-slot
      // targets (source='manual', set when the user armed a Fire
      // button and clicked an enemy) are LEFT INTACT — TA's RTS
      // muscle memory expects "Move while firing" to keep shooting
      // at the target as long as it's in range.  #stepAttack on the
      // next tick will withdraw any 'attack'-source slots that the
      // autonomous loop had armed; that's the cleanup path for the
      // attackTarget=null we just set.
      const engine = this.scene.engine
      for (const id of this.scene.selected) {
        const u = this.scene.unitById(id)
        if (!u) continue
        u.moveTarget = { x: world[0], z: world[2] }
        u.attackTarget = null
        // Surgically clear ONLY attack-source slots — leave manual
        // fire alive.  Without this case-split the user's manual
        // Primary that they just armed would die the moment they
        // queue a Move on top of it.
        for (let slot = 0; slot < 3; slot++) {
          const s = u.weaponSlots[slot]
          if (s && s.target && s.target.source === 'attack') {
            engine.setWeaponTarget(u.id, slot, null)
          }
        }
      }
      this._pendingCmd = null
      if (this._armedCursor) this._armedCursor.setSlot(null)
      this.#refreshDefaultCursor()
      this.#setStatus(`Move order issued to ${this.scene.selected.size} unit(s).`)
      return
    }
    if (this._pendingCmd === 'attack' || this._pendingCmd === 'primary' ||
        this._pendingCmd === 'secondary' || this._pendingCmd === 'tertiary') {
      const slotKey = (this._pendingCmd === 'attack') ? 'primary' : this._pendingCmd
      const slotIdx = { primary: 0, secondary: 1, tertiary: 2 }[slotKey]
      const slotName = slotKey[0].toUpperCase() + slotKey.slice(1)
      const hit = this.#pickUnitAt(sx, sy)
      // Route every armed-Fire click through the engine's unified
      // weapon SM via setWeaponTarget.  The SM owns aim-thread
      // lifecycle, reload timing, burst cycling, ballistic pitch,
      // and emits 'fire' events when shots leave — our subscriber
      // (registered in open()) then spawns the visible projectile
      // via the shared weapon driver.  Two target shapes are
      // accepted: a unit (attack that specific enemy) or a point
      // (force-fire at the clicked ground location, e.g. for the
      // d-gun, suppression fire on choke points, or just testing
      // weapon arcs).  Hitting a unit takes precedence over the
      // ground point below it.
      if (this.scene.selected.size === 0) {
        this.#setStatus(`${slotName} — no units selected.`)
      } else if (hit) {
        // Friendly-fire prevention — if every selected unit shares
        // the target's side, cancel the attack mode and switch
        // selection to the clicked unit instead.  Matches TA's
        // refusal to attack-target a same-team unit; gives the user
        // a useful fallthrough (pick the unit they actually clicked).
        const sel = [...this.scene.selected]
            .map((id) => this.scene.unitById(id))
            .filter((u) => u && !u.dead)
        const sameSide = sel.length > 0 && sel.every((u) => (u.side | 0) === ((hit.side | 0)))
        if (sameSide) {
          // Cancel armed slot + re-select the clicked unit.  Clear
          // the armed cursor so the user sees the normal cursor
          // come back immediately.
          this._pendingCmd = null
          if (this._armedCursor) this._armedCursor.setSlot(null)
          this.scene.selectOnly(hit.id)
          this.#refreshDefaultCursor()
          this.#setStatus(`Selected ${hit.name} (same side as selection).`)
          return
        }
        const engine = this.scene.engine
        let targeted = 0
        for (const id of this.scene.selected) {
          if (id === hit.id) continue  // don't attack self
          const u = this.scene.unitById(id)
          if (!u) continue
          // Set attackTarget for ALL armed-fire variants so the
          // engine's autonomous attack loop walks the unit into
          // range first when the target is out of weapon reach.
          // Without this, selecting Primary and clicking a distant
          // enemy would set the slot target on a unit that can never
          // close the distance — the projectile would never spawn
          // and the user would see "nothing happens" for the units
          // not already in range.
          u.attackTarget = hit
          engine.setWeaponTarget(u.id, slotIdx, { unit: hit }, { source: 'manual' })
          targeted++
        }
        const verb = (this._pendingCmd === 'attack') ? 'engaging' : 'firing at'
        this.#setStatus(`${slotName} — ${targeted} unit(s) ${verb} ${hit.name}.`)
      } else if (world) {
        // No unit under cursor — fall back to force-fire at the
        // ground point.  This is what the user expects after clicking
        // Primary on the Controls panel and then clicking empty
        // terrain: "fire that weapon at that spot."  Mirrors the
        // viewer's arm-then-click-ground behaviour so both views
        // feel the same.
        const engine = this.scene.engine
        let targeted = 0
        for (const id of this.scene.selected) {
          const u = this.scene.unitById(id)
          if (!u || u.dead) continue
          engine.setWeaponTarget(u.id, slotIdx, { point: [world[0], world[1], world[2]] }, { source: 'manual' })
          targeted++
        }
        this.#setStatus(`${slotName} — ${targeted} unit(s) firing at (${world[0].toFixed(0)}, ${world[2].toFixed(0)}).`)
      } else {
        // Couldn't resolve a ground intersection either (click was
        // above the horizon).  Cancel cleanly.
        this.#setStatus(`${slotName} — click cancelled (no target).`)
      }
      this._pendingCmd = null
      if (this._armedCursor) this._armedCursor.setSlot(null)
      return
    }
    // Force-target ground (opt-in) — Shift+left-click on empty ground
    // with selection arms slot 0 at the clicked point.  Checked BEFORE
    // the unit-pick path so a click that misses a unit but hits ground
    // (the common case for "fire over there") routes to the force-fire
    // gesture, not the no-op empty-ground branch.  shouldForceTarget
    // gates on the persisted opt-in (Settings → Unit Editor → "Force-
    // target ground on click") AND on the modifier — Sandbox requires
    // Shift; Viewer doesn't.
    if (this.scene.selected.size > 0 && world
        && shouldForceTarget({ shiftKey: e.shiftKey, requireShift: true })) {
      // Was the click on a unit?  If so, fall through to the unit-pick
      // path so the user can attack-target a specific enemy with the
      // engine's autonomous loop instead of the static-point gesture.
      const pickedFirst = this.#pickUnitAt(sx, sy)
      if (!pickedFirst) {
        const engine = this.scene.engine
        let n = 0
        for (const id of this.scene.selected) {
          const u = this.scene.unitById(id)
          if (!u || u.dead) continue
          engine.setWeaponTarget(u.id, 0, { point: [world[0], world[1], world[2]] }, { source: 'manual' })
          n++
        }
        this.#setStatus(`Force-fire — ${n} unit(s) targeting (${world[0].toFixed(0)}, ${world[2].toFixed(0)}).`)
        return
      }
    }
    // Default click — TA-style left-click semantics:
    //
    //   * Click on a unit with OTHER units already selected → attack
    //     (selected units engage the clicked unit; selection unchanged).
    //     This is what made TA a "left-click game" — no arming, no
    //     right-click, just point at the enemy.  Drives the engine's
    //     autonomous attack loop (#stepAttack walks units into range
    //     then drives the weapon SM via setWeaponTarget).
    //   * Click on a unit with NOTHING selected, OR click on a unit
    //     that IS already the sole selection → select that unit.
    //   * Click on empty ground → NO-OP (selection persists).  Escape
    //     is the explicit "deselect" gesture so the user doesn't lose
    //     their selection by an accidental click off the unit.
    //     (Move-to-ground still requires the Move toolbar gesture or
    //     right-click, deliberately — left-click move would conflict
    //     with the "select nothing" / "no-op" idiom users expect.)
    const picked = this.#pickUnitAt(sx, sy)
    if (picked) {
      const sel = this.scene.selected
      const onlySelf = (sel.size === 1 && sel.has(picked.id))
      if (sel.size > 0 && !sel.has(picked.id)) {
        // Friendly-fire prevention — same-side clicks switch
        // selection instead of attacking.  Mirrors the armed-Fire
        // path so both gestures refuse to target an ally.
        const selUnits = [...sel].map((id) => this.scene.unitById(id)).filter((u) => u && !u.dead)
        const sameSide = selUnits.length > 0 && selUnits.every((u) => (u.side | 0) === ((picked.side | 0)))
        if (sameSide) {
          this.scene.selectOnly(picked.id)
          this.#setStatus(`Selected ${picked.name} (HP ${picked.health}).`)
          return
        }
        // Attack — every selected unit (except the target itself)
        // engages the clicked enemy.  attackTarget feeds #stepAttack,
        // which handles walk-into-range + arms the weapon SM.  Selection
        // stays put so the user can re-issue commands without losing it.
        let n = 0
        for (const id of sel) {
          if (id === picked.id) continue
          const u = this.scene.unitById(id)
          if (!u || u.dead) continue
          u.attackTarget = picked
          n++
        }
        this.#setStatus(`Attack — ${n} unit(s) engaging ${picked.name} (HP ${picked.health}).`)
      } else if (sel.size === 0 || onlySelf) {
        this.scene.selectOnly(picked.id)
        this.#setStatus(`Selected ${picked.name} (HP ${picked.health}).`)
      } else {
        // sel.size > 0 and picked is IN the selection — promote to
        // sole selection so subsequent left-click-attack reads as
        // "this unit attacks that one" rather than "the group attacks
        // one of its own members".
        this.scene.selectOnly(picked.id)
        this.#setStatus(`Selected ${picked.name} (HP ${picked.health}).`)
      }
    }
  }

  // #pickUnitAt projects each unit's world position to screen space
  // and returns the nearest unit within a click-pixel radius (~32px).
  // Cheap O(N) for small N which the sandbox scene generally is.
  #pickUnitAt(sx, sy) {
    if (!this.scene || !this.camera) return null
    let best = null
    let bestDist = 32  // pixel-radius gate
    for (const u of this.scene.units()) {
      // Compose model-space centroid then add unit pos.
      const cx = u.pos.x
      const cy = u.pos.y + 12  // approximate centre-of-mass lift
      const cz = u.pos.z
      const screen = this.#worldToScreen(cx, cy, cz)
      if (!screen) continue
      const dx = screen[0] - sx, dy = screen[1] - sy
      const dist = Math.hypot(dx, dy)
      if (dist < bestDist) { bestDist = dist; best = u }
    }
    return best
  }

  #worldToScreen(wx, wy, wz) {
    const cam = this.camera
    if (!cam || !cam.viewMatrix || !cam.projMatrix) return null
    // p = proj * view * [wx wy wz 1]
    const v = cam.viewMatrix, p = cam.projMatrix
    const vx = v[0] * wx + v[4] * wy + v[8]  * wz + v[12]
    const vy = v[1] * wx + v[5] * wy + v[9]  * wz + v[13]
    const vz = v[2] * wx + v[6] * wy + v[10] * wz + v[14]
    const vw = v[3] * wx + v[7] * wy + v[11] * wz + v[15]
    const px = p[0] * vx + p[4] * vy + p[8]  * vz + p[12] * vw
    const py = p[1] * vx + p[5] * vy + p[9]  * vz + p[13] * vw
    const pw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw
    if (pw <= 0) return null
    const ndcX = px / pw
    const ndcY = py / pw
    const rect = this.canvas.getBoundingClientRect()
    return [ (ndcX * 0.5 + 0.5) * rect.width, (1 - (ndcY * 0.5 + 0.5)) * rect.height ]
  }

  // #screenToGround inverts a screen click to a world-space ground
  // point (y = 0 plane intersect).  Returns [wx, 0, wz] or null when
  // the click ray doesn't reach the ground.
  #screenToGround(sx, sy) {
    const cam = this.camera
    if (!cam || !cam.eye) return null
    const rect = this.canvas.getBoundingClientRect()
    const ndcX = (sx / rect.width) * 2 - 1
    const ndcY = 1 - (sy / rect.height) * 2
    // Build inverse view-proj from cam matrices.  OrbitCamera
    // exposes invViewMatrix + invProjMatrix; fall back to identity
    // if not available.
    const ivp = (cam.invViewProj && cam.invViewProj()) || null
    if (!ivp) {
      // Crude fallback — assume the click is the camera target XZ.
      return [cam.target?.[0] || 0, 0, cam.target?.[2] || 0]
    }
    // Two ray-points in clip space (near + far), unproject + ground intersect.
    const nearP = this.#unprojectClip(ivp, ndcX, ndcY, -1)
    const farP  = this.#unprojectClip(ivp, ndcX, ndcY,  1)
    if (!nearP || !farP) return null
    // Ground at y = 0 — parametric ray (1-t)*near + t*far, solve for y=0.
    const dy = farP[1] - nearP[1]
    if (Math.abs(dy) < 1e-6) return null
    const t = -nearP[1] / dy
    if (t < 0 || t > 1) return null
    return [
      nearP[0] + (farP[0] - nearP[0]) * t,
      0,
      nearP[2] + (farP[2] - nearP[2]) * t,
    ]
  }

  #unprojectClip(invVP, x, y, z) {
    const px = invVP[0] * x + invVP[4] * y + invVP[8]  * z + invVP[12]
    const py = invVP[1] * x + invVP[5] * y + invVP[9]  * z + invVP[13]
    const pz = invVP[2] * x + invVP[6] * y + invVP[10] * z + invVP[14]
    const pw = invVP[3] * x + invVP[7] * y + invVP[11] * z + invVP[15]
    if (pw === 0) return null
    return [px / pw, py / pw, pz / pw]
  }

  #observeResize() {
    if (!this.canvas || typeof ResizeObserver === 'undefined') return
    this._resizeObserver = new ResizeObserver(() => {
      if (this.renderer) this.renderer.requestRedraw()
    })
    this._resizeObserver.observe(this.canvas)
  }

  #setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text
  }

  dispose() {
    if (this._resizeObserver) this._resizeObserver.disconnect()
    this._resizeObserver = null
    // Detach engine event subscriptions so stale closures don't fire
    // into a disposed view.
    if (this._engineSubs) {
      for (const unsub of this._engineSubs) try { unsub() } catch { /* ignore */ }
      this._engineSubs = null
    }
    // Drop any in-flight smoke trails so a re-open doesn't inherit
    // stale projectiles from the previous session.
    if (this._smokeTrails) this._smokeTrails.clear()
    // Tear down the shift-preview overlay so its DOM doesn't outlive
    // the view.  Pool entries leave with the host.
    if (this._shiftPreviewHost) {
      this._shiftPreviewHost.remove()
      this._shiftPreviewHost = null
      this._shiftPreviewEls = null
    }
    if (this.renderer) this.renderer.dispose()
    this.renderer = null
    this.scene = null
  }
}
