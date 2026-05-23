// ModelViewer — DOM-level component that wires the canvas, orbit camera,
// renderer, and the inputs the user expects (drag to orbit, wheel to
// zoom, right-drag to pan, click "Auto-rotate" to toggle the
// turntable).
//
// The Studio talks to a ModelViewer via three calls — open(modelName),
// closed by remove(), and onClose for cleanup.  Everything else
// (palette / texture cache / loader / renderer) is internal so the
// callsite stays a single line.

import { TAPalette } from './palette.js'
import { TextureCache } from './texture-cache.js'
import { ModelLoader } from './model-loader.js'
import { OrbitCamera } from './orbit-camera.js'
import { ModelRenderer } from './model-renderer.js'
import { CobRuntime } from './cob/cob-runtime.js'
import { CobBinding } from './cob/cob-binding.js'

export class ModelViewer {
  constructor({ canvas, statusEl, onModelLoaded } = {}) {
    this.canvas = canvas
    this.statusEl = statusEl
    // onModelLoaded is invoked whenever a new Model finishes loading,
    // letting the host (Studio) render its own piece-tree UI without
    // ModelViewer needing to know about the studio's drawer classes.
    this.onModelLoaded = onModelLoaded || null
    this.renderer = null
    this.camera = null
    this.model = null
    // cob is the per-unit script runtime + model binding.  Set by
    // open() after the COB fetch resolves; remains null when the
    // unit ships no .COB (many props / features).  Per-frame
    // animation tick is driven from the renderer via setCobBinding.
    this.cob = null
    // cobDamage drives the GET_UNIT_VALUE port for HEALTH so the
    // user can preview "this unit at 50% health" via the studio's
    // damage popup.  Some bos scripts also emit damage smoke when
    // HEALTH < threshold (the SmokeUnit thread polls in a loop) so
    // bumping this slider lights up the SFX pipeline visibly.
    this.cobDamage = 0
    this._pointerState = null
    this._resizeObserver = null
    this._wireInputs()
  }

  // setDamage sets the unit's damage percent (0..100).  When
  // non-zero, GET_UNIT_VALUE(HEALTH) returns (100 - damage) so any
  // bos script polling for low health (SmokeUnit, MotionControl
  // checks, etc.) sees the new value next iteration.
  //
  // SmokeUnit dedup explained: the script body is `while (1) { …
  // emit smoke … sleep N … }` - one perpetually-alive instance is
  // enough to emit smoke as long as HEALTH stays low.  My earlier
  // version started a NEW SmokeUnit thread on every slider event,
  // which compounded N threads in the runtime and made the smoke
  // density grow with slider movement instead of with damage.
  // We now spawn AT MOST ONE: if a SmokeUnit thread is already
  // alive we leave it alone (it'll see the new HEALTH on its
  // next polling iteration); only when none exists AND damage>0
  // do we kick off a single instance.
  setDamage(percent) {
    this.cobDamage = Math.max(0, Math.min(100, +percent || 0))
    if (!this.cob || !this.cob.hasScript('SmokeUnit') || this.cobDamage <= 0) return
    const alreadyRunning = this.cob.runtime._threads.some(
      (t) => t.script.name.toLowerCase() === 'smokeunit',
    )
    if (!alreadyRunning) this.cob.start('SmokeUnit')
  }

  // open initialises (or reuses) the WebGL pipeline and loads the named
  // model.  Subsequent open() calls swap the model in-place without
  // tearing down the GL context.
  async open(modelName) {
    this.#setStatus(`Loading ${modelName}…`)
    if (!this.renderer) {
      const palette = await TAPalette.load()
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
      // Shaders now live as standalone .vert/.frag files under
      // shaders/ and load over fetch().  init() resolves once they're
      // compiled + linked so the first frame doesn't fire at an
      // un-ready renderer.
      await this.renderer.init()
      this.renderer.start()
    }
    try {
      if (this.model) this.model.dispose(this.renderer.gl)
      const model = await this.loader.load(modelName)
      this.model = model
      this.renderer.setModel(model)
      this.camera.frameBounds(model.bounds.min, model.bounds.max)
      // Reset orbit angle on each new model so the user always
      // sees the entry view first, regardless of where the previous
      // tab's auto-rotate left the camera.  Yaw 215° (180° behind
      // the historical 35°) + 25% further distance matches the
      // angle used by TA's build-picture thumbnails — units read
      // from their natural front-quarter view.
      this.camera.yaw = 215 * Math.PI / 180
      this.camera.pitch = 18 * Math.PI / 180
      this.camera.distance *= 1.25
      this.renderer.requestRedraw()
      // Try to fetch + attach the unit's COB script.  Many units
      // ship without one (features / props / placeholders) so the
      // 404 path just leaves this.cob null and the unit displays
      // statically.  The runtime auto-runs Create + Activate on
      // load so flares hide / blades start spinning without the
      // user clicking anything.
      this.cob = null
      this.renderer.setCobBinding(null)
      try {
        const cobResp = await fetch(`/api/studio/cob/${encodeURIComponent(modelName)}`)
        if (cobResp.ok) {
          const cobJson = await cobResp.json()
          const runtime = new CobRuntime(cobJson, {
            // Tag log lines so they're easy to spot in the console.
            log: (msg) => console.warn(`[cob:${modelName}]`, msg),
            // Provide the unit-value port reads the bos scripts
            // query - HEALTH, ACTIVATION etc.  Damage comes from
            // the studio's per-unit UI; default 0 ("undamaged")
            // until the user drags the slider.
            getUnitValue: (port) => {
              if (port === 4 /* HEALTH */) return Math.max(0, 100 - (this.cobDamage || 0))
              if (port === 1 /* ACTIVATION */) return 1
              return 0
            },
          })
          this.cob = new CobBinding(model, runtime)
          this.renderer.setCobBinding(this.cob)
          // TA convention: Create runs first (sets up initial
          // piece positions), then Activate kicks off the
          // running-state animations (radar dish spin, hide
          // muzzle flares, etc.).  Fall through quietly when a
          // script doesn't define either entry point - rare but
          // a few features ship a stub COB.
          if (this.cob.hasScript('Create')) this.cob.start('Create')
          if (this.cob.hasScript('Activate')) this.cob.start('Activate')
          // Seed the reload-time global the AimWeapon/RestoreAfter-
          // Delay scripts read.  The bos source typically computes
          // global_2 = reloadTime * 2 inside SetMaxReloadTime(); in
          // a real match the engine calls that with the unit's FBI
          // ReloadTime (3-5 seconds).  We don't have access to FBI
          // here so seed a single sensible value via the same entry
          // point — the script then populates its own globals and
          // RestoreAfterDelay snaps the turret back ~6 seconds
          // after the aim completes, matching in-game pacing.
          if (this.cob.hasScript('SetMaxReloadTime')) {
            this.cob.start('SetMaxReloadTime', [3000])
          }
        }
      } catch (e) {
        console.warn(`[cob:${modelName}] fetch failed:`, e)
      }
      if (this.onModelLoaded) this.onModelLoaded(model, this.cob)
      this.#setStatus(`${modelName} · ${model.flat.length} piece${model.flat.length === 1 ? '' : 's'}`)
    } catch (err) {
      this.#setStatus(`Failed to load ${modelName}: ${err.message || err}`)
    }
  }

  dispose() {
    if (this._resizeObserver) this._resizeObserver.disconnect()
    this._resizeObserver = null
    if (this.renderer) {
      this.renderer.dispose()
      this.renderer = null
    }
    this.model = null
    this.camera = null
  }

  setAutoRotate(on) {
    if (this.renderer) this.renderer.setAutoRotate(on)
  }

  // jumpToPiece centres the orbit target on the given piece so the user
  // can click a tree entry to inspect that piece.  Distance shrinks
  // proportional to the piece's bounding box.
  jumpToPiece(name) {
    if (!this.model) return
    const piece = this.model.findPiece(name)
    if (!piece) return
    // Estimate piece bounds by reading back the interleaved buffers is
    // overkill — instead pull from drawGroups' implied centroid by
    // averaging piece origin + child origins for a fast approximation.
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    const walk = (p, off) => {
      const ox = off[0] + p.origin[0]
      const oy = off[1] + p.origin[1]
      const oz = off[2] + p.origin[2]
      // Empty pieces still contribute their anchor — gives emit points
      // a sensible framing rather than collapsing to a point at origin.
      min[0] = Math.min(min[0], ox - 1); max[0] = Math.max(max[0], ox + 1)
      min[1] = Math.min(min[1], oy - 1); max[1] = Math.max(max[1], oy + 1)
      min[2] = Math.min(min[2], oz - 1); max[2] = Math.max(max[2], oz + 1)
      for (const c of p.children) walk(c, [ox, oy, oz])
    }
    walk(piece, [0, 0, 0])
    if (Number.isFinite(min[0])) {
      this.camera.frameBounds(min, max, 1.6)
      this.renderer.requestRedraw()
    }
  }

  // ── private ────────────────────────────────────────────────────────

  #setStatus(msg) {
    if (this.statusEl) this.statusEl.textContent = msg
  }

  #observeResize() {
    if (!('ResizeObserver' in window)) return
    this._resizeObserver = new ResizeObserver(() => {
      if (this.renderer) this.renderer.requestRedraw()
    })
    this._resizeObserver.observe(this.canvas)
  }

  _wireInputs() {
    const cv = this.canvas
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId)
      this._pointerState = { x: e.clientX, y: e.clientY, button: e.button }
      // Stop the turntable as soon as the user grabs the camera — the
      // common case for stopping auto-rotate is "I want to look at
      // this piece manually".
      if (this.renderer) this.renderer.setAutoRotate(false)
    })
    cv.addEventListener('pointermove', (e) => {
      if (!this._pointerState) return
      const dx = e.clientX - this._pointerState.x
      const dy = e.clientY - this._pointerState.y
      this._pointerState.x = e.clientX
      this._pointerState.y = e.clientY
      if (!this.camera) return
      if (this._pointerState.button === 2 || e.shiftKey) {
        this.camera.panBy(dx, dy)
      } else {
        // Dragging up tilts the camera up (eye orbits over the top,
        // scene's underside comes into view).  With the new "positive
        // pitch = looking down" convention dragging up = increasing
        // pitch, so dy stays positive.
        this.camera.rotateBy(dx * 0.35, dy * 0.35)
      }
      if (this.renderer && !this.renderer.running) this.renderer.requestRedraw()
    })
    const release = (e) => {
      if (this._pointerState && cv.hasPointerCapture(e.pointerId)) {
        cv.releasePointerCapture(e.pointerId)
      }
      this._pointerState = null
    }
    cv.addEventListener('pointerup', release)
    cv.addEventListener('pointercancel', release)
    cv.addEventListener('wheel', (e) => {
      e.preventDefault()
      if (!this.camera) return
      // Wheel zoom is a user gesture — disable auto-rotate so the
      // unit holds the angle the user is investigating.  Same rule
      // as the pointer-down drag handler.
      if (this.renderer) {
        this.renderer.setAutoRotate(false)
        const btn = document.querySelector('#mv-act-autorotate')
        if (btn) { btn.dataset.on = '0'; btn.classList.remove('active') }
      }
      const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1
      this.camera.zoomBy(factor)
      if (this.renderer && !this.renderer.running) this.renderer.requestRedraw()
    }, { passive: false })
    cv.addEventListener('contextmenu', (e) => e.preventDefault())
  }
}
