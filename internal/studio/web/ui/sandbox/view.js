// sandbox-view.js
//
// Multi-unit Sandbox viewer.  Sets up:
//
//   - A shared WebGL context + ModelRenderer (entity-mode)
//   - An OrbitCamera framed on the spawn ring
//   - A WasmSandboxScene backed by the Go/wasm sim, driving N units
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

import { ModelLoader } from '@kbot/game3d/model-loader'
import { ModelRenderer } from '@kbot/game3d/model-renderer'
import { OrbitCamera } from '@kbot/game3d/orbit-camera'
import { TextureCache } from '@kbot/game3d/texture-cache'
import { TAPalette } from '@kbot/game3d/palette'
import { WasmSandboxScene } from './wasm-scene.js'
import { WsFrameSource } from '../../engine/net/ws-source.js'
import { loadSelectionKeys, selectionKeys, keyTokenForEvent, commandClauses, unitMatchesToken } from './select-keys.js'
import { attachOrbitControls } from '@kbot/game3d/camera-controls'
import { stepSimSpeed } from '../common/sim-controls.js'
import { ArmedCursor } from '@kbot/game3d/armed-cursor'
import { ExplosionOverlay } from '@kbot/game3d/explosion-overlay'
import { teamColorForSide } from '@kbot/game3d/team-colors'
import { onEnhanceMeshChanged } from '@kbot/game3d/enhance-mesh'
import {
  wireHotkeys,
  wrapCobWithAggregate,
  appendParticleProjectiles,
  buildUnitMotion,
  disposeView,
} from '../common/view-helpers.js'
import { getReactUi } from '../host-context.js'
import {
  getGraphicsOptions, applyGraphicsOptionsToRenderer,
} from '../common/graphics-options-state.js'

export class SandboxView {
  constructor({ canvas, scene = null, statusEl, onModelLoaded, joinUrl = null } = {}) {
    // Optional shared scene — when supplied (the split-pane case), this
    // view observes that scene's engine + uses its smoke trails +
    // selection set, but draws into ITS OWN canvas/camera/renderer.
    // When null (the single-pane case), open() creates a fresh
    // WasmSandboxScene on first paint.  This is the inversion that lets
    // a tab host N viewports against one engine.
    this._externalScene = scene
    // joinUrl — when set, open() backs the scene with a WsFrameSource
    // connected to an authoritative host instead of an in-process wasm
    // world. Units then arrive through the host's snapshots and spawning
    // round-trips Spawn orders through the authority (see #spawnUnit).
    this._joinUrl = joinUrl
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
    // Per-unit-instance pose clones.  _localModels caches ONE Model per
    // unit TYPE (the uploaded geometry); but every same-type unit needs
    // its OWN animated piece tree or they all render the pose of
    // whichever instance was copied last that frame (5 PeeWees would
    // share one set of legs / turret / flares).  Each entry is a
    // cloneForInstance() of the type's base local model — fresh
    // move/rotate/visible/worldMatrix per piece, GPU buffers aliased by
    // reference (no geometry re-upload).  Keyed by engine unit id.
    this._localInstances = new Map() // unitId → { geomName, model } (per-instance pose; geomName re-keys on wreck swap)
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
    // Debug/automation handle: the most recently opened sandbox view. Test
    // harnesses (and the console) reach the live scene through it; never
    // read by product code.
    window.__kbotSandboxView = this
    // A wasm engine exit (Go panic) silently freezes every sim on the page —
    // make it loud so a "units stopped responding" report comes with the
    // captured stack (wasm-source.js stashes it on __KBOT_WASM_CRASH).
    if (!this._wasmCrashHandler) {
      this._wasmCrashHandler = () => {
        this.#setStatus('⚠ Engine crashed — sim is frozen. Stack captured in the console; reload the page to recover.')
      }
      window.addEventListener('kbot-wasm-crash', this._wasmCrashHandler)
    }
    if (!this.renderer) {
      const palette = await TAPalette.load()
      this.palette = palette
      const gl = this.canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false, alpha: false })
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
      // Seed this pane's renderer with the persisted Graphics Options
      // (shadows + effects + liquid sim) so every sandbox pane shares
      // the user's chosen look, and reseed the ribbon menu signal in
      // case prefs loaded after the ribbon module was first evaluated.
      applyGraphicsOptionsToRenderer(this.renderer)
      getReactUi()?.setSandboxGraphicsState?.(getGraphicsOptions())
      // Follow the shared Enhanced Mesh flag.  Each pane keeps its own
      // per-context model cache, so when the user flips the toggle this
      // pane drops + reloads its geometry — letting units already on the
      // field swap mesh live.  Subscribed once per pane; dispose() drops
      // it so a closed pane never reloads into a dead GL context.
      this._unsubEnhance = onEnhanceMeshChanged(() => this.reloadGeometryForEnhance())
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
        // Plain +/- step the sandbox runtime's playback rate (Shift+/-
        // zooms instead — handled inside camera-controls).
        onSimSpeedStep: (dir) => stepSimSpeed(dir),
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
        // Shared scenes are constructed at tab level (createSharedScene)
        // before any pane exists, so they have no TA palette — that loads
        // per-pane with the GL context above.  Backfill it here so the
        // scene's ballistic-particle colouring (cannon balls / plasma)
        // resolves a real RGB instead of rendering colourless / invisible.
        // The palette is the global TA palette (identical across panes), so
        // last-writer-wins is harmless.
        if (!this.scene.palette && this.palette) this.scene.palette = this.palette
        // Tab-level scenes are created before any pane, so they have no
        // model resolver yet — the resolver needs a pane's GL-bound
        // loader.  The first pane to open registers its loader;
        // setModelResolver is idempotent so siblings are no-ops.  Both
        // modes need it: join scenes hydrate adopted remote units through
        // it, and local scenes hydrate engine-spawned units (a builder's
        // buildee materializing at its site).  Without it u.model stays
        // null and the unit never renders.
        if (typeof this.scene.setModelResolver === 'function') {
          this.scene.setModelResolver((name) => this.loader.load(name).then((m) => m.cloneForInstance()))
        }
      } else {
        // Single-pane case — own the scene.  The constructor wires
        // 'fire' / 'death' / 'move-stop' subscriptions internally so
        // projectile spawn + death puffs + arrival voice all fire
        // exactly once per event regardless of observer count.  In join
        // mode the scene is backed by a WsFrameSource against the host;
        // it adopts units from the authority's snapshots and resolves
        // their geometry through this pane's loader.
        this.scene = new WasmSandboxScene({
          palette: this.palette,
          source: this._joinUrl ? new WsFrameSource({ url: this._joinUrl }) : null,
          // Every mode gets a model resolver: join scenes hydrate adopted
          // units through it, and local scenes need it for the corpse swap
          // (a destroyed unit's model is replaced by its wreck 3DO).
          modelResolver: (name) => this.loader.load(name).then((m) => m.cloneForInstance()),
        })
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
      // the per-frame onBeforeFrame hook below queries
      // engine.getSceneLight() and forwards the result to
      // this.renderer.setPulseLight.  The engine itself stays headless.
    }
    // ExplosionOverlay — DOM <img> layer that plays the real TA GAF
    // explosion sprites at impact (see /api/studio/weapon-fx).  Each
    // binding's _onParticleExpire path attempts to load the named
    // weapon's APNG and play it through this overlay; on miss the
    // synthetic particle cluster still fires.  Multi-pane: only one
    // overlay can be active per binding, so the first-attaching pane
    // wins — split panes share the visual through whichever canvas's
    // parent the overlay was appended to.
    if (!this._explosionOverlay && this.renderer && this.renderer.canvas) {
      this._explosionOverlay = new ExplosionOverlay(
        this.renderer.canvas,
        // project closure — pixel scale stays constant (4 px/wu) for
        // the MVP; a future pass can derive it from camera distance to
        // make the sprite track its real world-space footprint.
        (world) => {
          const p = this.renderer.worldToCanvas(world)
          if (!p) return null
          return { x: p.x, y: p.y, depth: 1, pxPerWU: 4 }
        }
      )
      // Install on every binding the engine has already spawned (case
      // where the view re-attaches to an existing scene), then keep up
      // by subscribing to future spawns.  Also attach a reference to
      // the renderer itself so weapon-driver.spawnProjectile can look
      // up registered fx.gaf bitmap sprites (rendertype=4 weapons).
      if (this.scene && this.scene.engine) {
        for (const u of this.scene.engine.units?.() || []) {
          if (u && u.binding) {
            if (!u.binding._explosionOverlay) u.binding._explosionOverlay = this._explosionOverlay
            if (!u.binding._renderer) u.binding._renderer = this.renderer
          }
        }
        this._explosionSpawnUnsub = this.scene.engine.on?.('spawn', (ev) => {
          const inst = ev && ev.unit
          if (inst && inst.binding) {
            if (!inst.binding._explosionOverlay) inst.binding._explosionOverlay = this._explosionOverlay
            if (!inst.binding._renderer) inst.binding._renderer = this.renderer
          }
        }) || null
      }
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
    // Per-pane per-frame visual work.  Sim stepping + cob-lifecycle
    // advance are SCENE concerns (mutate shared state once per
    // frame regardless of pane count) and live on the tab-owned
    // tick loop since the sandbox-tab-tick refactor — see
    // /ui/sandbox/tab.js's startTabTick wire.  This onBeforeFrame
    // hook runs just before the pane's draw() for view-only per-paint
    // work: render-interpolation sampling, this pane's dynamic light
    // pulse, this pane's entities array, this pane's shift-preview
    // overlay, this pane's armed cursor.  Pre-draw (not post) so the
    // model + tracking camera read one frame-correct pose together.
    this.renderer.onBeforeFrame = () => {
      // Sample render interpolation for THIS frame's instant first, so both
      // the entity transforms built below and the tracking camera (which
      // reads the unit position inside draw()) see one coherent, frame-
      // correct pose.  Doing this pre-draw is what keeps a tracked aircraft
      // from stuttering on displays whose refresh rate isn't a clean multiple
      // of the 40 Hz sim — the sim still steps on its own cadence, but every
      // painted frame shows the exact interpolated position/heading for the
      // moment it's displayed.
      if (this.scene && typeof this.scene.interpolate === 'function') {
        this.scene.interpolate()
      }
      // Pull-side scene lights: ask the engine for the brightest live
      // light-emitting particles across all units and push them into THIS
      // renderer's dynamic-light slots.  Several at once so each concurrent
      // shot (a battleship's volley) casts its own glow rather than only the
      // first.  Each pane reads independently so per-pane camera framing
      // computes each light's NDC position correctly.
      if (this.scene && this.scene.engine && typeof this.renderer.setPulseLights === 'function') {
        const lights = typeof this.scene.engine.getSceneLights === 'function'
          ? this.scene.engine.getSceneLights()
          : (() => { const l = this.scene.engine.getSceneLight && this.scene.engine.getSceneLight(); return l ? [l] : [] })()
        this.renderer.setPulseLights(lights)
      }
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
      // Health bars: the hovered unit always shows one; the backquote
      // toggle adds every selected unit. Screen-space 2D overlay so no
      // GL state is involved.
      this.#drawHealthBars()
    }
    this.#wirePointer()
    this.#refreshDefaultCursor()
    this.#setStatus('Sandbox ready — click "Spawn Unit" to add a unit to the field.')
    if (this.onModelLoaded) this.onModelLoaded(null, null)
  }

  // #spawnUnit introduces a unit, hiding the local/join split: in local
  // mode it inserts directly via scene.addUnit and returns the adapter; in
  // join mode it round-trips a Spawn order through the authority and returns
  // null (the adapter materializes asynchronously when the host's snapshot
  // first reports the new unit, with geometry resolved via modelResolver).
  async #spawnUnit({ name, model, cobScript, x, z, headingRad, side }) {
    if (this.scene && this.scene._join) {
      await this.scene.spawnRemote({ name, x, z, headingRad, side })
      return null
    }
    return this.scene.addUnit({ name, model, cobScript, x, z, headingRad, side })
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
      // addUnit introduces the unit into the wasm world and resolves once its
      // FBI/weapon meta + COB bytes are loaded (the sim runs Create itself on
      // spawn, so there's no JS-side lifecycle kick here).  The shared weapon
      // driver reads inst.meta.weapons to draw proper TA projectiles.
      const inst = await this.#spawnUnit({ name, model, cobScript, x, z, headingRad, side })
      this.#refreshEntities()
      this.#setStatus(`Spawned ${name} at (${x.toFixed(0)}, ${z.toFixed(0)}) — ${this.scene.unitCount()} unit${this.scene.unitCount() === 1 ? '' : 's'} on field.`)
      return inst
    } catch (err) {
      this.#setStatus(`Spawn failed: ${err.message || err}`)
      return null
    }
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

  // beginBuildPlacement arms the placement ghost as a CONSTRUCTION SITE
  // picker for a mobile builder: the commit click issues a Build order (the
  // builder walks into builddistance and raises the unit gradually) instead
  // of an instant spawn. Same ghost / cancel mechanics as beginPlacement.
  async beginBuildPlacement(name, builder) {
    if (!builder) return false
    const ok = await this.beginPlacement(name, { side: builder.side | 0 })
    if (ok && this._placement) {
      this._placement.buildFor = builder.id
      this.#setStatus(`Placing ${name} — click a site for ${builder.name || 'the builder'} to build, Esc to cancel.`)
    }
    return ok
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
    const onUp = async (ev) => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      try { canvas.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
      const drag = this._placementDrag
      this._placementDrag = null
      const p = this._placement
      // Resolve the placement state SYNCHRONOUSLY, before the awaited spawn
      // below yields the event loop. The browser fires the synthetic `click`
      // immediately after `pointerup` — if we cleared _placement and armed
      // _suppressNextClick only after the await, #onClick would run first, still
      // see _placement set and the suppress flag unset, and commit a duplicate
      // spawn at the same spot (the double-spawn bug).
      this._suppressNextClick = true
      // Single-shot placement unless Shift held — TA convention is
      // one spawn per Build click; chain-spawn (shift) is the power-
      // user shortcut for dropping multiple of the same unit fast.
      if (!ev.shiftKey) {
        this._placement = null
      }
      this.#refreshEntities()
      this.#refreshDefaultCursor()
      // Commit the spawn — pointer-down position, drag-derived heading.  The
      // wasm world runs the unit's Create script itself on spawn.
      await this.#spawnUnit({
        name: p.name,
        model: p.model,
        cobScript: p.cobScript,
        x: startWorld[0],
        z: startWorld[2],
        headingRad: drag ? drag.headingRad : 0,
        side: p.side | 0,
      })
      this.#setStatus(`Spawned ${p.name} at (${startWorld[0].toFixed(0)}, ${startWorld[2].toFixed(0)}) — ${this.scene.unitCount()} unit${this.scene.unitCount() === 1 ? '' : 's'} on field.`)
      this.#refreshEntities()
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
  // #applyDragRectSelection resolves a finished marquee. With nothing
  // selected it replace-selects the boxed units (TA convention). With a
  // live selection it EXPANDS — boxed friendlies join the set — unless the
  // selection is a single team and the box holds only enemies, in which
  // case the gesture is a mass attack: every selected unit chains attack
  // orders on all boxed enemies, nearest-first from its own position.
  #applyDragRectSelection(x0, y0, x1, y1) {
    const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) }
    const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) }
    if (!this.scene) return
    const rect = this.canvas.getBoundingClientRect()
    const boxed = []
    for (const u of this.scene.units()) {
      if (u.dead) continue
      const screen = this.#worldToScreen(u.pos.x, u.pos.y + 12, u.pos.z)
      if (!screen) continue
      const vx = screen[0] + rect.left
      const vy = screen[1] + rect.top
      if (vx >= lo.x && vx <= hi.x && vy >= lo.y && vy <= hi.y) {
        boxed.push(u)
      }
    }
    const selUnits = this.getSelectedUnits()
    if (selUnits.length > 0 && boxed.length > 0) {
      const sides = new Set(selUnits.map((u) => u.side | 0))
      const team = sides.size === 1 ? [...sides][0] : null
      const enemies = boxed.filter((u) => team !== null && (u.side | 0) !== team)
      if (team !== null && enemies.length === boxed.length) {
        // Single-team selection over an all-enemy box → attack chain.
        // queueAttack applies immediately on an idle unit and appends on
        // a busy one, so the whole box lands in each unit's queue
        // nearest-target-first.
        for (const a of selUnits) {
          const sorted = [...enemies].sort((p, q) =>
            Math.hypot(p.pos.x - a.pos.x, p.pos.z - a.pos.z)
            - Math.hypot(q.pos.x - a.pos.x, q.pos.z - a.pos.z))
          for (const t of sorted) {
            if (typeof a.queueAttack === 'function') a.queueAttack(t)
            else a.attackTarget = t
          }
        }
        this.playUnitSoundRandom(selUnits[0], ['ok1', 'ok2', 'ok3', 'ok4', 'ok5'])
        this.#setStatus(`Attack chain — ${selUnits.length} unit(s) engaging ${enemies.length} target(s), nearest first.`)
        return
      }
      // Mixed or friendly box → expand the selection with the boxed
      // friendlies (enemies in a mixed box are ignored — selecting the
      // opposition alongside your own units is never what's meant).
      let added = 0
      for (const u of boxed) {
        if (this.scene.selected.has(u.id)) continue
        if (team !== null && (u.side | 0) !== team) continue
        this.scene.selectAdd(u.id)
        added++
      }
      this.#setStatus(added > 0
        ? `Selection expanded — ${added} more unit${added === 1 ? '' : 's'} (${this.scene.selected.size} total).`
        : `Selection unchanged (${this.scene.selected.size} unit${this.scene.selected.size === 1 ? '' : 's'}).`)
      if (added > 0) this.#playSelectAck()
      return
    }
    // No prior selection — replace.
    this.scene.selectClear()
    for (const u of boxed) this.scene.selectAdd(u.id)
    if (boxed.length > 0) {
      this.#setStatus(`Selected ${boxed.length} unit${boxed.length === 1 ? '' : 's'}.`)
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
      // Clipping container: positioned + sized to THIS pane's canvas
      // every frame (below) with overflow:hidden so move / attack / path
      // glyphs can never spill onto the ribbon, other panes, or off the
      // window — a target projected off-screen (zoomed out, behind a
      // sibling pane) is clipped at the canvas edge instead of floating
      // over the chrome.  Child glyphs are absolutely positioned in
      // host-local (canvas) coords.
      host.style.cssText = 'position: fixed; pointer-events: none; z-index: 9998; overflow: hidden;'
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
    // cssText-baked background URLs bypass the page's src shim, so the
    // workspace prefix must be applied by hand or the glyphs 404 under
    // /workspaces/<id>/ and the whole overlay renders as bare badges.
    const cursorUrl = (kind) => `${window.__WS_BASE__ || ''}/api/studio/cursor/${kind}`
    const ensureEl = (kind, badge = null) => {
      let entry
      if (elIdx < pool.length) {
        entry = pool[elIdx]
        if (entry.kind !== kind) {
          // Re-skin the existing element — cheaper than re-creating.
          entry.el.style.backgroundImage = `url('${cursorUrl(kind)}')`
          entry.kind = kind
        }
        entry.el.style.display = ''
      } else {
        const el = document.createElement('div')
        el.style.cssText = [
          'position: absolute',
          'width: 32px', 'height: 32px',
          'margin-left: -16px', 'margin-top: -16px',
          'background-size: contain',
          'background-repeat: no-repeat',
          'pointer-events: none',
          'image-rendering: pixelated',
          `background-image: url('${cursorUrl(kind)}')`,
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
          entry.el.style.position = 'absolute' // host-local positioning model
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
    // Park the clipping host over THIS pane's canvas so overflow:hidden
    // trims any glyph that projects outside the viewport.
    const canvasRect = this.canvas.getBoundingClientRect()
    host.style.left = canvasRect.left + 'px'
    host.style.top = canvasRect.top + 'px'
    host.style.width = canvasRect.width + 'px'
    host.style.height = canvasRect.height + 'px'
    // #worldToScreen already returns canvas-relative pixels, which are
    // exactly host-local coords now that the host sits on the canvas —
    // so no client-space offset is added (the glyphs are absolutely
    // positioned children of the host).
    const projW = (x, y, z) => {
      const screen = this.#worldToScreen(x, y, z)
      if (!screen) return null
      return [screen[0], screen[1]]
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
    // Cap how many selected units get a destination / path overlay.  A
    // large selection (a 100-unit army) would otherwise draw 100 end-
    // state markers + 100 six-dot trails + attack glyphs — unreadable
    // noise and a lot of per-frame DOM.  Show only the first few live
    // units; the move/attack order still applies to the WHOLE selection,
    // this just trims the visual preview.
    const MAX_PREVIEW_UNITS = 12
    let previewShown = 0
    for (const id of this.scene.selected) {
      if (previewShown >= MAX_PREVIEW_UNITS) break
      const u = this.scene.unitById(id)
      if (!u || u.dead) continue
      previewShown++
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
      // Queued follow-ups — the shift-queued order chain the sim
      // reports on each snapshot.  Numbered markers (the active order
      // is implicitly #1) connected by sparse static dots so the full
      // planned path reads at a glance.  Attack entries sit on their
      // live target; dead/despawned targets are skipped (the sim will
      // skip them on advance too).
      if (Array.isArray(u.queue) && u.queue.length) {
        let prevX = u.moveTarget ? u.moveTarget.x : u.pos.x
        let prevZ = u.moveTarget ? u.moveTarget.z : u.pos.z
        for (let qi = 0; qi < u.queue.length; qi++) {
          const q = u.queue[qi]
          let qx, qz, kind
          if (q.kind === 2) {
            const qt = this.scene.unitById(q.targetId)
            if (!qt || qt.dead) continue
            qx = qt.pos.x; qz = qt.pos.z; kind = 'cursorattack'
          } else {
            qx = q.x; qz = q.z; kind = 'cursormove'
          }
          const qps = projW(qx, 0, qz)
          if (qps) {
            const el = ensureEl(kind, String(qi + 2))
            resetGlyph(el)
            el.style.opacity = '0.75'
            el.style.left = qps[0] + 'px'
            el.style.top  = qps[1] + 'px'
          }
          const dx = qx - prevX, dz = qz - prevZ
          const dist = Math.hypot(dx, dz)
          if (dist > 60) {
            const N = Math.min(5, Math.floor(dist / 60))
            for (let i = 1; i <= N; i++) {
              const t = i / (N + 1)
              const dps = projW(prevX + dx * t, 0, prevZ + dz * t)
              if (!dps) continue
              const dot = ensureEl('pathicon')
              dot.style.left = dps[0] + 'px'
              dot.style.top  = dps[1] + 'px'
              dot.style.opacity = '0.4'
              dot.style.width = '14px'
              dot.style.height = '14px'
              dot.style.marginLeft = '-7px'
              dot.style.marginTop = '-7px'
            }
          }
          prevX = qx; prevZ = qz
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
    // Airstrike glyph when the armed slot's weapon is a `dropped` bomb on
    // any selected unit — same gesture (click ground to bomb a point) but
    // the cursor reads as an air-attack reticle instead of the generic
    // crosshair.  Checks the FIRST selected unit; mixed-loadout selections
    // (some bombers, some non) show the airstrike glyph if any qualify.
    const slotIdxMap = { primary: 0, secondary: 1, tertiary: 2 }
    const slotIdx = slotIdxMap[this._pendingCmd]
    let isAirstrike = false
    if (slotIdx != null && hasSelection) {
      for (const id of sel) {
        const u = this.scene.unitById(id)
        const w = u && u.meta && u.meta.weapons && u.meta.weapons[slotIdx]
        if (w && w.dropped) { isAirstrike = true; break }
      }
    }
    this._armedCursor.setKind(isAirstrike ? 'airstrike' : null)
  }

  // setPendingCommand — called by the controls UI when the user
  // clicks Move / Attack / Primary / Secondary / Tertiary.  Next
  // canvas click consumes it.  Drives the shared ArmedCursor
  // overlay so the cursor visually matches what the unit editor
  // shows for the same gesture.  Passing null disarms.
  //
  // Accepted slots:
  //   'move'                    — next click sets move target
  //   'patrol'                  — clicks append looping patrol waypoints
  //                               (stays armed so a route lays click by
  //                               click; Esc disarms)
  //   'attack'                  — generic primary-weapon attack
  //   'primary' / 'secondary' / 'tertiary'
  //                             — fire the named weapon slot at the
  //                               next click target (matches the
  //                               unit-editor's Controls panel
  //                               arm-then-target semantics).
  setPendingCommand(cmd) {
    const valid = (cmd === 'move' || cmd === 'attack' || cmd === 'patrol' ||
                   cmd === 'load' || cmd === 'unload' ||
                   cmd === 'primary' || cmd === 'secondary' || cmd === 'tertiary')
    // Load/Unload only make sense with a transport in the selection.
    if ((cmd === 'load' || cmd === 'unload') && this.#selectedTransports().length === 0) {
      this._pendingCmd = null
      this.#refreshDefaultCursor()
      this.#setStatus(`${cmd[0].toUpperCase() + cmd.slice(1)} — no transport selected.`)
      return
    }
    // A weapon slot can only be armed when at least one selected unit actually
    // carries a weapon in that slot.  Firing an empty slot is a no-op in the
    // engine, so arming it (and showing its cursor) would be a lie — refuse and
    // tell the user why instead of letting them paint a dead reticle around.
    const slotIdxMap = { attack: 0, primary: 0, secondary: 1, tertiary: 2 }
    if (valid && cmd in slotIdxMap && !this.#anySelectedHasWeaponSlot(slotIdxMap[cmd])) {
      this._pendingCmd = null
      this.#refreshDefaultCursor()
      const label = cmd[0].toUpperCase() + cmd.slice(1)
      this.#setStatus(`${label} — no selected unit has that weapon.`)
      return
    }
    this._pendingCmd = valid ? cmd : null
    // #refreshDefaultCursor drives the ArmedCursor overlay's
    // armed+ambient slot pair — armed wins over ambient so the cmd
    // glyph trumps the idle "select" / "normal" hover state without
    // needing a separate code path here.
    this.#refreshDefaultCursor()
    if (this._pendingCmd) {
      const what = (cmd === 'move') ? 'a destination'
        : (cmd === 'patrol') ? 'patrol waypoints (Esc to finish)'
          : (cmd === 'load') ? 'a unit to pick up'
            : (cmd === 'unload') ? 'a drop point'
              : 'a target unit'
      const label = cmd[0].toUpperCase() + cmd.slice(1)
      this.#setStatus(`${label} — click ${what}.`)
    }
  }

  // #anySelectedHasWeaponSlot reports whether any currently-selected, living
  // unit carries a populated weapon in the given slot index.  A populated slot
  // is one whose meta entry has a weapon name — the same predicate the Controls
  // panel uses to enable its per-slot buttons, so arming and UX stay in sync.
  #anySelectedHasWeaponSlot(slotIdx) {
    if (slotIdx == null) return false
    for (const id of this.scene.selected) {
      const u = this.scene.unitById(id)
      if (!u || u.dead) continue
      const w = u.meta && u.meta.weapons && u.meta.weapons[slotIdx]
      if (w && w.name) return true
    }
    return false
  }

  // reloadGeometryForEnhance reacts to an Enhanced Mesh toggle by
  // dropping this pane's per-type model cache (and the per-instance pose
  // clones that alias its GPU buffers) so #refreshEntities lazy-reloads
  // every on-field unit under the new flag.  Pose keeps flowing from the
  // engine bindings — the fill only adds primitives, never pieces, so
  // the reloaded piece trees stay lockstep-compatible with the bindings
  // and animation survives the swap.
  reloadGeometryForEnhance() {
    if (!this.renderer) return
    const gl = this.renderer.gl
    // Drop instance clones FIRST: they alias the base models' VBOs by
    // reference, so the bases must not be deleted while a clone still
    // points at them.
    this._localInstances.clear()
    for (const m of this._localModels.values()) {
      try { m.dispose(gl) } catch { /* ignore */ }
    }
    this._localModels.clear()
    this._loadingModels.clear()
    // A ghost placement in flight cached its model in the now-cleared
    // map and renders it directly.  Null it so the ghost simply skips a
    // frame, then reload under the new flag.
    if (this._placement && this._placement.name) {
      const name = this._placement.name
      this._placement.model = null
      this.loader.load(name).then((m) => {
        this._localModels.set(name, m)
        if (this._placement && this._placement.name === name) this._placement.model = m
        if (this.renderer) this.renderer.requestRedraw()
      }).catch(() => { /* ignore — ghost just stays hidden */ })
    }
    this.#refreshEntities()
    this.renderer.requestRedraw()
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

  // #copyPieceState walks two Piece trees in lockstep (DFS) and
  // copies the binding-driven animated channels (move / rotate /
  // visible) from `src` into `dst`.  Both trees are built from the
  // same loader JSON so the child orders match by construction —
  // no by-name lookup needed.  Called per-entity per-frame in
  // #refreshEntities to make this pane's local-context model reflect
  // the binding's authoritative pose (the binding only writes the
  // engine-side instance model, not our per-pane GL copy).
  #copyPieceState(src, dst) {
    if (!src || !dst) return
    dst.move[0] = src.move[0]
    dst.move[1] = src.move[1]
    dst.move[2] = src.move[2]
    dst.rotate[0] = src.rotate[0]
    dst.rotate[1] = src.rotate[1]
    dst.rotate[2] = src.rotate[2]
    dst.visible = src.visible
    const sc = src.children
    const dc = dst.children
    const n = Math.min(sc.length, dc.length)
    for (let i = 0; i < n; i++) this.#copyPieceState(sc[i], dc[i])
  }

  #refreshEntities() {
    if (!this.renderer || !this.scene) return
    const entities = []
    // Live ids this frame — used to prune per-instance pose clones for
    // units that have despawned (otherwise the clone map grows without
    // bound across a long session).
    const liveIds = new Set()
    for (const u of this.scene.units()) {
      if (!u.model) continue
      // Pre-warm this pane's GL context with the unit's model-weapon projectile
      // meshes (missiles / rockets / bombs) so the 3DO is uploaded before the
      // shot flies.  A projectile lives in scene.projectiles() only for its
      // brief flight; if the mesh isn't already cached, the lazy load in the
      // projectile loop below never lands in time and the projectile never
      // draws.  #ensureLocalModel is idempotent, so this is a cheap Map probe
      // once the meshes are in.
      const weapons = u.meta && u.meta.weapons
      if (weapons) {
        for (const w of weapons) {
          if (w && w.model && !w.beamWeapon) this.#ensureLocalModel(w.model)
        }
      }
      // GL-context substitution — each pane's renderer can only draw
      // models whose VBOs live in its own context.  If the unit's TYPE
      // geometry was spawned/loaded by US, _localModels has the base
      // Model.  Otherwise the unit was spawned in a sibling pane: kick
      // off a lazy load (no-op when already in flight) and skip this
      // entity for the current frame — it'll appear next tick once the
      // load completes.  Cost: a single network hit per (model name ×
      // pane) the first time the sibling pane observes a foreign unit.
      // Death resolution: a corpsetype-3 kill leaves nothing to draw; a
      // wreck swap re-keys the entity's geometry to the corpse feature's
      // 3DO (the engine-side u.model stays the unit's pose tree, so the
      // wreck renders in its authored static pose).
      if (u.corpseHidden) continue
      const geomName = u.wreckName || u.name
      const baseModel = this._localModels.get(geomName)
      if (!baseModel) {
        this.#ensureLocalModel(geomName)
        continue
      }
      // Per-instance pose isolation — _localModels caches ONE Model per
      // unit type, so feeding it straight to every same-type entity
      // makes them all render whichever instance's pose was copied last
      // this frame (legs / turret / flares all in lockstep, animations
      // appear "dead" for every unit but the last).  Give each engine
      // unit its own cloneForInstance() of the type's base model — own
      // animated piece tree, GPU buffers shared by reference — so the
      // pose copy below lands in an isolated tree per unit.
      let inst = this._localInstances.get(u.id)
      if (!inst || inst.geomName !== geomName) {
        // First sighting, or the geometry was re-keyed (wreck swap): build
        // a fresh per-instance clone of the new base model.
        inst = { geomName, model: baseModel.cloneForInstance() }
        this._localInstances.set(u.id, inst)
      }
      const localModel = inst.model
      liveIds.add(u.id)
      // Pose-sync — copy binding-driven animation state (move /
      // rotate / visible) from u.model (which the binding writes
      // each tick via _sync) into this unit's local-context clone.
      // Same tree-shape across both so DFS lockstep is safe.  Without
      // this the unit renders in its authored static pose forever
      // (legs locked, turret straight, weapon flares cosmetic
      // panels never hidden) even though the binding runtime ticks
      // are correctly advancing the source pieces.  Pose copy
      // applies to BOTH panes — even the spawning pane's local
      // cache stores the load-time Model, not the instModel clone
      // the engine animates, so without the copy the spawning pane
      // is also static.
      // A wreck has no COB pose to mirror — its 3DO renders as authored.
      if (!u.wreckName) this.#copyPieceState(u.model.root, localModel.root)
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
        // Inspector hover highlight — the Sync Diagnostics panel flags the
        // unit its hovered row points at, so the renderer outlines it.
        highlight: this.scene.isUnitHighlighted ? this.scene.isUnitHighlighted(u.id) : false,
        // id + meta let the renderer apply the per-unit locomotion pose
        // overlay (hovercraft wobble, aircraft bank) in the sandbox, keyed by
        // a stable id with the unit's FBI flags.
        id: u.id,
        meta: u.meta || null,
        // teamColor is the hue-shift modulator for the main shader
        // (null = no recolour = keep authored ARM blue); `side` is
        // the raw faction index so the Phase 3 impostor batch can
        // resolve a concrete RGB tuple (including the ARM-blue
        // case) via displayRgbForSide.
        side: u.side | 0,
        teamColor: teamColorForSide(u.side),
      })
    }
    // Prune pose clones for despawned units.  Clones share GPU buffers
    // by reference (isInstance), so there's no VBO to release — just
    // drop the piece-tree ref so the map doesn't accumulate dead units
    // across a long sandbox session.
    if (this._localInstances.size > liveIds.size) {
      for (const id of this._localInstances.keys()) {
        if (!liveIds.has(id)) this._localInstances.delete(id)
      }
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
    // In-flight model-projectiles (missiles / rockets / bombs).  The engine
    // owns their flight (see projectiles.js); we draw the weapon's real 3DO
    // mesh oriented along the velocity — heading + π matches the unit X-flip
    // convention, and pitch tilts the nose along the climb/dive.  Models load
    // lazily into the shared _localModels cache (keyed by the TDF model name);
    // a projectile skips a frame until its mesh is in.
    for (const proj of this.scene.projectiles()) {
      if (!proj.model) continue
      const pm = this._localModels.get(proj.model)
      if (!pm) { this.#ensureLocalModel(proj.model); continue }
      entities.push({
        model: pm,
        transform: {
          x: proj.pos.x, y: proj.pos.y, z: proj.pos.z,
          // Orientation derivation.  Empirically (from the armmhmsl.3do
          // bounds: z ∈ [-19.25, 2.5] — the body extends into -Z with the
          // small pointy nose at +Z) the missile is authored facing +Z,
          // unlike units which are authored facing -Z and so need the +π
          // yaw compensator.  The renderer applies Rx(pitch) FIRST in
          // object space then Ry(heading), so for a model whose initial
          // forward is (0, 0, +1) the final forward direction works out to
          //   (cos(pitch) sin(heading), -sin(pitch), cos(pitch) cos(heading))
          // and we want this to equal the velocity direction
          //   (cos(p) sin(h),  sin(p),  cos(p) cos(h))
          // with p = proj.pitch and h = proj.heading.  Solving:
          //   pitch_render   = -proj.pitch
          //   heading_render = +proj.heading       (no π flip)
          // The π flip used for units was the cause of the missile flying
          // arse-first after pitching over: it rotated the nose 180° on
          // the yaw axis, which only became visually obvious once the
          // missile had transitioned out of the vertical pose.
          headingRad: proj.heading,
          pitchRad:   -proj.pitch,
        },
        id: 'proj-' + proj.id,
        // Inspector hover highlight — the Sync Diagnostics Projectiles tab
        // outlines the shot its hovered row points at.
        highlight: this.scene.isProjoHighlighted ? this.scene.isProjoHighlighted(proj.id) : false,
        // Flagged so the LOD classifier divides its thresholds by
        // PROJECTILE_LOD_MULTIPLIER for this entity — bombs / missiles have
        // a much smaller bounding sphere than the units that fire them, so
        // without the boost they pop to the impostor dot mid-flight.
        isProjectile: true,
      })
    }
    this.renderer.setEntities(entities)
  }

  // ── Game-defined selection hotkeys ─────────────────────────────────
  //
  // keys.tdf (TA:K ships one; a TA mod may) or the game adapter's default
  // table maps key chords onto SelectUnits-family commands whose tokens
  // reference unit attributes: literal FBI Category membership (BALLISTIC,
  // Monarch, TA's CTRL_B opt-ins) plus derived classes (BUILDER, FACTORY,
  // FLY). Non-selection verbs (UnitCommand, squads, save/load) belong to
  // other layers and fall through untouched.
  #handleSelectionKey(e) {
    const keys = selectionKeys()
    if (!keys || !this.scene) return false
    const token = keyTokenForEvent(e)
    if (!token) return false
    const cmd = keys[token]
    if (!cmd) return false
    let handled = false
    for (const { verb, args } of commandClauses(cmd)) {
      switch (verb) {
        case 'selectallunits':
          handled = this.#selectWhere(() => true, false, 'live') || handled
          break
        case 'selectunits':
          handled = this.#selectWhere((u) => unitMatchesToken(u, args[0]), false, args[0]) || handled
          break
        case 'selectunitsadd':
          handled = this.#selectWhere((u) => unitMatchesToken(u, args[0]), true, args[0]) || handled
          break
        case 'selectallunitsselectedtype': {
          const names = new Set([...this.scene.selected]
            .map((id) => this.scene.unitById(id))
            .filter((u) => u && !u.dead)
            .map((u) => u.name))
          if (names.size === 0) break
          handled = this.#selectWhere((u) => names.has(u.name), false, 'same-type') || handled
          break
        }
        case 'selectunitsonscreen':
          handled = this.#selectWhere((u) => this.#unitOnScreen(u), false, 'on-screen') || handled
          break
        case 'trackunit':
          // Secondary clause ("SelectUnits Monarch, TrackUnit") — only acts
          // when a selection clause in the same binding already fired.
          if (handled) this.trackFirstSelected()
          break
        default:
          break
      }
    }
    if (handled) e.preventDefault()
    return handled
  }

  // #selectWhere replaces (or, with add, extends) the selection with every
  // live, completed unit matching pred. Returns true whenever the command
  // was meaningful — even a zero-match select consumes its key.
  #selectWhere(pred, add, label) {
    let n = 0
    if (!add) this.scene.selectClear()
    for (const u of this.scene.units()) {
      if (!u || u.dead) continue
      if (u.buildPercent != null && u.buildPercent < 100) continue
      if (!pred(u)) continue
      this.scene.selectAdd(u.id)
      n++
    }
    if (n > 0) this.#playSelectAck()
    this.#setStatus(n > 0
      ? `Selected ${n} ${label} unit${n === 1 ? '' : 's'}.`
      : `No ${label} units on the field.`)
    return true
  }

  // #unitOnScreen reports whether the unit projects inside this pane's
  // canvas — the SelectUnitsOnScreen scope.
  #unitOnScreen(u) {
    const s = this.#worldToScreen(u.pos.x, u.pos.y, u.pos.z)
    if (!s) return false
    const r = this.canvas.getBoundingClientRect()
    return s[0] >= 0 && s[1] >= 0 && s[0] <= r.width && s[1] <= r.height
  }

  #wirePointer() {
    if (this._pointerWired) return
    this._pointerWired = true
    // Resolve the game's key table up front so the first chord lands.
    loadSelectionKeys()
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
      // Control groups, TA convention: Ctrl+1..9 assigns the current
      // selection to a numbered group; the bare digit recalls it. Stored
      // per view; dead units fall out on recall. Checked BEFORE the
      // modifier gate (assignment needs Ctrl held).
      const digit = /^[1-9]$/.test(e.key) ? e.key : null
      if (digit && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault()
        if (!this._ctrlGroups) this._ctrlGroups = new Map()
        const ids = this.scene ? [...this.scene.selected] : []
        if (ids.length === 0) {
          this._ctrlGroups.delete(digit)
          this.#setStatus(`Group ${digit} cleared.`)
        } else {
          this._ctrlGroups.set(digit, ids)
          this.#setStatus(`Group ${digit} set — ${ids.length} unit${ids.length === 1 ? '' : 's'}.`)
        }
        return
      }
      // Ctrl+D toggles self-destruct on the selection: a 5-second fuse with
      // a countdown over each unit, ending in its selfdestructas blast.
      // Pressing again disarms. Checked before the modifier gate (and ahead
      // of the selection hotkeys — keys.tdf maps CTRL_D to the same verb).
      if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey) && !e.altKey) {
        const ids = this.getSelectedUnits().map((u) => u.id)
        if (ids.length > 0 && this.scene.source.selfDestruct) {
          e.preventDefault()
          this.scene.source.selfDestruct(ids)
          this.#setStatus(`Self-destruct toggled on ${ids.length} unit${ids.length === 1 ? '' : 's'} — Ctrl+D again to disarm.`)
          return
        }
      }
      // Game-defined selection hotkeys (keys.tdf, or the adapter's default
      // table) — SelectUnits <token> and friends. Tried before the modifier
      // gate because most bindings are Ctrl+letter chords.
      if (this.#handleSelectionKey(e)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (digit && !e.shiftKey) {
        const ids = (this._ctrlGroups && this._ctrlGroups.get(digit)) || []
        const live = ids.filter((id) => {
          const u = this.scene && this.scene.unitById(id)
          return u && !u.dead
        })
        if (live.length === 0) {
          if (ids.length > 0) this.#setStatus(`Group ${digit} is empty (units lost).`)
          return
        }
        e.preventDefault()
        this.scene.selectClear()
        for (const id of live) this.scene.selectAdd(id)
        this.#playSelectAck()
        this.#setStatus(`Group ${digit} — ${live.length} unit${live.length === 1 ? '' : 's'} selected.`)
        return
      }
      // P arms Patrol — subsequent clicks lay looping waypoints (the
      // keys.tdf "UnitCommand Patrol" binding; Esc finishes the route).
      if ((e.key === 'p' || e.key === 'P') && this.scene && this.scene.selected.size > 0) {
        e.preventDefault()
        this.setPendingCommand('patrol')
        return
      }
      // L arms Load (transport picks up the next-clicked unit); U arms
      // Unload (cargo sets down at the next-clicked ground point). Both
      // refuse via setPendingCommand when no transport is selected.
      if ((e.key === 'l' || e.key === 'L') && this.scene && this.scene.selected.size > 0) {
        e.preventDefault()
        this.setPendingCommand('load')
        return
      }
      if ((e.key === 'u' || e.key === 'U') && this.scene && this.scene.selected.size > 0) {
        e.preventDefault()
        this.setPendingCommand('unload')
        return
      }
      // Backquote toggles the persistent health-bar layer for selected
      // units (hover bars always show). Bespoke rather than wireHotkeys
      // because it must work with an empty selection too.
      if (e.key === '`') {
        e.preventDefault()
        this._healthBars = !this._healthBars
        this.#setStatus(this._healthBars
          ? 'Health bars on — shown beneath selected units (` to hide).'
          : 'Health bars off — hover a unit to inspect its health.')
        return
      }
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
    // Shift-right-click queues the order behind the unit's current one —
    // the classic RTS waypoint/target chain.
    const queued = !!e.shiftKey
    if (hit && !this.scene.selected.has(hit.id)) {
      // Transport gesture: right-clicking a friendly mobile unit with a
      // transport selected means "pick it up", not "attack an ally".
      const carriers = this.#selectedTransports()
      const selUnits = [...this.scene.selected].map((id) => this.scene.unitById(id)).filter((u) => u && !u.dead)
      const sameSide = selUnits.length > 0 && selUnits.every((u) => (u.side | 0) === (hit.side | 0))
      if (carriers.length > 0 && sameSide && hit.meta && hit.meta.canMove !== false &&
          !(hit.meta.transportSlots > 0)) {
        const n = this.issueLoad(hit)
        if (n > 0) {
          this.#setStatus(`Load — transport picking up ${hit.name}.`)
          return
        }
      }
      // issueAttack (below) handles the per-unit attackTarget fanout
      // + ok1-bank ack on the first pursuer.  Centralised so every
      // attack-issuing gesture in the sandbox converges on it.
      const n = this.issueAttack(hit, queued)
      this.#setStatus(`${queued ? 'Attack queued' : 'Attack'} — ${n} unit(s) targeting ${hit.name} (HP ${hit.health}).`)
      return
    }
    const world = this.#screenToGround(sx, sy)
    if (!world) return
    // Right-click Move dispatches through issueMove — same shared
    // path the M-then-click flow uses, including the ok1-bank ack
    // on the first unit.
    const n = this.issueMove(world, queued)
    this.#setStatus(`${queued ? 'Move queued' : 'Move'} — ${n} unit(s) heading to (${world[0].toFixed(0)}, ${world[2].toFixed(0)}).`)
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
      // Construction-site pick (mobile builder): issue a Build order — the
      // builder walks into builddistance and raises the unit through the
      // sim's build cycle — rather than spawning instantly.
      if (p.buildFor) {
        const builderId = p.buildFor
        Promise.resolve(this.scene.build?.(builderId, p.name, x, z)).then(() => {
          this.#setStatus(`Build ordered — constructing ${p.name} at (${x.toFixed(0)}, ${z.toFixed(0)}).`)
        }).catch((e) => {
          this.#setStatus(`Build order failed: ${e?.message || e}`)
        })
        this.cancelPlacement()
        return
      }
      // The wasm world fetches the unit's meta + COB and runs Create on spawn;
      // refresh the field + status once the add resolves.
      this.#spawnUnit({
        name: p.name,
        model: p.model,
        cobScript: p.cobScript,
        x, z,
        headingRad: 0,
        side: p.side | 0,
      }).then(() => {
        this.#setStatus(`Spawned ${p.name} at (${x.toFixed(0)}, ${z.toFixed(0)}) — ${this.scene.unitCount()} unit${this.scene.unitCount() === 1 ? '' : 's'} on field.`)
        this.#refreshEntities()
      }).catch(() => { /* spawn failed — status stays as-is */ })
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
    if (this._pendingCmd === 'load' && this.scene.selected.size > 0) {
      const hit = this.#pickUnitAt(sx, sy)
      this._pendingCmd = null
      this.#refreshDefaultCursor()
      if (hit) {
        const n = this.issueLoad(hit)
        this.#setStatus(n > 0
          ? `Load — transport picking up ${hit.name}.`
          : `Load — ${hit.name} can't be carried (or no room).`)
      } else {
        this.#setStatus('Load cancelled — click a unit to pick up.')
      }
      return
    }
    if (this._pendingCmd === 'unload' && this.scene.selected.size > 0) {
      this._pendingCmd = null
      this.#refreshDefaultCursor()
      if (world) {
        const n = this.issueUnload(world)
        this.#setStatus(n > 0
          ? `Unload — ${n} transport(s) dropping cargo at (${world[0].toFixed(0)}, ${world[2].toFixed(0)}).`
          : 'Unload — no loaded transport selected.')
      } else {
        this.#setStatus('Unload cancelled — click a drop point.')
      }
      return
    }
    if (this._pendingCmd === 'patrol' && world && this.scene.selected.size > 0) {
      // Patrol waypoints lay click by click and the command STAYS armed —
      // consecutive points loop the route sim-side; Esc finishes.
      const n = this.issuePatrol(world)
      this.#setStatus(`Patrol waypoint added for ${n} unit(s) — keep clicking to extend the loop, Esc to finish.`)
      return
    }
    if (this._pendingCmd === 'move' && world && this.scene.selected.size > 0) {
      // issueMove fans the Move order out to every selected unit,
      // clears autonomous attack pursuit, preserves manual weapon
      // slots, and plays the ok1-bank ack on the first unit — same
      // path the right-click Move + the M-then-click flow converge
      // on so every Move gesture in the sandbox is one code path.
      // Shift queues the leg AND keeps the Move command armed so the
      // user can lay a whole waypoint chain click by click.
      const queued = !!e.shiftKey
      const n = this.issueMove(world, queued)
      if (!queued) {
        this._pendingCmd = null
        if (this._armedCursor) this._armedCursor.setSlot(null)
        this.#refreshDefaultCursor()
      }
      this.#setStatus(`${queued ? 'Move queued for' : 'Move order issued to'} ${n} unit(s).`)
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
          // Skip any selected unit that lacks this weapon slot — a mixed
          // selection should only fire the units actually carrying the weapon.
          const wm = u.meta && u.meta.weapons && u.meta.weapons[slotIdx]
          if (!wm || !wm.name) continue
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
          // Same mixed-selection guard as the unit-target branch: only units
          // that actually carry this weapon slot get a force-fire order.
          const wm = u.meta && u.meta.weapons && u.meta.weapons[slotIdx]
          if (!wm || !wm.name) continue
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
        // issue commands without losing it.  Shift queues the attack
        // behind each unit's current order.
        const queued = !!e.shiftKey
        const n = this.issueAttack(picked, queued)
        this.#setStatus(`${queued ? 'Attack queued' : 'Attack'} — ${n} unit(s) engaging ${picked.name} (HP ${picked.health}).`)
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
    // selection issues a Move; with Shift held it QUEUES the move
    // behind the unit's current orders (a shift-click that turns into
    // a drag is the rectangle-select gesture instead — the 6px
    // discriminator in #beginDragSelect routes between them).  This
    // replaces the old "no-op + Esc to deselect" behaviour: clicking
    // a destination is the most common follow-up gesture after
    // selecting a unit. Selection stays put (the user usually wants
    // to chain orders). No selection / clicked the sky → no-op.
    if (world && this.scene.selected.size > 0) {
      const queued = !!e.shiftKey
      const n = this.issueMove(world, queued)
      this.#setStatus(`${queued ? 'Move queued' : 'Move'} — ${n} unit(s) heading to (${world[0].toFixed(0)}, ${world[2].toFixed(0)}).`)
    }
  }

  // #pickUnitAt projects each unit's world position to screen space
  // and returns the nearest unit within a click-pixel radius (~32px).
  // Cheap O(N) for small N which the sandbox scene generally is.
  #pickUnitAt(sx, sy) {
    if (!this.scene || !this.camera) return null
    let best = null
    let bestScore = 0
    for (const u of this.scene.units()) {
      // A dead unit (or one mid death-animation) is scenery, not a
      // selectable actor — clicks pass through to the ground/others.
      if (u.dead) continue
      // Project the unit's vertical axis (feet → head) and measure the
      // click's distance to that SEGMENT. The acceptance gate scales with
      // the projected height AND the unit's footprint radius, so a tall
      // unit is clickable along its body and a sprawling building (a TA
      // factory pad, a TA:K keep) is clickable across its roof — not just
      // a fixed 32px disc at its centre, which made big factories appear
      // to ignore clicks entirely.
      const fp = u.meta ? Math.max(u.meta.footprintX || 0, u.meta.footprintZ || 0) : 0
      const radWU = Math.max(fp * 4, 10)
      const feet = this.#worldToScreen(u.pos.x, u.pos.y, u.pos.z)
      const head = this.#worldToScreen(u.pos.x, u.pos.y + Math.max(24, radWU), u.pos.z)
      if (!feet || !head) continue
      const ax = feet[0], ay = feet[1]
      const bx = head[0], by = head[1]
      const abx = bx - ax, aby = by - ay
      const abLen2 = abx * abx + aby * aby
      let t = abLen2 > 0 ? ((sx - ax) * abx + (sy - ay) * aby) / abLen2 : 0
      t = Math.max(0, Math.min(1, t))
      const px = ax + abx * t, py = ay + aby * t
      const dist = Math.hypot(sx - px, sy - py)
      const side = this.#worldToScreen(u.pos.x + radWU, u.pos.y, u.pos.z)
      const radPx = side ? Math.hypot(side[0] - ax, side[1] - ay) : 0
      const gate = Math.max(24, 0.6 * Math.sqrt(abLen2), radPx)
      if (dist >= gate) continue
      // Among gated candidates prefer the closest relative to its gate so
      // a small far unit isn't shadowed by a huge near one.
      const score = 1 - dist / gate
      if (score > bestScore) { bestScore = score; best = u }
    }
    return best
  }

  // #drawHealthBars paints the health-bar HUD onto a 2D canvas overlay
  // sitting above the GL canvas (pointer-events: none). Bars appear beneath
  // the hovered unit always, and beneath every selected unit while the
  // backquote toggle is on. Fill sweeps green→red with the unit's health
  // fraction (sim health is a 0–100 percent).
  #drawHealthBars() {
    const rect = this.canvas.getBoundingClientRect()
    let hud = this._hudCanvas
    if (!hud) {
      hud = document.createElement('canvas')
      hud.className = 'sandbox-health-hud'
      hud.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5'
      if (this.canvas.parentElement) this.canvas.parentElement.appendChild(hud)
      this._hudCanvas = hud
    }
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    if (hud.width !== w || hud.height !== h) { hud.width = w; hud.height = h }
    const ctx = hud.getContext('2d')
    ctx.clearRect(0, 0, w, h)
    if (!this.scene) return
    // Self-destruct countdowns paint over EVERY armed unit, selected or
    // not — a live fuse is exactly the thing the user must not lose sight
    // of. Big pulsing digit above the unit, seconds remaining.
    for (const u of this.scene.units()) {
      if (!u || u.dead || !(u.selfDestructMs > 0)) continue
      const head = this.#worldToScreen(u.pos.x, u.pos.y + 30, u.pos.z)
      if (!head) continue
      const secs = Math.max(1, Math.ceil(u.selfDestructMs / 1000))
      const pulse = 1 + 0.25 * (1 - ((u.selfDestructMs % 1000) / 1000))
      ctx.font = `bold ${Math.round(20 * pulse)}px ui-sans-serif, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'
      ctx.fillStyle = '#ff5340'
      ctx.strokeText(String(secs), head[0], head[1])
      ctx.fillText(String(secs), head[0], head[1])
    }
    const ids = new Set()
    if (this._healthBars) for (const id of this.scene.selected) ids.add(id)
    if (this._lastHoverUnitId) ids.add(this._lastHoverUnitId)
    if (ids.size === 0) return
    for (const id of ids) {
      const u = this.scene.unitById(id)
      if (!u || u.dead) continue
      const feet = this.#worldToScreen(u.pos.x, u.pos.y, u.pos.z)
      if (!feet) continue
      const frac = Math.max(0, Math.min(1, (u.health ?? 100) / 100))
      const bw = 30, bh = 4
      const x = Math.round(feet[0] - bw / 2)
      const y = Math.round(feet[1] + 8)
      ctx.fillStyle = 'rgba(0,0,0,0.65)'
      ctx.fillRect(x - 1, y - 1, bw + 2, bh + 2)
      ctx.fillStyle = `hsl(${Math.round(120 * frac)}, 85%, 45%)`
      ctx.fillRect(x, y, Math.round(bw * frac), bh)
    }
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
  // queued (shift held on the gesture) appends the move to each unit's
  // sim-side order queue instead of replacing its current orders — the
  // unit drives the chain leg by leg, advancing on arrival.
  issueMove(point, queued = false) {
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
      const target = { x: point[0] + offX, z: point[2] + offZ }
      if (queued && typeof u.queueMove === 'function') {
        u.queueMove(target)
        n++
        continue
      }
      u.moveTarget = target
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
  issueAttack(targetUnit, queued = false) {
    const units = this.getSelectedUnits()
    if (!units.length || !targetUnit) return 0
    let n = 0
    let firstPursuer = null
    for (const u of units) {
      if (!u || u.dead || u === targetUnit) continue
      if (queued && typeof u.queueAttack === 'function') {
        u.queueAttack(targetUnit)
      } else {
        u.attackTarget = targetUnit
      }
      if (!firstPursuer) firstPursuer = u
      n++
    }
    if (firstPursuer) this.playUnitSoundRandom(firstPursuer, ['ok1', 'ok2', 'ok3', 'ok4', 'ok5'])
    return n
  }

  // issuePatrol appends a looping patrol waypoint for every selected mobile
  // unit (the sim cycles consecutive patrol entries until reordered).
  issuePatrol(point) {
    const units = this.getSelectedUnits().filter((u) => !u.meta || u.meta.canMove !== false)
    if (!units.length || !point || !this.scene.source.patrol) return 0
    this.scene.source.patrol(units.map((u) => u.id), point[0], point[2])
    this.playUnitSoundRandom(units[0], ['ok1', 'ok2', 'ok3', 'ok4', 'ok5'])
    return units.length
  }

  // #selectedTransports returns the live selected units that can carry
  // passengers (meta.transportSlots > 0).
  #selectedTransports() {
    return this.getSelectedUnits().filter((u) =>
      !u.dead && u.meta && (u.meta.transportSlots | 0) > 0)
  }

  // issueLoad sends the first selected transport with room toward the
  // target unit; the sim walks it into pickup range and attaches.
  issueLoad(target) {
    if (!target || !this.scene.source.load) return 0
    const carriers = this.#selectedTransports().filter((u) => {
      const aboard = (u.carrying || []).length
      return u.id !== target.id && aboard < (u.meta.transportSlots | 0)
    })
    if (!carriers.length) return 0
    // One pickup, one carrier: fan a multi-transport selection by giving
    // the job to the nearest with room rather than racing them all.
    carriers.sort((a, b) => {
      const da = (a.pos.x - target.pos.x) ** 2 + (a.pos.z - target.pos.z) ** 2
      const db = (b.pos.x - target.pos.x) ** 2 + (b.pos.z - target.pos.z) ** 2
      return da - db
    })
    this.scene.source.load([carriers[0].id], target.id)
    this.playUnitSoundRandom(carriers[0], ['ok1', 'ok2', 'ok3', 'ok4', 'ok5'])
    return 1
  }

  // issueUnload points every loaded (or load-pending) selected transport at
  // the drop site; the sim fans the cargo onto clear ground on arrival.
  issueUnload(point) {
    if (!point || !this.scene.source.unload) return 0
    const carriers = this.#selectedTransports().filter((u) => (u.carrying || []).length > 0)
    if (!carriers.length) return 0
    this.scene.source.unload(carriers.map((u) => u.id), point[0], point[2])
    this.playUnitSoundRandom(carriers[0], ['ok1', 'ok2', 'ok3', 'ok4', 'ok5'])
    return carriers.length
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
        alive: null, kind: null, spriteId: null,
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
    b.alive    = new Uint8Array(next)
    b.kind     = new Uint16Array(next)
    // spriteId for kind=206 bitmap projectiles — the Effects panel
    // looks this up against the renderer's sprite registry to label
    // each card with its real weapon name + TDF color slot.
    b.spriteId = new Uint16Array(next)
    b.r        = new Float32Array(next)
    b.g        = new Float32Array(next)
    b.b        = new Float32Array(next)
    b.x        = new Float32Array(next)
    b.y        = new Float32Array(next)
    b.z        = new Float32Array(next)
    b.vx       = new Float32Array(next)
    b.vy       = new Float32Array(next)
    b.vz       = new Float32Array(next)
    b.life     = new Float32Array(next)
    b.life0    = new Float32Array(next)
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
        b.alive[w]    = 1
        b.kind[w]     = p.kind[i] | 0
        // spriteId is optional on the source pool — older bindings
        // pre-Phase-3b don't have the column.  || 0 keeps the
        // aggregate clean for non-sprite kinds.
        b.spriteId[w] = (p.spriteId && p.spriteId[i]) | 0
        b.r[w]        = p.r[i];  b.g[w]  = p.g[i];  b.b[w]  = p.b[i]
        b.x[w]        = p.x[i];  b.y[w]  = p.y[i];  b.z[w]  = p.z[i]
        b.vx[w]       = p.vx[i]; b.vy[w] = p.vy[i]; b.vz[w] = p.vz[i]
        b.life[w]     = p.life[i]
        b.life0[w]    = p.life0[i]
        w++
      }
    }
    return {
      count: w,
      alive: b.alive, kind: b.kind, spriteId: b.spriteId,
      r: b.r, g: b.g, b: b.b,
      x: b.x, y: b.y, z: b.z,
      vx: b.vx, vy: b.vy, vz: b.vz,
      life: b.life, life0: b.life0,
    }
  }

  // aggregateProjectiles returns a flat snapshot of every in-flight model
  // projectile (bombs / missiles / rockets) with the host-side metadata
  // the Projectiles inspector needs but the engine record doesn't carry —
  // the owning unit's name + faction + side colour, the live unit position
  // when the projectile is homing on a unit (so origin/destination renders
  // a live track).  Snapshots at call time so a despawn between the panel's
  // build pass and a draw pass can't crash the renderer.
  aggregateProjectiles() {
    const engine = this.engine
    if (!engine) return []
    const out = []
    // Model-projectiles (bombs / homing missiles / mesh rockets) — the
    // engine simulates these with full flight records.
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
    // dead-reckoned missiles fired by everything that's NOT a bomber: PeeWees,
    // Guardians, Commanders, etc.  Each unit's binding owns its own particle
    // pool, so we walk every binding here and pick out the projectile-kind
    // slots (kind code 200-299, lasers excepted since they're instantaneous
    // beams rather than flying ordnance).  Origin / destination are extrapolated
    // along the velocity vector: the elapsed-life segment behind the slot
    // gives the launch point, the remaining-life segment ahead of it gives
    // where it'll expire if nothing intercepts it.
    appendParticleProjectiles(engine, out)
    return out
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
      unit: null,
      hasScript: () => false,
    })
    // COB executes inside the wasm engine, so the live runtime (thread list,
    // tick/unit/thread counts) and the focused unit's static vars come from the
    // scene's COB adapter, not the render-only JS binding. The Runtime / Script
    // Variables panels read cob.runtime + cob.unit; populate both here so they
    // show real state in the offline sandbox and in a joined match alike.
    cob.runtime = (this.scene && this.scene.runtime) ? this.scene.runtime : this.runtime
    if (focused && this.scene && typeof this.scene.cobUnit === 'function') {
      cob.unit = this.scene.cobUnit(focused.id)
    }
    const mv = {
      camera: this.camera,
      renderer: this.renderer,
      cob,
      // Network/sync telemetry for the Network developer panel. Null in an
      // offline sandbox (no authority); a live stats object in a joined match.
      net: (this.scene && typeof this.scene.netStats === 'function') ? this.scene.netStats() : null,
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
      // Live motion telemetry for the Movement panel — snapshot of the
      // engine unit's speed / heading / atkPhase etc.  Refreshed every
      // refresh-tick publish via this getter being called again.
      // Hand the renderer's live pose overlay (banking / wobble) to the
      // motion builder so the Movement panel's attitude indicator rolls
      // with the unit.  Sandbox runs in multi-entity mode → look up by id.
      const orient = (this.renderer && this.renderer.getUnitOrientation)
        ? this.renderer.getUnitOrientation(focused.id) : null
      mv.unitMotion = buildUnitMotion(focused, orient)
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
    if (window.__kbotSandboxView === this) window.__kbotSandboxView = null
    if (this._hudCanvas) {
      this._hudCanvas.remove()
      this._hudCanvas = null
    }
    if (this._wasmCrashHandler) {
      window.removeEventListener('kbot-wasm-crash', this._wasmCrashHandler)
      this._wasmCrashHandler = null
    }
    // Detach the orbit-controls listeners (wheel / pointer / key)
    // FIRST so any in-flight wheel event between dispose start and
    // canvas teardown can't fire requestRedraw against the about-to-
    // be-deleted GL context.
    if (typeof this._detachCamera === 'function') {
      try { this._detachCamera() } catch { /* ignore */ }
      this._detachCamera = null
    }
    if (typeof this._unsubEnhance === 'function') {
      try { this._unsubEnhance() } catch { /* ignore */ }
      this._unsubEnhance = null
    }
    if (this._resizeObserver) this._resizeObserver.disconnect()
    this._resizeObserver = null
    // Scene-level teardown — pause the runtime, silence the engine, and
    // release every unit's AudioPool — ONLY when this view OWNS its
    // scene.  In a tab/split the scene is SHARED (this._externalScene)
    // and owned by the tab, whose dispose() does this once for the whole
    // tab.  Doing it here on a per-pane close would freeze + mute the
    // shared sim for the surviving panes — the bug this guard fixes:
    // closing one sandbox split pane used to stop the others' units.
    if (!this._externalScene) {
      if (this.scene && this.scene.runtime && typeof this.scene.runtime.setPaused === 'function') {
        try { this.scene.runtime.setPaused(true) } catch { /* ignore */ }
      }
      if (this.scene && this.scene.engine && typeof this.scene.engine.setSilenced === 'function') {
        try { this.scene.engine.setSilenced(true) } catch { /* ignore */ }
      }
      // Hard-dispose every live unit's AudioPool so the `<audio>`
      // elements are released back to the browser (setSilenced only
      // PAUSES; the elements keep their buffer until dispose() drops the
      // src).  The tab dispose path does the same for shared scenes.
      const engine = this.scene && this.scene.engine
      if (engine && engine._units && typeof engine._units.values === 'function') {
        for (const u of engine._units.values()) {
          if (u && u.binding && u.binding.audio
              && typeof u.binding.audio.dispose === 'function') {
            try { u.binding.audio.dispose() } catch { /* ignore */ }
          }
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
    // Drop per-instance pose clones (geometry buffers are owned by the
    // base _localModels entries / the renderer's GL context teardown;
    // clones only alias them, so there's nothing to GPU-free here).
    this._localInstances.clear()
    // Explosion overlay teardown — removes the DOM root + any live
    // sprites, and detaches the spawn subscription so future spawns
    // don't try to wire a destroyed overlay onto a binding.
    if (this._explosionSpawnUnsub) {
      try { this._explosionSpawnUnsub() } catch { /* ignore */ }
      this._explosionSpawnUnsub = null
    }
    if (this._explosionOverlay) {
      try { this._explosionOverlay.dispose() } catch { /* ignore */ }
      this._explosionOverlay = null
    }
    if (this.renderer) this.renderer.dispose()
    this.renderer = null
    this.scene = null
  }
}

