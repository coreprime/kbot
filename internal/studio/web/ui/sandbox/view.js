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
// gestures, etc.).  An earlier rev shared a BaseView class with
// MvControls; Phase C removed it — the every-cross-section moment
// became a contamination vector.  What's truly shared (smoke trails,
// engine-sub bookkeeping, hotkey wiring, sim-rate, inspector cob
// proxy) lives as free functions in ui/common/view-helpers.js and is
// called explicitly from both views.  Everything else (per-view
// Command API, camera tracking, unit acks, FX aggregation) lives
// inside whichever view actually uses it.

import { ModelLoader } from '../../model3d/model-loader.js'
import { ModelRenderer } from '../../model3d/model-renderer.js'
import { OrbitCamera } from '../../model3d/orbit-camera.js'
import { TextureCache } from '../../model3d/texture-cache.js'
import { TAPalette } from '../../model3d/palette.js'
import { SandboxScene } from './scene.js'
import { attachOrbitControls } from '../../model3d/camera-controls.js'
import { ArmedCursor } from '../../model3d/armed-cursor.js'
import { teamColorForSide } from '../../model3d/team-colors.js'
import {
  wireHotkeys,
  wrapCobWithAggregate,
  disposeView,
} from '../common/view-helpers.js'
import { advanceCobLifecycle } from '../common/cob-lifecycle.js'

export class SandboxView {
  constructor({ canvas, scene = null, statusEl, onModelLoaded } = {}) {
    // Optional shared scene — when supplied (the split-pane case), this
    // view observes that scene's engine + uses its smoke trails +
    // selection set, but draws into ITS OWN canvas/camera/renderer.
    // When null (the single-pane case), open() creates a fresh
    // SandboxScene on first paint.  This is the inversion that lets
    // a tab host N viewports against one engine.
    this._externalScene = scene
    // Engine subscription unsubscribe closures captured by
    // subscribeEngine() (currently unused since 'fire' / 'death' /
    // 'move-stop' have moved to scene-level, but kept for any
    // view-specific subscriptions a host wires later).  _hotkeysDetach
    // is the close returned by wireHotkeys().  disposeView() sweeps
    // both.
    this._engineSubs = []
    this._hotkeysDetach = null
    // Per-pane model cache.  Each view has its own ModelLoader bound to
    // its own GL context, and a Model's VBO ids are context-specific —
    // you can NOT draw a model loaded in pane A's context using pane
    // B's context (the buffers don't exist there; the draw silently
    // no-ops).  When this view spawns a unit it pre-populates this
    // cache with its load result; sibling panes lazy-load their own
    // copy on first encounter of an entity referring to a model name
    // they haven't yet uploaded.  Lookup is by model name (u.name on
    // the engine side).
    this._localModels = new Map()    // name → Model (this pane's GL ctx)
    this._loadingModels = new Set()  // names with an in-flight load
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
    // statusEl flows through to setStatus() / #setStatus().  Keep
    // the `this.statusEl` alias too — external callers (the spawn
    // dialog, ribbon handlers) reach in via that name.
    this.statusEl = statusEl
    this._statusEl = statusEl
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
        // Split-pane focus gate — only the focused pane's R / arrow
        // keys take effect.  See _isFocusedPane wiring in split-host.
        isActive: () => !this._isFocusedPane || this._isFocusedPane(),
        // onUserInteract fires when the user takes manual control —
        // pan, key-scroll, T-key.  Use it to drop unit-tracking (the
        // user is driving the camera by hand; chasing the unit would
        // fight the gesture) and the Tracking checkbox readout.
        onUserInteract: (kind) => {
          if (kind === 'pan' && this.camera && this.camera.trackedTarget) {
            this.setTracking(false)
          }
        },
        // Sandbox claims:
        //   - placement-drag while a unit is queued for spawn
        //   - SHIFT + left-drag for the rectangle-select gesture
        //     (camera-controls.js no longer treats shift as a pan
        //     modifier, so the gesture is ours to grab)
        // Every other left-drag falls through to camera-controls so
        // plain left-drag orbits exactly like the unit editor.
        // _pendingCmd / _placement take priority — their commit-on-
        // click flow shouldn't be eaten by a stray drag-select.
        onLeftDragStart: (e) => {
          if (this._pendingCmd) return false
          if (this._placement) return this.#beginPlacementDrag(e)
          if (e.shiftKey) return this.#beginDragSelect(e)
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
      if (this._externalScene) {
        // Split-pane case — sibling view already constructed the
        // scene; we just observe it.  Engine subscriptions, smoke
        // trails, and the FBI sounds debounce all live there.
        this.scene = this._externalScene
      } else {
        // Single-pane case — own the scene.  The constructor wires
        // 'fire' / 'death' / 'move-stop' subscriptions internally so
        // projectile spawn + death puffs + arrival voice all fire
        // exactly once per event regardless of observer count.
        this.scene = new SandboxScene({ palette: this.palette })
      }
      // Push the active world's gravity into the engine so the
      // ballistic aim solver agrees with the projectile flight sim.
      // Renderer environments differ (Lunar = lighter, default = 80
      // wu/s²); without the sync, cannon turrets would aim for one
      // gravity while shells fly under another and miss.  In the
      // split-pane case the first-opened pane's renderer wins (each
      // pane could have its own environment; gravity is engine-level
      // so they reconcile to one value — last writer wins).
      if (typeof this.renderer.getGravity === 'function') {
        this.scene.engine.setGravity(this.renderer.getGravity())
      }
      // Cross-unit dynamic-light aggregation is pull-side (Phase D):
      // the per-frame onAfterFrame hook below queries
      // engine.getSceneLight() and forwards the result to
      // this.renderer.setPulseLight.  The engine itself stays headless.
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
      // Per-frame lifecycle advance for every live unit.  The shared
      // refresh-tick only walks the FOCUSED unit (so the Controls /
      // Script Commands panels see the lifecycle flip); non-focused
      // units need their own walker, otherwise background spawn-ins
      // never get their Activate auto-fired and stay in their pre-
      // animation pose.  Sandbox units have no build-ramp, so we
      // pass build% = 100 (the function's default) and Activate
      // fires as soon as Create's thread dies.
      if (this.scene) {
        for (const u of this.scene.units()) {
          if (u.dead || !u.binding) continue
          advanceCobLifecycle(u.binding, u.buildPercent != null ? u.buildPercent : 100)
        }
      }
      // Pull-side scene light: ask the engine for the brightest live
      // light-emitting particle across all units and push it into the
      // renderer's single dynamic-light slot.  This is the cross-unit
      // aggregation that used to live engine-side via setRenderer —
      // now the engine is headless and the view bridges per frame.
      if (this.scene && this.scene.engine && typeof this.renderer.setPulseLight === 'function') {
        const light = this.scene.engine.getSceneLight()
        if (light) this.renderer.setPulseLight(light.pos, light.color, light.strength)
        else this.renderer.setPulseLight(null, null, 0)
      }
      // Smoke trails advance INSIDE scene.tick (scene owns the
      // SmokeTrailManager so multiple panes observe one set of trails).
      // No extra tick call needed here.
      this.#refreshEntities()
      // Re-position the shift-preview overlays every frame so they
      // track moving units + animated paths.  Cheap when the preview
      // isn't active (early-out inside).
      this.#refreshShiftPreview()
      // Cursor mode depends on selection state, hover state, and
      // armed command — driving it per-frame is the simplest way
      // to keep it in sync with selection mutations from any source
      // (click, drag-rect, Esc, programmatic).  ArmedCursor.setSlot
      // is a cheap no-op when nothing changed.
      this.#refreshDefaultCursor()
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
      // Same per-pane cache populate as beginPlacement — see the
      // _localModels commentary on the constructor for the GL-context
      // rationale.
      this._localModels.set(name, model)
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
      // having to click anything per-unit.  Flips lifecycle to
      // 'creating' so the per-frame advanceCobLifecycle walker can
      // promote it to 'created' (when Create's thread dies) and then
      // auto-fire Activate (since sandbox units start at build% 100).
      if (inst.binding && inst.binding.hasScript && inst.binding.hasScript('Create')) {
        inst.binding._lifecycle = 'creating'
        try { inst.binding.start('Create') } catch { /* ignore */ }
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
      // Cache the model in this pane's local registry so #refreshEntities
      // doesn't lazy-reload it on the next tick.  Sibling panes that
      // observe the same scene will lazy-load their own copy when they
      // first see this unit in scene.units().
      this._localModels.set(name, model)
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
    // Same hook is the canonical "this view is no longer in front"
    // signal — flip the armed-cursor overlay off so a backgrounded
    // sandbox's last-armed glyph doesn't sit frozen on screen while
    // the user works in a sibling tab.  Re-enabled by the next
    // setArmed/setAmbient call when the user returns.
    if (this._armedCursor && typeof this._armedCursor.setVisible === 'function') {
      this._armedCursor.setVisible(!s)
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
        if (inst.binding && inst.binding.hasScript && inst.binding.hasScript('Create')) {
          inst.binding._lifecycle = 'creating'
          try { inst.binding.start('Create') } catch { /* ignore */ }
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
    if (n > 0) {
      this.#setStatus(`Selected ${n} unit${n === 1 ? '' : 's'}.`)
      // Play the TA select1-bank ack on the FIRST unit in the new
      // selection.  Single voice rather than N voices so a drag-rect
      // grabbing a dozen Peewees doesn't fire a dozen acks at once.
      this.#playSelectAck()
    } else {
      this.#setStatus('Selection cleared.')
    }
  }

  // #playSelectAck plays the TA select1-bank sound (select1/2/...)
  // on the first unit in the current selection.  Used by every
  // selection-changing gesture (single click, drag rect, ribbon
  // Select All) so the user gets the familiar TA acknowledgement.
  #playSelectAck() {
    const units = this.getSelectedUnits()
    if (units.length === 0) return
    this.playUnitSoundRandom(units[0], ['select1', 'select2', 'select3', 'select4', 'select5'])
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
              // Trail dots use the dedicated `pathicon` GAF glyph —
              // smaller + distinct from the destination marker so the
              // path is legible at a glance ("walking to the cursormove
              // marker via the pathicon dots") instead of looking like
              // a smear of identical move icons.
              const dot = ensureEl('pathicon')
              dot.style.left = ps[0] + 'px'
              dot.style.top  = ps[1] + 'px'
              dot.style.opacity = String(0.35 + 0.55 * t)
              dot.style.width = '16px'
              dot.style.height = '16px'
              dot.style.marginLeft = '-8px'
              dot.style.marginTop = '-8px'
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
  // glyph instead of a static-first-frame CSS cursor: url(...) which
  // most browsers refuse to animate.
  //
  // Cursor mode reflects WHAT WILL HAPPEN if the user clicks right
  // now — the click is the implicit verb, the glyph is the noun:
  //
  //   placement active     → no overlay (ghost preview IS the cursor)
  //   armed command active → that command's glyph (move/attack/...)
  //   no selection, ground → cursornormal (click is a no-op)
  //   no selection, unit   → cursorselect  (click will select)
  //   selection, friendly  → cursorselect  (click will swap selection)
  //   selection, enemy     → cursorattack  (click will attack)
  //   selection, ground    → cursormove    (click will Move there)
  //
  // The hover-unit id + side comparison match the actual click
  // routing in #onClick so the cursor never lies about what's about
  // to happen.
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
    const sel = this.scene ? this.scene.selected : null
    const hasSelection = sel && sel.size > 0
    const hoverId = this._lastHoverUnitId || 0
    let ambient
    if (hoverId) {
      // Hovering a unit — clicking will SELECT it (friendly) or
      // ATTACK it (enemy, only when we have a selection of our own
      // to dispatch).  Same-side check matches #onClick's friendly-
      // fire prevention so the cursor + the click agree.
      const hovered = this.scene && this.scene.unitById(hoverId)
      if (hasSelection && hovered && !sel.has(hovered.id)) {
        const selUnits = [...sel].map((id) => this.scene.unitById(id)).filter(Boolean)
        const sameSide = selUnits.length > 0 && selUnits.every((u) => (u.side | 0) === ((hovered.side | 0)))
        ambient = sameSide ? 'select' : 'attack'
      } else {
        ambient = 'select'
      }
    } else {
      // Hovering ground — clicking moves the selection (if any) or
      // is a no-op (if not).
      ambient = hasSelection ? 'move' : 'normal'
    }
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
  // #ensureLocalModel kicks off a one-shot lazy load of `name` into
  // THIS pane's GL context.  Idempotent — concurrent calls coalesce
  // via the _loadingModels guard.  When the load resolves, the next
  // #refreshEntities tick finds the model in _localModels and feeds
  // it to the renderer.  Used by the per-pane substitution in
  // #refreshEntities below: sibling panes (the ones that didn't
  // spawn the unit) see u.model belongs to the wrong context and
  // ask us to upload our own copy.
  #ensureLocalModel(name) {
    if (!name || !this.loader) return
    if (this._localModels.has(name)) return
    if (this._loadingModels.has(name)) return
    this._loadingModels.add(name)
    this.loader.load(name).then((m) => {
      this._localModels.set(name, m)
      this._loadingModels.delete(name)
    }).catch(() => {
      this._loadingModels.delete(name)
    })
  }

  #refreshEntities() {
    if (!this.renderer || !this.scene) return
    const entities = []
    for (const u of this.scene.units()) {
      if (!u.model) continue
      // GL-context substitution — each pane's renderer can only draw
      // models whose VBOs live in its own context.  If the unit was
      // spawned by US, _localModels has the right reference and we
      // use it directly.  Otherwise the unit was spawned in a sibling
      // pane: kick off a lazy load (no-op when already in flight) and
      // skip this entity for the current frame — it'll appear next
      // tick once the load completes.  Cost: a single network hit per
      // (model name × pane) the first time the sibling pane observes
      // a foreign unit.
      const localModel = this._localModels.get(u.name)
      if (!localModel) {
        this.#ensureLocalModel(u.name)
        continue
      }
      // No bounds-based lift: TA models are authored with their feet
      // pieces (heel/toes/wheel/etc.) resting at world y=0, so
      // placing the unit at y=0 grounds it naturally — matching the
      // unit-editor convention.  An earlier bounds-min lift was
      // added to compensate for "floating" units (round 206), but it
      // over-corrects on large units: Krogoth's gun-flare pieces
      // extend to y=-15 while its actual heel pieces sit at y=0, so
      // the lift would shove the whole unit 15 wu above ground.
      // Heading offset by +π — mirrors the single-unit viewer's
      // _applyRendererTransform convention.  The model loader X-
      // flips every vertex (so right-handed GL matches TA's left-
      // handed authoring), which has the side effect of pointing the
      // unit's "front" at the opposite of its logical heading.  +π
      // compensates so the unit faces the direction it walks.
      // Per-unit team colour from the unit's side field — engine owns
      // the side index, team-colors.js maps it to the renderer's
      // [r,g,b] tuple (or null for side 0, the "no recolour" sentinel
      // that keeps the model's authored ARM blue).
      entities.push({
        model: localModel,
        binding: u.binding,
        buildPercent: u.buildPercent,
        transform: { x: u.pos.x, y: u.pos.y, z: u.pos.z, headingRad: u.heading + Math.PI },
        selected: this.scene.isSelected(u.id),
        // teamColor is the hue-shift modulator for the main shader
        // (null = no recolour = keep authored ARM blue); `side` is
        // the raw faction index so the Phase 3 impostor batch can
        // resolve a concrete RGB tuple (including the ARM-blue
        // case) via displayRgbForSide.
        side: u.side | 0,
        teamColor: teamColorForSide(u.side),
      })
    }
    // Placement ghost — appended LAST so it draws over the live units
    // (renderer iterates entities in order).  The renderer checks
    // ent.ghost and emits a translucent green wireframe instead of a
    // solid main pass.
    if (this._placement && this._placement.model) {
      const p = this._placement
      // Ghost matches the spawned unit's grounding rule — no lift,
      // feet at y=0.  Symmetric with the live-unit loop above.
      const lift = 0
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
    // Esc cascade is sandbox-specific (placement → armed cmd →
    // selection), so it stays here as a bespoke listener.  The
    // shared M/A/F/D/S/T keymap is wired separately via
    // the wireHotkeys helper (attachUnitHotkeys) so both views agree
    // on the keymap definition without copy-pasted branches.
    window.addEventListener('keydown', (e) => {
      const dlg = document.getElementById('model-viewer-dialog')
      const sandboxActive = dlg && dlg.classList.contains('sandbox-mode') && !dlg.classList.contains('hidden')
      if (!sandboxActive) return
      const tgt = e.target
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return
      if (tgt && tgt.isContentEditable) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key !== 'Escape') return
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
    })
    // Shared M/A/F/D/S/T keymap.  Routes Move/Primary/Secondary/
    // Tertiary into setPendingCommand, Stop into #stopSelected, T
    // into toggleTracking.  Gated on the selection being non-empty
    // so a stray keystroke doesn't arm a cursor with no unit to
    // dispatch to.  T is allowed even with no selection so the user
    // can untrack the current target without re-selecting first.
    //
    // Split-pane gate: every pane registers a window-level keydown
    // listener through attachUnitHotkeys.  Without an active-pane
    // filter, pressing T fires N times (once per pane), toggling
    // each pane's tracking — the user wanted a per-pane gesture
    // and instead got "toggle every viewport".  _isFocusedPane is
    // assigned by split-host's makeView; in the single-pane case
    // (no split-host involvement) it's missing and we let every
    // key through.
    const focusGate = () => !this._isFocusedPane || this._isFocusedPane()
    wireHotkeys(this, {
      dialogId: 'model-viewer-dialog',
      allowed: () => focusGate() && this.scene && this.scene.selected.size > 0,
      onCommand: (cmd) => { if (focusGate()) this.setPendingCommand(cmd) },
      onStop:    () => { if (focusGate()) this.#stopSelected() },
      onTrack:   () => { if (focusGate()) this.toggleTracking() },
    })
  }

  // #stopSelected wraps stop() with the sandbox-specific post-stop
  // housekeeping: disarm a pending Move/Fire command + push a status
  // string.  The actual per-unit teardown (moveTarget / attackTarget /
  // weapon slots / StopMoving / TargetCleared) lives in
  // engine.stopUnits — this view's stop() is its thin wrapper.
  #stopSelected() {
    const n = this.stop()
    if (this._pendingCmd) this.setPendingCommand(null)
    this.#setStatus(`Stopped ${n} unit(s).`)
  }

  // setTracking arms / disarms tracking explicitly.  Used by the
  // Renderer panel's Tracking checkbox + the T hotkey.  Status text
  // is sandbox-specific (the "select a unit first" hint when no
  // selection is active) so both entry points share the same user
  // feedback.
  setTracking(on) {
    if (!this.camera) return
    if (!on) {
      this.untrack()
      this.#setStatus('Tracking off.')
      return
    }
    const units = this.getSelectedUnits()
    if (units.length === 0) {
      this.#setStatus('Tracking — select a unit first.')
      return
    }
    if (this.trackFirstSelected(`Unit ${units[0].id}`)) {
      this.#setStatus(`Tracking ${units[0].name || 'unit'}.`)
    }
  }

  // toggleTracking is the T-hotkey entry point.  Unlike the Renderer
  // panel's checkbox (which is binary on/off), the hotkey cycles
  // through every currently-selected unit before untracking: press T
  // once to lock onto unit 1, again for unit 2, … past the last to
  // untrack.  The cycle ordering is whatever getSelectedUnits()
  // returns (insertion order of the selected set).  When nothing is
  // selected the press just clears tracking.
  toggleTracking() {
    if (!this.camera) return
    const units = this.getSelectedUnits()
    if (units.length === 0) {
      if (this.camera.trackedTarget) {
        this.untrack()
        this.#setStatus('Tracking off.')
      } else {
        this.#setStatus('Tracking — select a unit first.')
      }
      return
    }
    const next = this.camera.advanceTrackedTarget(
      units,
      (u) => u.name || `Unit ${u.id}`,
    )
    if (next) {
      this.#setStatus(`Tracking ${next.name || `unit ${next.id}`}.`)
    } else {
      this.#setStatus('Tracking off.')
    }
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
      // issueAttack (below) handles the per-unit attackTarget fanout
      // + ok1-bank ack on the first pursuer.  Centralised so every
      // attack-issuing gesture in the sandbox converges on it.
      const n = this.issueAttack(hit)
      this.#setStatus(`Attack — ${n} unit(s) targeting ${hit.name} (HP ${hit.health}).`)
      return
    }
    const world = this.#screenToGround(sx, sy)
    if (!world) return
    // Right-click Move dispatches through issueMove — same shared
    // path the M-then-click flow uses, including the ok1-bank ack
    // on the first unit.
    const n = this.issueMove(world)
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
      // its idle pose (flares hidden, panels at rest).  Lifecycle
      // 'creating' lets advanceCobLifecycle auto-promote and (when
      // the unit ships an Activate script) auto-fire that too once
      // Create's thread dies.
      if (inst && inst.binding && inst.binding.hasScript && inst.binding.hasScript('Create')) {
        inst.binding._lifecycle = 'creating'
        try { inst.binding.start('Create') } catch { /* ignore */ }
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
      // issueMove fans the Move order out to every selected unit,
      // clears autonomous attack pursuit, preserves manual weapon
      // slots, and plays the ok1-bank ack on the first unit — same
      // path the right-click Move + the M-then-click flow converge
      // on so every Move gesture in the sandbox is one code path.
      const n = this.issueMove(world)
      this._pendingCmd = null
      if (this._armedCursor) this._armedCursor.setSlot(null)
      this.#refreshDefaultCursor()
      this.#setStatus(`Move order issued to ${n} unit(s).`)
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
      // Command consumed — clear the pending state and rerun the
      // cursor decision so the overlay drops the armed glyph and
      // re-derives the ambient (Move when selection live, etc.)
      // without waiting for the next mousemove event.
      this._pendingCmd = null
      this.#refreshDefaultCursor()
      return
    }
    // Default click — TA-style left-click semantics:
    //
    //   * Click on a unit with OTHER units already selected → attack
    //     (selected units engage the clicked unit; selection unchanged).
    //   * Click on a unit with NOTHING selected, OR click on a unit
    //     that IS already the sole selection → select that unit.
    //   * Click on EMPTY GROUND with units selected → MOVE to that
    //     point.  Default ground-click is now Move (previously a
    //     no-op); the standalone Shift+click force-fire path is gone
    //     — force-fire requires arming Primary/Secondary/Tertiary
    //     first, then clicking.  Shift+drag on empty ground starts
    //     the rectangle-select gesture instead (onLeftDragStart
    //     catches that before the click handler runs).
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
          this.#playSelectAck()
          this.#setStatus(`Selected ${picked.name} (HP ${picked.health}).`)
          return
        }
        // Attack — issueAttack arms #stepAttack on every selected
        // (non-self) unit and plays the ok1-bank ack so the engage
        // feels TA-native.  Selection stays put so the user can re-
        // issue commands without losing it.
        const n = this.issueAttack(picked)
        this.#setStatus(`Attack — ${n} unit(s) engaging ${picked.name} (HP ${picked.health}).`)
      } else if (sel.size === 0 || onlySelf) {
        this.scene.selectOnly(picked.id)
        this.#playSelectAck()
        this.#setStatus(`Selected ${picked.name} (HP ${picked.health}).`)
      } else {
        // sel.size > 0 and picked is IN the selection — promote to
        // sole selection so subsequent left-click-attack reads as
        // "this unit attacks that one" rather than "the group attacks
        // one of its own members".
        this.scene.selectOnly(picked.id)
        this.#playSelectAck()
        this.#setStatus(`Selected ${picked.name} (HP ${picked.health}).`)
      }
      return
    }
    // No unit under the cursor — plain ground-click with a live
    // selection issues a Move.  This replaces the old "no-op + Esc
    // to deselect" behaviour: clicking a destination is the most
    // common follow-up gesture after selecting a unit, so making
    // it the default beats the old "must arm Move first" flow.
    // Selection stays put (the user usually wants to chain orders).
    // No selection / no world projection (clicked the sky) → no-op.
    if (world && this.scene.selected.size > 0) {
      const n = this.issueMove(world)
      this.#setStatus(`Move — ${n} unit(s) heading to (${world[0].toFixed(0)}, ${world[2].toFixed(0)}).`)
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

  // #setStatus is the sandbox-internal alias for setStatus.  Many
  // call sites already use the leading-# form; keeping the alias
  // avoids a sweep across this file.
  #setStatus(text) { this.setStatus(text) }

  // ── View contract surface ─────────────────────────────────────────
  //
  // The view-helpers free functions and the inspector-refresh tick
  // read `view.engine` / `view.runtime` / `view.camera` /
  // `view.getSelectedUnits()` / `view.getInspectorMv()`.  Symmetric
  // with MvControls so one shared inspector loop drives both views.

  get engine() { return this.scene ? this.scene.engine : null }
  get runtime() { return this.scene ? this.scene.runtime : null }

  setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text
  }

  // getSelectedUnits — Sandbox's Command API (issueMove / stop /
  // trackFirstSelected) fans out over whatever this returns.  Pulls
  // every live unit currently in the selection set; dead / despawned
  // ids are filtered so commands don't try to ride a freed binding.
  getSelectedUnits() {
    if (!this.scene) return []
    const out = []
    for (const id of this.scene.selected) {
      const u = this.scene.unitById(id)
      if (u && !u.dead) out.push(u)
    }
    return out
  }

  // ── Command API ──────────────────────────────────────────────────
  //
  // These five entry points (issueMove / issueAttack / issueArmedFire /
  // stop / camera tracking) used to live on a shared BaseView; the
  // sandbox is now their only consumer.  MvControls has its own
  // single-unit equivalents inlined into its click handlers — the
  // multi-unit fan-out + formation centroid + ack-on-first-pursuer
  // shape below is sandbox-specific.

  // issueMove fans a Move order out to every currently selected unit.
  // Cleans the autonomous attackTarget so #stepAttack stops overriding
  // moveTarget; surgically clears attack-source weapon slots (manual
  // fire stays alive so the user can keep shooting while reposition-
  // ing — TA muscle-memory).  Plays the ok1-bank ack on the first
  // unit (single voice so a 10-unit selection doesn't fire a chorus).
  //
  // Formation move: when multiple units are selected, each unit walks
  // to (point + (unit.pos - centroid)) instead of stacking onto a
  // single tile.  Single-unit selection trivially has offset = 0.
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
  // aligned.  Skips self-targeting + plays the ok1-bank ack on the
  // first pursuer (single voice).
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

  // stop halts every selected unit through engine.stopUnits — the
  // canonical "drop move + attack + weapon slots + run StopMoving +
  // TargetCleared" entry point.  Returns the count for status text.
  stop() {
    const engine = this.engine
    const units = this.getSelectedUnits()
    if (!engine || !units.length) return 0
    return engine.stopUnits(units.map((u) => u.id))
  }

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

  // ── Unit acknowledgement sounds ───────────────────────────────────
  //
  // Thin pass-throughs to scene.playUnitSound* — the implementations
  // (and the per-unit/per-event debounce ledger) moved to scene-level
  // in Phase 2A so multiple panes sharing one scene don't each play
  // the same TA voice line.  The pass-throughs stay here so existing
  // view call sites (issueMove / issueAttack / selection ack) don't
  // change shape.

  playUnitSound(unit, eventKey) {
    return this.scene ? this.scene.playUnitSound(unit, eventKey) : false
  }

  playUnitSoundRandom(unit, eventKeys) {
    return this.scene ? this.scene.playUnitSoundRandom(unit, eventKeys) : false
  }

  // ── Scene-wide effect / audio aggregation ─────────────────────────
  //
  // Effects + Audio panels show EVERY live binding's particle pool /
  // audio entries — not just the focused unit's.  The aggregators
  // walk engine.units() and concatenate.  Cost: O(total alive
  // particles) per refresh tick (4 Hz inspector throttle) — trivial.

  // _ensureFxBufs reuses scratch typed-array buffers across refresh
  // ticks so the panel-open path doesn't allocate every 250 ms.
  // Auto-grows (doubling) when alive-particle population exceeds
  // capacity.  Per-instance so two open views don't fight over one
  // shared buffer.
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

  // aggregateAudioPool returns a virtual AudioPool that fans count()
  // + each(cb) across every binding's pool.  Entries are passed by
  // ref so the panel's progress bar reads the live <audio>'s
  // currentTime directly.  Snapshots the pool list at call time so a
  // unit despawn between count() and each() invocations can't crash
  // the panel.
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

  // getInspectorMv builds the proxy shape studio.js's
  // refreshMvInspectors panels consume.  When exactly ONE unit is
  // selected, the focused binding feeds the per-unit inspectors
  // (Scripts / Static Vars / Actions / Weapons).  With 0 / multiple
  // selected, a runtime-only stub keeps the runtime panels live.
  // Either way the Effects + Audio fields are wrapped to the scene-
  // wide aggregators via wrapCobWithAggregate — Object.create shields
  // the binding from being mutated (assigning straight onto the
  // binding would clobber its real .particles / .audio pools and
  // break particle emission inside the binding's own helpers).
  getInspectorMv() {
    const sel = this.scene ? this.scene.selected : null
    const focused = (sel && sel.size === 1)
      ? (this.scene.unitById([...sel][0]) || null)
      : null
    const focusedBinding = (focused && focused.binding) ? focused.binding : null
    const cob = wrapCobWithAggregate(this, focusedBinding || {
      runtime: this.runtime,
      unit: null,
      hasScript: () => false,
    })
    const mv = {
      camera: this.camera,
      renderer: this.renderer,
      cob,
      _focusedUnitId: focused ? focused.id : null,
    }
    // Per-unit port + damage + build% shims so the shared Controls
    // panel renderer (renderMvPortsPanel) drives the focused engine
    // unit directly.  Defined as getters/setters so slider edits flow
    // through to UnitInstance.cobPorts / .health / .buildPercent in
    // real time, and the inspector tick's refreshMvPortsLiveValues
    // observes the same fields the COB hooks read on the next get.
    if (focused) {
      mv.cobPorts = focused.cobPorts
      mv.unitMeta = focused.meta || null
      Object.defineProperty(mv, 'cobDamage', {
        enumerable: true, configurable: true,
        get: () => 100 - (focused.health | 0),
        set: (v) => { focused.health = Math.max(0, Math.min(100, 100 - (v | 0))) },
      })
      Object.defineProperty(mv, 'cobBuildPercent', {
        enumerable: true, configurable: true,
        get: () => focused.buildPercent | 0,
        set: (v) => {
          const pct = Math.max(0, Math.min(100, v | 0))
          focused.buildPercent = pct
          // Push into the binding so sparkle emit-rate tracks the
          // build without poking back through a global (Phase C
          // cleanup).
          if (focused.binding && typeof focused.binding.setBuildPercent === 'function') {
            focused.binding.setBuildPercent(pct)
          }
        },
      })
    }
    return mv
  }

  // _focusedUnitIdFromBinding finds the unit id whose binding matches
  // the focused one.  refreshMvInspectors tracks "did the focused
  // unit change" via this id so the Actions panel only rebuilds when
  // selection changes, not every tick.
  _focusedUnitIdFromBinding(binding) {
    if (!this.scene || !binding) return null
    for (const u of this.scene.units()) {
      if (u.binding === binding) return u.id
    }
    return null
  }

  dispose() {
    // Detach the orbit-controls listeners (wheel / pointer / key)
    // FIRST so any in-flight wheel event between dispose start and
    // canvas teardown can't fire requestRedraw against the about-to-
    // be-deleted GL context.
    if (typeof this._detachCamera === 'function') {
      try { this._detachCamera() } catch { /* ignore */ }
      this._detachCamera = null
    }
    if (this._resizeObserver) this._resizeObserver.disconnect()
    this._resizeObserver = null
    // Pause + silence the engine first so the cleanup below can't
    // race with an in-flight tick.  Pausing freezes weapons +
    // movement; setSilenced flips every binding's AudioPool into
    // paused mode so live `<audio>` elements stop emitting before
    // we tear down their owners.
    if (this.scene && this.scene.runtime && typeof this.scene.runtime.setPaused === 'function') {
      try { this.scene.runtime.setPaused(true) } catch { /* ignore */ }
    }
    if (this.scene && this.scene.engine && typeof this.scene.engine.setSilenced === 'function') {
      try { this.scene.engine.setSilenced(true) } catch { /* ignore */ }
    }
    // Hard-dispose every live unit's AudioPool so the `<audio>`
    // elements are released back to the browser.  setSilenced above
    // only PAUSES — the elements still hold their audio buffer
    // until dispose() drops the src.  Without this, closing a
    // sandbox tab in the middle of a firefight leaks audio nodes
    // that the GC can't reach for many seconds (the page's audio
    // context keeps them rooted while paused).
    const engine = this.scene && this.scene.engine
    if (engine && engine._units && typeof engine._units.values === 'function') {
      for (const u of engine._units.values()) {
        if (u && u.binding && u.binding.audio
            && typeof u.binding.audio.dispose === 'function') {
          try { u.binding.audio.dispose() } catch { /* ignore */ }
        }
      }
    }
    // disposeView tears down engine subs, smoke trails, and hotkeys
    // in one sweep.  Called BEFORE renderer.dispose() so any in-
    // flight RAF closures the engine handlers might fire into see
    // clean refs.
    disposeView(this)
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

