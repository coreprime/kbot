// observer-view.js
//
// Lightweight per-pane viewport for the unit-editor's split layout.
// A unit-editor tab's PRIMARY pane keeps using the original
// ModelViewer (canvas + renderer + camera + GL pipeline + COB
// binding + runtime + MvControls — the full kitchen sink).  Every
// SECONDARY pane is an observer: it owns its own canvas, renderer,
// camera, GL context, and a local-context copy of the model, but
// has NO COB binding of its own.  Each frame it copies the per-piece
// animation channels (move / rotate / visible) from the primary's
// animated model into its own local model, then draws.
//
// Why asymmetric instead of "every pane is a full ModelViewer":
//
//   - The renderer's draw loop calls `binding.tick(dtMs)` when
//     setCobBinding(...) has been set.  If every pane's renderer
//     drove the binding tick, the runtime would advance N× per
//     paint frame: scripts run at N× speed, animations skip, etc.
//     The coalesce we put on engine.tick + scene.tick doesn't cover
//     the direct binding.tick path the unit editor's renderer
//     uses.  Easiest fix: only the primary's renderer advances the
//     binding; secondaries read the result.
//
//   - MvControls owns a lot of per-tab state (pos, heading, alt,
//     weapon slots, projectile recording, smoke trails, build ramp).
//     Splitting that across N viewers would require either a deep
//     refactor or per-pane duplication that would have to be
//     re-synced.  Keeping it on the primary keeps that surface
//     untouched.
//
// The result: secondary panes show the same animated unit from a
// different camera angle.  They have their own OrbitCamera (pan /
// zoom / orbit independently), their own auto-rotate state, and
// their own R / arrow-key hotkey routing.  They do NOT drive
// COB scripts and they do NOT own a separate runtime/binding.

import { ModelRenderer } from '../../model3d/model-renderer.js'
import { ModelLoader } from '../../model3d/model-loader.js'
import { OrbitCamera } from '../../model3d/orbit-camera.js'
import { TextureCache } from '../../model3d/texture-cache.js'
import { attachOrbitControls } from '../../model3d/camera-controls.js'

export class ModelObserverView {
  constructor({ canvas, primaryViewer }) {
    // Each observer pane creates its own canvas (default) OR accepts
    // a host-supplied one.  The canvas lives in the split tree's
    // leaf slot, mounted/unmounted by split-host's LeafSlot effect.
    this.canvas = canvas || (() => {
      const c = document.createElement('canvas')
      c.className = 'model-viewer-canvas'
      return c
    })()
    // Primary viewer ref — the source of truth for model + binding
    // + pose.  Per-frame we read primaryViewer.model and
    // primaryViewer.cob (the live binding) to drive our local
    // renderer.  No ownership: we never write to the primary.
    this.primary = primaryViewer
    this.renderer = null
    this.camera = null
    this.loader = null
    this.palette = null
    this.localModel = null
    this._modelName = null
    this._detachCamera = null
    this._disposed = false
  }

  // attach / detach mirror SandboxView / ModelViewer so the split-
  // host's LeafSlot can use the same pattern uniformly.  Owners
  // are external (split-host).
  attach(stage) {
    if (stage && this.canvas && this.canvas.parentNode !== stage) {
      stage.appendChild(this.canvas)
    }
  }
  detach() {
    if (this.canvas && this.canvas.parentNode) {
      try { this.canvas.parentNode.removeChild(this.canvas) } catch { /* ignore */ }
    }
  }

  // open initialises the GL pipeline + loads the model into THIS
  // pane's context.  `modelName` is the primary's current unit name.
  // Idempotent — subsequent calls with the same name no-op.
  async open(modelName) {
    if (this.renderer && this._modelName === modelName) return
    if (!this.renderer) {
      // Reuse the primary's palette ref — palette is immutable data
      // (TA's fixed 256-colour table) so sharing the parsed array is
      // safe.  No GL resources on it.
      this.palette = this.primary && this.primary.palette
        ? this.primary.palette
        : null
      const gl = this.canvas.getContext('webgl', {
        antialias: true,
        premultipliedAlpha: false,
      })
      if (!gl) return
      const textureCache = new TextureCache(gl)
      this.loader = new ModelLoader({ gl, palette: this.palette, textureCache })
      this.renderer = new ModelRenderer({ canvas: this.canvas, textureCache, gl })
      this.camera = new OrbitCamera({})
      this.renderer.setCamera(this.camera)
      await this.renderer.init()
      this.renderer.start()
      // Camera defaults match ModelViewer's first-load framing — yaw
      // 215° + 18° pitch + 25% wider distance — so the observer's
      // first view reads the same "natural front-quarter" angle TA's
      // build-picture thumbnails use.  The user then orbits freely.
      // Wire orbit / pan / zoom — same shared attach as primary; the
      // split-host gates per-pane focus via isActive.
      this._detachCamera = attachOrbitControls({
        canvas: this.canvas,
        renderer: this.renderer,
        camera: this.camera,
        dialogId: 'model-viewer-dialog',
        // _isFocusedPane set by split-host before open(); the gate
        // routes R / arrow keys to only the focused pane.
        isActive: () => !this._isFocusedPane || this._isFocusedPane(),
      })
      // Per-frame hook — copy the primary's animated pose into our
      // local model and refresh.  This is where the asymmetry lands:
      // we never call binding.tick; the primary's renderer is
      // responsible for driving the runtime.  We just paint the
      // result with our own camera.
      this.renderer.onAfterFrame = () => this._syncPose()
    }
    // Lazy-load the model into our GL context.  Cached so split-
    // open / close cycles don't refetch + re-upload.
    if (this._modelName !== modelName) {
      this._modelName = modelName
      try {
        const local = await this.loader.load(modelName)
        if (this._disposed) return
        this.localModel = local
        this.renderer.setModel(local)
        // Frame the new model — sets distance + target to the bounds
        // centroid so the unit fills the view on first paint.
        if (local && local.bounds) {
          this.camera.frameBounds(local.bounds.min, local.bounds.max)
          this.camera.yaw = 215 * Math.PI / 180
          this.camera.pitch = 18 * Math.PI / 180
          this.camera.distance *= 1.25
        }
        this.renderer.requestRedraw()
      } catch { /* ignore — primary's load is authoritative for errors */ }
    }
  }

  // _syncPose walks the primary's model in lockstep with our local
  // copy and copies the binding-driven animated channels.  Same
  // pattern as SandboxView's #copyPieceState — both trees were built
  // from the same loader JSON so DFS child-order alignment is safe.
  _syncPose() {
    const src = this.primary && this.primary.model && this.primary.model.root
    const dst = this.localModel && this.localModel.root
    if (!src || !dst) return
    _copy(src, dst)
  }

  // setSilenced / pause / start passthroughs — the split host calls
  // these on tab swap.  We only own a renderer (RAF loop); audio +
  // runtime live on the primary.
  setSilenced(_s) { /* observers carry no audio */ }
  start() { try { this.renderer && this.renderer.start && this.renderer.start() } catch { /* ignore */ } }
  stop()  { try { this.renderer && this.renderer.stop  && this.renderer.stop()  } catch { /* ignore */ } }

  dispose() {
    if (this._disposed) return
    this._disposed = true
    try { this._detachCamera && this._detachCamera() } catch { /* ignore */ }
    this._detachCamera = null
    try { this.renderer && this.renderer.stop && this.renderer.stop() } catch { /* ignore */ }
    try {
      if (this.localModel && this.renderer && this.renderer.gl) {
        this.localModel.dispose(this.renderer.gl)
      }
    } catch { /* ignore */ }
    this.localModel = null
    this.renderer = null
    this.camera = null
  }
}

// _copy — lockstep DFS pose copy.  Hoisted out of the class so the
// recursion is a plain function call (no `this`-bound thunk).
function _copy(src, dst) {
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
  for (let i = 0; i < n; i++) _copy(sc[i], dc[i])
}
