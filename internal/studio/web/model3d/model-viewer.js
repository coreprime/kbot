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
    this._pointerState = null
    this._resizeObserver = null
    this._wireInputs()
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
      // tab's auto-rotate left the camera.
      this.camera.yaw = 35 * Math.PI / 180
      this.camera.pitch = 18 * Math.PI / 180
      this.renderer.requestRedraw()
      if (this.onModelLoaded) this.onModelLoaded(model)
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
