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

import { ModelRenderer } from '../../game3d/model-renderer.js'
import { ModelLoader } from '../../game3d/model-loader.js'
import { OrbitCamera } from '../../game3d/orbit-camera.js'
import { TextureCache } from '../../game3d/texture-cache.js'
import { attachOrbitControls } from '../../game3d/camera-controls.js'
import { stepSimSpeed } from '../common/sim-controls.js'

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
        // Plain +/- step the unit-editor runtime's playback rate from
        // an observer pane too (Shift+/- zooms instead).
        onSimSpeedStep: (dir) => stepSimSpeed(dir),
      })
      // Per-frame hook — mirror the primary's scene config + unit-level
      // world transform, attach its projectile pool, then copy the
      // animated piece pose into our local model.  We never call
      // binding.tick; the primary's renderer drives the runtime, we
      // just paint the result with our own camera.
      this.renderer.onAfterFrame = () => {
        this._mirrorPrimaryConfig()
        this._mirrorUnitTransform()
        this._syncProjectiles()
        this._syncPose()
      }
    }
    // Mirror the primary's world look immediately so a sea unit's
    // observer pane opens on water (not the default terrain) instead of
    // looking like an independent copy of the scene.
    this._mirrorPrimaryConfig()
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

  // _mirrorPrimaryConfig keeps THIS observer's renderer visually in
  // step with the primary's scene config — ground (sea vs terrain),
  // environment (sky + water colour + tileset), render mode,
  // submersion, team colour, and the post-process toggles.  Without
  // it an observer pane spun up from a sea unit shows the default land
  // terrain and reads as an "independent copy of the world".  Runs
  // every frame but is near-free: each field is compared to its
  // last-applied value and the (sometimes heavy) setter only fires on
  // an actual change, so steady-state is a dozen cheap comparisons.
  _mirrorPrimaryConfig() {
    const pr = this.primary && this.primary.renderer
    const r = this.renderer
    if (!pr || !r) return
    const c = this._cfg || (this._cfg = {})
    const apply = (key, val, fn) => {
      if (c[key] === val) return
      c[key] = val
      try { fn(val) } catch { /* ignore — observer is best-effort */ }
    }
    apply('ground', pr.groundMode, (v) => r.setGroundMode && r.setGroundMode(v))
    apply('env', pr._envKey, (v) => { if (v && r.setEnvironment) r.setEnvironment(v) })
    apply('mode', pr.renderMode, (v) => r.setRenderMode && r.setRenderMode(v))
    apply('sub', pr.submersionMode, (v) => r.setSubmersionMode && r.setSubmersionMode(v))
    apply('team', pr.teamColorEnable ? (pr.teamColor || []).join(',') : '',
      () => r.setTeamColor && r.setTeamColor(pr.teamColorEnable ? pr.teamColor : null))
    apply('refl', pr.optReflections, (v) => r.setReflectionsEnabled && r.setReflectionsEnabled(v))
    apply('spec', pr.optSpecular, (v) => r.setSpecularEnabled && r.setSpecularEnabled(v))
    apply('beams', pr.optGodBeams, (v) => r.setGodBeamsEnabled && r.setGodBeamsEnabled(v))
    apply('dof', pr.optDof, (v) => r.setDoFEnabled && r.setDoFEnabled(v))
    apply('wrefl', pr.optWaterReflections, (v) => r.setWaterReflectionsEnabled && r.setWaterReflectionsEnabled(v))
    apply('bob', pr.optBob, (v) => r.setBobEnabled && r.setBobEnabled(v))
    apply('waves', pr.optWaves, (v) => r.setWavesEnabled && r.setWavesEnabled(v))
    apply('bgt', pr.optBgTerrain, (v) => r.setBgTerrainEnabled && r.setBgTerrainEnabled(v))
  }

  // _mirrorUnitTransform copies the primary's unit-level world
  // placement — the Controls-panel Move position, body heading, and
  // flight altitude that MvControls._applyRendererTransform writes into
  // the primary renderer's _unitTransform — onto this observer's
  // renderer.  _syncPose only copies the per-piece COB channels (legs /
  // turret / flares), so without this the body stays rooted at the
  // origin: a unit the user walks across the field or rotates would
  // appear frozen in every secondary pane even while its limbs animate.
  _mirrorUnitTransform() {
    const pr = this.primary && this.primary.renderer
    const r = this.renderer
    if (!pr || !r || !pr._unitTransform || typeof r.setUnitTransform !== 'function') return
    const t = pr._unitTransform
    r.setUnitTransform(t.x || 0, t.y || 0, t.z || 0, t.headingRad || 0)
  }

  // _syncProjectiles points this observer's renderer at the primary
  // binding's particle pool (projectiles, muzzle flashes, smoke trails,
  // beams) in READ-ONLY mode: driveTick:false means we draw the shared
  // pool + pull the dynamic light from it but never advance the binding
  // (the primary's renderer owns the single per-frame tick).  Re-asserts
  // whenever the primary swaps binding (unit reload) so the observer
  // never draws a stale pool.  Without it the secondary panes play the
  // firing animation but no visible shot leaves the barrel.
  _syncProjectiles() {
    const r = this.renderer
    if (!r || typeof r.setCobBinding !== 'function') return
    const binding = (this.primary && this.primary.cob) || null
    if (r.cobBinding === binding) return
    r.setCobBinding(binding, { driveTick: false })
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
