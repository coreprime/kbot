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
import { SFX_SPARK, SFX_SMOKE_WHITE } from '/engine/cob-particles.js'
import { attachOrbitControls } from './camera-controls.js'
import { onEnhanceMeshChanged } from './enhance-mesh.js'

// TA 3DOs author the nose toward -Z; the wasm engine's heading 0 faces +Z, so
// the unit spawns at heading π so its native rest pose renders un-rotated (the
// renderer applies heading + π — see mv-controls _applyRendererTransform).
const REST_HEADING = Math.PI

export class ModelViewer {
  constructor({ canvas, statusEl, onModelLoaded, sceneFactory } = {}) {
    this.canvas = canvas
    this.statusEl = statusEl
    // sceneFactory(opts) -> a wasm-backed single-unit scene (the studio
    // injects ui/sandbox's WasmSandboxScene).  Injected rather than imported
    // so this package doesn't depend back on the studio app's ui layer.
    this._sceneFactory = sceneFactory || null
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
    // The viewer is, in effect, a single-unit sandbox: it owns a
    // WasmSandboxScene (the same Go/wasm simulation the Sandbox runs)
    // with exactly one unit.  COB scripts, movement, weapons and
    // ballistics all run inside the engine; JS only renders the
    // resulting per-tick snapshot.  Created lazily in open() and
    // reused across model loads.
    this._scene = null
    this._unitId = -1
    // Per-viewer cache of loaded projectile meshes (missiles / rockets /
    // bombs), keyed by TDF model name.  The viewer renders the engine's
    // in-flight projectiles as a renderer overlay the same way the sandbox
    // draws them as entities; models load lazily on first sight (a shot
    // skips a frame until its mesh is uploaded into this viewer's GL
    // context).  _projModelLoading guards against duplicate in-flight loads.
    this._projModels = new Map()
    this._projModelLoading = new Set()
    // The raw COB JSON for the current unit (static disassembly +
    // piece / script tables) — backs the debugger's listing and the
    // facade.unit's static fields.
    this._cobJson = null
    // cobDamage drives the GET_UNIT_VALUE port for HEALTH so the
    // user can preview "this unit at 50% health" via the studio's
    // damage popup.  Some bos scripts also emit damage smoke when
    // HEALTH < threshold (the SmokeUnit thread polls in a loop) so
    // bumping this slider lights up the SFX pipeline visibly.
    this.cobDamage = 0
    // Build progress 0-100% drives the BUILD_PERCENT_LEFT port
    // (TA returns 100 - build% via this port so SmokeUnit's intro
    // `while (get BUILD_PERCENT_LEFT)` loop blocks until build
    // completes).  Also drives the renderer's nano-frame fade
    // effect — below 100% the unit renders as a pulsing green
    // wireframe that crossfades into the textured model as it
    // climbs.  Defaults 100 (= fully built) so freshly opened
    // units show their normal textured appearance.
    this.cobBuildPercent = 100
    // cobPorts mirrors the runtime's GET_UNIT_VALUE / SET_VALUE state
    // for the ports the Ports inspector exposes.  Kept on the viewer
    // (not on the runtime/unit) because the studio defines the user-
    // editable defaults — scripts read THESE values, and the Ports
    // panel writes back into THIS object.  Defaults match TA's
    // out-of-the-box unit behaviour (active, roam, fire at will).
    //   activation        — 0 (off) / 1 (on).  Most idle units are 1.
    //   moveOrders        — 0 Hold position / 1 Maneuver / 2 Roam.
    //   fireOrders        — 0 Hold fire / 1 Return fire / 2 Fire at will.
    //   inBuildStance     — 0 / 1.  Read-only here (scripts toggle it
    //                       via SET_VALUE; the panel displays current).
    //   armoured          — 0 / 1.  Read-only.
    //   yardOpen          — 0 / 1.  Set by factory scripts.
    //   buggerOff         — 0 / 1.  Set by factory scripts.
    // Health + build-percent are derived from cobDamage / cobBuildPercent.
    this.cobPorts = {
      activation: 1,
      moveOrders: 2,
      fireOrders: 2,
      inBuildStance: 0,
      armoured: 0,
      yardOpen: 0,
      buggerOff: 0,
    }
    this._pointerState = null
    this._resizeObserver = null
    // _wireInputs runs from open() once `renderer` and `camera` exist
    // — calling it from the constructor would hand attachOrbitControls
    // null refs and silently no-op, leaving the canvas dead to drag /
    // wheel / right-click gestures.
  }

  // scene is the viewer's WasmSandboxScene (the engine MvControls + the
  // inspector panels reach through as `viewer.scene`).  Null before open().
  get scene() { return this._scene }

  // unit is the live WasmUnit adapter for the single simulated unit — the
  // shape the engine-led MvControls drives (pos / heading / moveTarget /
  // attackTarget / binding).  Null before the unit is spawned.
  get unit() {
    return (this._scene && this._unitId >= 0) ? this._scene.unitById(this._unitId) : null
  }

  // attach mounts this viewer's canvas into the given stage element.
  // Idempotent — re-attaching to the same parent is a no-op.  Each
  // unit tab owns its own ModelViewer + canvas; attach() / detach()
  // swap the active tab's canvas into the shared `.model-viewer-stage`
  // so an inactive tab's GL surface is OUT of the DOM tree (can't
  // bleed through, doesn't compete for the framebuffer).  Mirrors the
  // same-named helpers on the multi-entity host so the tab-switch
  // logic can treat both view types uniformly.
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

  // setSilenced flips this viewer's controller (and any audio it
  // owns) to muted/un-muted.  Used by switchToTab on the outgoing
  // tab so weapon sounds + acks don't keep firing in the background.
  // Defined here (rather than only on the controller) so the
  // tab-switch loop can treat every view type the same way — they
  // all expose a `setSilenced(bool)` entry point.
  setSilenced(s) {
    if (this._mvControls && typeof this._mvControls.setSilenced === 'function') {
      try { this._mvControls.setSilenced(!!s) } catch { /* ignore */ }
    }
    // The cob's audio pool is paused via the engine/binding tick
    // when runtime.paused is true, so silencing here is mostly a
    // belt-and-braces measure for sounds the binding might emit
    // between paused-ness flips.
    if (this.cob && this.cob.audio && typeof this.cob.audio.setPaused === 'function') {
      try { this.cob.audio.setPaused(!!s) } catch { /* ignore */ }
    }
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
    // Push HEALTH (= 100 - damage) into the engine's unit-value store so a
    // script's GET_UNIT_VALUE(HEALTH) sees the new value next iteration.
    this._pushPort(4, Math.max(0, 100 - this.cobDamage))
    if (!this.cob || !this.cob.hasScript('SmokeUnit') || this.cobDamage <= 0) return
    const alreadyRunning = this.cob.unit._threads.some(
      (t) => t.script.name.toLowerCase() === 'smokeunit',
    )
    if (!alreadyRunning) this.cob.start('SmokeUnit')
  }

  // setBuildPercent sets the simulated build progress 0..100%.
  // Forwards to the renderer so the nano-frame fade can update on
  // the next draw.  COB scripts polling BUILD_PERCENT_LEFT see the
  // change on their next iteration via the getUnitValue hook.
  setBuildPercent(percent) {
    this.cobBuildPercent = Math.max(0, Math.min(100, +percent || 0))
    if (this.renderer) this.renderer.setBuildPercent(this.cobBuildPercent)
    // Push into the live binding so its sparkle-emit rate tracks
    // the build without poking back at this instance through a
    // window global.
    if (this.cob && typeof this.cob.setBuildPercent === 'function') {
      this.cob.setBuildPercent(this.cobBuildPercent)
    }
    // BUILD_PERCENT_LEFT port (TA returns 100 - build%) so a script's
    // `while (get BUILD_PERCENT_LEFT)` intro loop unblocks at 100%.
    this._pushPort(17, Math.max(0, 100 - this.cobBuildPercent))
  }

  // resetState clears EVERYTHING the user could have driven on the
  // current COB: kills threads, zeroes static vars, returns every
  // animator to its rest pose, drops lifecycle state.  Pieces snap
  // back to their original 3DO positions on the next render tick.
  resetState() {
    if (!this.cob) return
    const unit = this.cob.unit
    // Return the engine's COB VM to a clean script state: kills every
    // thread, zeroes static vars, restores rest pose.  The next render
    // tick paints the snapshot with pieces at their 3DO defaults.
    if (typeof unit.reset === 'function') unit.reset()
    // ResetState in the engine also clears the unit-value port store, so
    // re-push the viewer's current port values (activation / orders /
    // health / build%) — otherwise a script's first GET_UNIT_VALUE after
    // reset would read 0.
    this._pushPorts()
    // Drop lifecycle tracking — Activate/Deactivate go back to a
    // fresh "no idea what state this is" path AND Create gating
    // re-engages (so the user has to click Create again before
    // any other script can fire, matching first-open behaviour).
    this.cob._lifecycle = (this.cob.hasScript && this.cob.hasScript('Create')) ? 'unborn' : 'created'
    // Wipe the debugger's per-unit coverage hints so the next run
    // paints a clean dim/lit map.  Without this, lines that ran
    // before Reset stay lit even though execution starts over from
    // scratch — confusing when the user is using the dim hint to
    // figure out which BPs will fire.
    if (typeof unit.clearExecutedOffsets === 'function') unit.clearExecutedOffsets()
    // Drop SFX particles so smoke + sparks from prior runs vanish.
    if (this.cob.particles) this.cob.particles.count = 0
    // Stop any in-flight audio so a Reset doesn't leave the previous
    // unit's voice-acks playing over the fresh "create" state.
    if (this.cob.audio) this.cob.audio.dispose()
    // Controls overlay state (move target, aim targets, walk pos)
    // gets cleared too so Reset really does mean "start over".
    if (this._mvControls && typeof this._mvControls.resetState === 'function') {
      this._mvControls.resetState()
    }
    // Re-arm the auto-build ramp so Reset visibly replays the
    // construction-phase-in animation — matches "treat this as a
    // freshly-loaded unit", which the user expects.  Cleared first
    // so the global advance loop doesn't keep advancing a stale ramp.
    this._autoBuild = null
    if (typeof window.startMvAutoBuild === 'function') {
      window.startMvAutoBuild(this)
    } else if (typeof this.setBuildPercent === 'function') {
      this.setBuildPercent(0)
    }
    // Force a redraw so the user sees the snap-back even when the
    // renderer's idle (no auto-rotate, no pending animations).
    if (this.renderer) this.renderer.requestRedraw()
  }

  // open initialises (or reuses) the WebGL pipeline and loads the named
  // model.  Subsequent open() calls swap the model in-place without
  // tearing down the GL context.
  async open(modelName) {
    // Remember the current unit so setEnhanceMesh() can reload the same
    // model with the new geometry without the caller re-supplying a name.
    this._modelName = modelName
    this.#setStatus(`Loading ${modelName}…`)
    if (!this.renderer) {
      const palette = await TAPalette.load()
      // Stash the palette on the viewer so external panels (the
      // Controls module's laser-beam tint) can resolve TA palette
      // indices to RGB without re-fetching the JSON.
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
      // Wire shared orbit / pan / zoom gestures now that renderer +
      // camera exist — calling _wireInputs() earlier (constructor)
      // would hand attachOrbitControls null refs and silently no-op,
      // leaving the canvas inert to every camera gesture.
      this._wireInputs()
      // Shaders now live as standalone .vert/.frag files under
      // shaders/ and load over fetch().  init() resolves once they're
      // compiled + linked so the first frame doesn't fire at an
      // un-ready renderer.
      await this.renderer.init()
      this.renderer.start()
      // Follow the shared Enhanced Mesh flag: when the user flips it in
      // the Graphics menu, swap this unit's geometry in place WITHOUT
      // re-running open() (which would reframe the camera).  Subscribed
      // once per viewer; dispose() drops it.
      this._unsubEnhance = onEnhanceMeshChanged(() => { this.reloadGeometry() })
    }
    try {
      if (this.model) this.model.dispose(this.renderer.gl)
      const model = await this.loader.load(modelName)
      this.model = model
      this._sparklePieces = null
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
      // statically.  COB runs inside the wasm engine now; the viewer
      // spawns one unit into its scene and renders the per-tick pose.
      this.cob = null
      this._cobJson = null
      this.renderer.setCobBinding(null)
      try {
        // ?decompile=0 — skip the slow BOS-decompile pass on the
        // initial unit-load fetch.  The debugger fetches a second
        // time (decompile=1) the first time it opens, which keeps
        // model-load latency low for users who never crack open the
        // thread viewer.
        const cobResp = await fetch(`/api/studio/cob/${encodeURIComponent(modelName)}?decompile=0`)
        if (cobResp.ok) {
          const cobJson = await cobResp.json()
          this._cobJson = cobJson
          // Reuse one wasm-backed scene across model loads so the wasm
          // module + engine handle survive a swap.  Each load removes
          // the previous unit and spawns a fresh one.
          if (!this._scene) {
            if (!this._sceneFactory) {
              throw new Error('ModelViewer: sceneFactory was not provided')
            }
            this._scene = this._sceneFactory({ palette: this.palette, seed: 1 })
            await this._scene.ready()
          } else if (this._unitId >= 0) {
            this._scene.removeUnit(this._unitId)
            this._unitId = -1
          }
          // Spawn the unit into the engine.  model:null — the engine's
          // _applyPieces writes the snapshot pose straight onto THIS
          // viewer's rendered model (set below), not a clone, so the
          // single canvas shows the animation.  headingRad = REST so
          // the native pose renders un-rotated.
          const u = await this._scene.addUnit({
            name: modelName, model: null, cobScript: cobJson,
            x: 0, z: 0, headingRad: REST_HEADING, side: 0,
          })
          this._unitId = u.id
          u.model = model
          u.meta = this.unitMeta || u.meta
          // Cancel the auto-spawned Create thread so the unit opens in
          // its raw 3DO rest pose (artists inspect geometry first); the
          // first user command re-runs Create via _ensureCreated.  This
          // also clears the engine's unit-value port store, so push the
          // viewer's port defaults back in.
          this._scene.source.resetUnit(u.id)
          this._pushPorts()
          // Build the render binding + COB facade the renderer, the
          // MvControls engine path and the inspector / debugger panels
          // all read through.
          this.cob = this._buildCob(cobJson, modelName)
          this.renderer.setCobBinding(this.cob, { driveTick: false })
          // Seed one step so the rest pose lands on the model before the
          // first paint (the tab tick loop drives subsequent steps).
          try { this._scene._stepOnce(); this._scene.interpolate() } catch { /* ignore */ }
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
    // Detach the orbit-controls wheel / pointer / key listeners FIRST
    // — they captured the renderer in closure, so once the renderer
    // is disposed below those listeners would otherwise try to fire
    // requestRedraw against a dead GL context.
    if (typeof this._detachInputs === 'function') {
      try { this._detachInputs() } catch { /* ignore */ }
      this._detachInputs = null
    }
    if (typeof this._unsubEnhance === 'function') {
      try { this._unsubEnhance() } catch { /* ignore */ }
      this._unsubEnhance = null
    }
    if (this._resizeObserver) this._resizeObserver.disconnect()
    this._resizeObserver = null
    // Tear down the engine scene (frees the wasm engine handle) before the
    // renderer drops its GL context.
    if (this._scene) {
      try { this._scene.dispose() } catch { /* ignore */ }
      this._scene = null
      this._unitId = -1
    }
    // Free cached projectile meshes before the GL context drops (they hold
    // VBOs in the renderer's context).
    if (this._projModels && this._projModels.size) {
      for (const m of this._projModels.values()) {
        try { m.dispose(this.renderer && this.renderer.gl) } catch { /* ignore */ }
      }
      this._projModels.clear()
    }
    if (this._projModelLoading) this._projModelLoading.clear()
    if (this.renderer) {
      this.renderer.dispose()
      this.renderer = null
    }
    this.cob = null
    this.model = null
    this.camera = null
  }

  setAutoRotate(on) {
    if (this.renderer) this.renderer.setAutoRotate(on)
  }

  // reloadGeometry re-fetches the current unit under the active
  // Enhanced Mesh flag and swaps the mesh in place.  Unlike open() it
  // leaves the camera, orbit angle and zoom untouched — the user toggled
  // a render option, not opened a new unit, so the framing must hold.
  // The geometry comes from a different endpoint response, so this can't
  // be a live shader flip — it re-fetches and rebinds.
  async reloadGeometry() {
    if (!this._modelName || !this.loader || !this.renderer) return
    let model
    try {
      model = await this.loader.load(this._modelName)
    } catch (err) {
      this.#setStatus(`Reload failed: ${err.message || err}`)
      return
    }
    if (this.model) this.model.dispose(this.renderer.gl)
    this.model = model
    this.renderer.setModel(model)
    // Re-point the live unit + COB facade at the fresh piece tree so the
    // engine's per-tick pose lands on the new geometry.  The COB script keeps
    // running inside the engine across the swap — only the render-side model
    // and the sparkle-piece cache are rebuilt.  scene._applyPieces resolves
    // pieces by name, so a primitives-only enhanced-mesh fill still lines up.
    this._sparklePieces = null
    const u = this.unit
    if (u && this._cobJson) {
      u.model = model
      this.cob = this._buildCob(this._cobJson, this._modelName)
      this.renderer.setCobBinding(this.cob, { driveTick: false })
      try { this._scene._stepOnce(); this._scene.interpolate() } catch { /* ignore */ }
    }
    this.renderer.requestRedraw()
    if (this.onModelLoaded) this.onModelLoaded(model, this.cob)
    this.#setStatus(`${this._modelName} · ${model.flat.length} piece${model.flat.length === 1 ? '' : 's'}`)
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
      // Shift the piece-local bounds by the unit's current world
      // transform so the camera frames the MOVED unit — without
      // this offset, clicking a piece on a walking PeeWee that's
      // drifted to (200, 0, -100) would still aim the camera at
      // the unit's spawn origin.  Pulled from the renderer's
      // _unitTransform so both ground walking AND aircraft alt
      // are accounted for.  Rotation isn't applied because the
      // piece bounds are still axis-aligned in the unit's local
      // frame; we just translate them into world space.
      const ut = this.renderer?._unitTransform
      if (ut) {
        min[0] += ut.x; max[0] += ut.x
        min[1] += ut.y; max[1] += ut.y
        min[2] += ut.z; max[2] += ut.z
      }
      // Padding factor 4.0 (was 1.6) — small pieces like a single
      // flare or muzzle would otherwise snap so close that the
      // user lost spatial context with the rest of the unit.  At
      // 4× the piece's bbox half-extent the camera frames the
      // piece plus a generous halo of surrounding hull, so it
      // reads as "this is the piece, here's where it sits on the
      // unit" rather than "you're inside the part now".
      this.camera.frameBounds(min, max, 4.0)
      this.renderer.requestRedraw()
    }
  }

  // ── private ────────────────────────────────────────────────────────

  // _pushPort writes one COB unit-value port into the engine's writable
  // store so a script's GET_UNIT_VALUE(port) reads the studio-chosen value
  // on its next iteration.  No-op until the unit is spawned.
  _pushPort(port, value) {
    if (this._scene && this._unitId >= 0) {
      try { this._scene.source.setUnitValue(this._unitId, port | 0, value | 0) } catch { /* ignore */ }
    }
  }

  // _pushPorts re-asserts every port the studio drives.  Called after spawn
  // and after resetUnit (the engine's ResetState clears the port store, so
  // without this a script's first GET_UNIT_VALUE post-reset reads 0).
  _pushPorts() {
    const p = this.cobPorts
    this._pushPort(1, p.activation)          // ACTIVATION
    this._pushPort(2, p.moveOrders)          // STANDINGMOVEORDERS
    this._pushPort(3, p.fireOrders)          // STANDINGFIREORDERS
    this._pushPort(4, Math.max(0, 100 - this.cobDamage))        // HEALTH
    this._pushPort(5, p.inBuildStance)       // INBUILDSTANCE
    this._pushPort(17, Math.max(0, 100 - this.cobBuildPercent)) // BUILD_PERCENT_LEFT
    this._pushPort(18, p.yardOpen)           // YARD_OPEN
    this._pushPort(19, p.buggerOff)          // BUGGER_OFF
    this._pushPort(20, p.armoured)           // ARMORED
  }

  // _liveCobUnit returns the engine's live COB inspection record for this
  // viewer's unit — { id, name, static:[…], threads:[…] } — memoised per
  // tick by the scene.  Null before the unit is spawned.
  _liveCobUnit() {
    if (!this._scene || this._unitId < 0) return null
    const snap = this._scene._cobSnapshot()
    if (!snap || !snap.units) return null
    return snap.units.find((cu) => cu.id === this._unitId) || null
  }

  // _buildCob assembles the COB facade the renderer, the engine-led
  // MvControls path and the inspector / debugger panels all read through.
  // COB itself runs inside the wasm engine; this object is a thin shim that
  //   • delegates render resources (particles / audio / scene-lights) to the
  //     scene's per-unit binding,
  //   • exposes the live thread + static-var state from the engine snapshot,
  //   • routes every debug / control op (step, breakpoints, var edits, kills,
  //     coverage) into the new wasm debug exports, and
  //   • keeps the static disassembly tables (scripts / scriptNames /
  //     pieceNames / decompiled) the debugger maps PC → source line against.
  _buildCob(cobJson, modelName) {
    const viewer = this
    const scene = this._scene
    const source = scene.source
    const unitId = this._unitId
    const binding = scene.unitById(unitId)?.binding || {}
    const scripts = cobJson.scripts || []
    const scriptNames = cobJson.scriptNames || []
    const pieceNames = cobJson.pieceNames || []
    // Lower-cased script-name → { script, index } so the thread adapter can
    // attach the static instruction list (the engine snapshot ships only a
    // script NAME per thread) and so breakpoint / coverage ops can resolve a
    // name to the engine's script index.
    const scriptByLower = new Map()
    scripts.forEach((s, i) => { if (s && s.name) scriptByLower.set(s.name.toLowerCase(), { script: s, index: i }) })
    const scriptIndex = (name) => {
      const lower = (name || '').toLowerCase()
      const byScripts = scriptByLower.get(lower)
      if (byScripts) return byScripts.index
      return scriptNames.findIndex((n) => n && n.toLowerCase() === lower)
    }

    // ── facade.unit — stable object (built once per open) so the debugger's
    // scratch fields (_bosMap, _asmToBos, _globalNames, …) survive ticks. ──
    const unit = {
      name: modelName,
      scriptOriginName: modelName,
      scripts,
      scriptNames,
      pieceNames,
      numStaticVars: cobJson.numStaticVars || 0,
      decompiled: cobJson.decompiled || '',
      _breakpoints: new Set(),
      _coverageBaseline: new Map(),
      killThreadById(id) { source.killThread(unitId, id); scene._invalidateCob() },
      killThreadsByName(name) { source.killThreadsByName(unitId, name); scene._invalidateCob() },
      killAllThreads() { source.killUnitThreads(unitId); scene._invalidateCob() },
      reset() { source.resetUnit(unitId); scene._invalidateCob() },
      setThreadLocal(threadId, idx, v) { source.setThreadLocal(unitId, threadId, idx, v | 0); scene._invalidateCob() },
      setStatic(idx, v) { source.setStaticVar(unitId, idx, v | 0); scene._invalidateCob() },
      setThreadPc(threadId, pcIdx) { source.setThreadPc(unitId, threadId, pcIdx | 0); scene._invalidateCob() },
      addBreakpoint(scriptName, offset) {
        const idx = scriptIndex(scriptName)
        if (idx < 0) return
        source.addBreakpoint(unitId, idx, offset >>> 0)
        this._breakpoints.add(`${(scriptName || '').toLowerCase()}:${offset >>> 0}`)
      },
      removeBreakpoint(scriptName, offset) {
        const idx = scriptIndex(scriptName)
        if (idx < 0) return
        source.removeBreakpoint(unitId, idx, offset >>> 0)
        this._breakpoints.delete(`${(scriptName || '').toLowerCase()}:${offset >>> 0}`)
      },
      hasBreakpoint(scriptName, offset) {
        return this._breakpoints.has(`${(scriptName || '').toLowerCase()}:${offset >>> 0}`)
      },
      clearBreakpoints() {
        source.clearBreakpoints(unitId)
        this._breakpoints.clear()
      },
      // clearExecutedOffsets snapshots the engine's current coverage as a
      // baseline; subsequent _executedOffsets reads subtract it so the
      // debugger's dimming view restarts clean after a Reset / re-run.
      clearExecutedOffsets() {
        const cov = source.coverage(unitId) || {}
        const base = new Map()
        for (const key of Object.keys(cov)) {
          const sname = scriptNames[parseInt(key, 10)]
          if (sname) base.set(sname.toLowerCase(), new Set(cov[key]))
        }
        this._coverageBaseline = base
      },
      // usesUnitValuePort reports whether any script reads/writes the given
      // GET_UNIT_VALUE port (a PUSH_IMM <port> immediately followed by a
      // GET_UNIT_VALUE / GET / SET_VALUE).  Drives the Controls panel's
      // "show Armoured toggle" gate.
      usesUnitValuePort(port) {
        for (const s of scripts) {
          const insts = s.instructions || []
          for (let i = 0; i < insts.length - 1; i++) {
            const a = insts[i]
            const b = insts[i + 1]
            if (a && a.name === 'PUSH_IMM' && a.p1 === port &&
                b && (b.name === 'GET_UNIT_VALUE' || b.name === 'GET' || b.name === 'SET_VALUE')) {
              return true
            }
          }
        }
        return false
      },
    }
    Object.defineProperty(unit, '_threads', {
      get() {
        const live = viewer._liveCobUnit()
        if (!live || !live.threads) return []
        return live.threads.map((t) => {
          const entry = scriptByLower.get((t.script || '').toLowerCase())
          return {
            id: t.id,
            pc: t.pc,
            offset: t.offset,
            sleepMs: t.sleepMs,
            signalMask: t.signalMask,
            breakpointHit: !!t.breakpointHit,
            locals: t.locals || [],
            stack: t.stack || [],
            dead: false,
            waitOn: t.waiting ? { type: t.waitTurn ? 'turn' : 'move' } : null,
            script: entry ? entry.script : { name: t.script, instructions: [] },
          }
        })
      },
    })
    Object.defineProperty(unit, 'staticVars', {
      get() { const live = viewer._liveCobUnit(); return (live && live.static) || [] },
    })
    Object.defineProperty(unit, '_executedOffsets', {
      get() {
        const cov = source.coverage(unitId) || {}
        const out = new Map()
        for (const key of Object.keys(cov)) {
          const sname = scriptNames[parseInt(key, 10)]
          if (!sname) continue
          const lower = sname.toLowerCase()
          const baseline = unit._coverageBaseline.get(lower)
          let set = out.get(lower)
          if (!set) { set = new Set(); out.set(lower, set) }
          for (const off of cov[key]) {
            if (baseline && baseline.has(off)) continue
            set.add(off)
          }
        }
        return out
      },
    })

    // ── facade.runtime — the scene's runtime facade, augmented in place to
    // present THIS unit (the viewer owns its scene exclusively). ──
    const runtime = scene._runtime
    runtime.units = () => [unit]
    runtime.findThreadById = (tid) => {
      for (const t of unit._threads) if (t.id === tid) return { thread: t, unit }
      return null
    }
    runtime.stepOne = (tid) => { source.stepThread(unitId, tid); scene._invalidateCob() }
    unit.runtime = runtime

    // ── facade root ──
    const cob = {
      unit,
      runtime,
      particles: binding.particles,
      audio: binding.audio,
      worldOffset: binding.worldOffset || { x: 0, y: 0, z: 0 },
      buildPercent: this.cobBuildPercent,
      _lifecycle: 'created',
      _renderer: this.renderer,
      hasScript: (name) => scriptByLower.has((name || '').toLowerCase()),
      listScripts: () => scriptNames.slice(),
      start: (name, args = []) => { source.startScript(unitId, name, args); scene._invalidateCob() },
      setBuildPercent: (pct) => { cob.buildPercent = Math.max(0, Math.min(100, +pct || 0)) },
      getSceneLight: () => (typeof binding.getSceneLight === 'function' ? binding.getSceneLight() : null),
      getSceneLights: () => (typeof binding.getSceneLights === 'function' ? binding.getSceneLights() : []),
      _emitShipWake: (worldPos, headingRad) => viewer._emitShipWake(worldPos, headingRad),
      // tick advances the engine, samples the interpolated pose, ages
      // sparkles, then autopauses the tab tick loop if any thread just hit a
      // breakpoint (the loop reads runtime.paused and stops stepping).
      tick: (dtMs) => {
        scene.tick(dtMs)
        scene.interpolate()
        // Push the engine's in-flight projectile meshes to the renderer so
        // missiles / rockets / bombs draw in the viewer the same way they do
        // in the sandbox (the muzzle-offset fix in scene._syncProjectiles
        // rides along, since both views read scene.projectiles()).
        viewer._syncOverlayProjectiles()
        if (!runtime.paused) viewer._emitBuildSparkles(dtMs)
        if (!runtime.paused) {
          const live = viewer._liveCobUnit()
          if (live && live.threads && live.threads.some((t) => t.breakpointHit)) {
            runtime.setPaused(true)
          }
        }
      },
    }
    return cob
  }

  // _emitBuildSparkles spits bright-green pulses across the unit's geometry
  // while the build-% ramp is active, fading out as the unit solidifies — the
  // construction phase-in's "transporter" shimmer.  Ported from the retired
  // JS binding; reads build% off the viewer and emits into the scene binding's
  // particle pool.
  _emitBuildSparkles(dtMs) {
    const buildPct = this.cobBuildPercent
    if (buildPct == null || buildPct >= 100) return
    const model = this.model
    const particles = this.cob && this.cob.particles
    if (!model || !particles) return
    const incomplete = Math.max(0, Math.min(1, 1 - buildPct / 100))
    const rateHz = 90 * incomplete
    this._sparkleAcc = (this._sparkleAcc || 0) + (dtMs * rateHz / 1000)
    let toEmit = Math.floor(this._sparkleAcc)
    if (toEmit < 1) return
    this._sparkleAcc -= toEmit
    if (toEmit > 12) toEmit = 12
    if (!this._sparklePieces) {
      this._sparklePieces = model.flat.filter((p) => p._tris && p._tris.length >= 9)
    }
    const pieces = this._sparklePieces
    if (!pieces || pieces.length === 0) return
    for (let i = 0; i < toEmit; i++) {
      const piece = pieces[(Math.random() * pieces.length) | 0]
      if (!piece || !piece.visible || !piece.worldMatrix) continue
      const tris = piece._tris
      const triCount = (tris.length / 9) | 0
      if (triCount === 0) continue
      const tBase = ((Math.random() * triCount) | 0) * 9
      let u = Math.random()
      let v = Math.random()
      if (u + v > 1) { u = 1 - u; v = 1 - v }
      const w = 1 - u - v
      const lx = tris[tBase] * w + tris[tBase + 3] * u + tris[tBase + 6] * v
      const ly = tris[tBase + 1] * w + tris[tBase + 4] * u + tris[tBase + 7] * v
      const lz = tris[tBase + 2] * w + tris[tBase + 5] * u + tris[tBase + 8] * v
      const m = piece.worldMatrix
      const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12]
      const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13]
      const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14]
      particles.emit(SFX_SPARK, [wx, wy, wz], {
        color: [0.30, 1.80, 0.80, 1.0], size: 2.5, lifeMs: 350, riseSpeed: 0.0, drift: 0.0,
      })
    }
  }

  // _emitShipWake drops a pair of foamy puffs at the ship's wake1 / wake2
  // pieces (or a stern fallback when the artist left them at the pivot).
  // Called by MvControls while a ship is moving.  Ported from the retired JS
  // binding; emits into the scene binding's particle pool.
  _emitShipWake(worldPos, headingRad) {
    const model = this.model
    const particles = this.cob && this.cob.particles
    if (!model || !particles) return
    const sinH = Math.sin(headingRad)
    const cosH = Math.cos(headingRad)
    const b = model.bounds
    const sternZ = b ? b.min[2] : 0
    const halfBeam = b ? (b.max[0] - b.min[0]) * 0.25 : 4
    const waterY = b ? b.min[1] + 1 : 0
    const emitAt = (piece, fallbackLocalX) => {
      let ox = piece && piece.origin ? piece.origin[0] : 0
      let oy = piece && piece.origin ? piece.origin[1] : 0
      let oz = piece && piece.origin ? piece.origin[2] : 0
      const hasOrigin = Math.abs(ox) + Math.abs(oy) + Math.abs(oz) > 0.1
      if (!hasOrigin) { ox = fallbackLocalX; oy = waterY; oz = sternZ }
      const wx = worldPos[0] + (ox * cosH + oz * sinH)
      const wy = (worldPos[1] || 0) + oy
      const wz = worldPos[2] + (-ox * sinH + oz * cosH)
      particles.emit(SFX_SMOKE_WHITE, [wx, wy, wz], {
        size: 9, lifeMs: 1400, riseSpeed: 0.3, drift: 1.2, color: [0.95, 0.97, 1.0, 0.85],
      })
    }
    emitAt(model.findPiece('wake1'), -halfBeam)
    emitAt(model.findPiece('wake2'), halfBeam)
  }

  // _syncOverlayProjectiles hands the renderer the engine's current in-flight
  // model-projectiles so they draw on top of the viewed unit.  Mirrors the
  // sandbox's projectile-entity build (heading straight through, pitch negated
  // — see view.js #refreshEntities): the projectile 3DO is authored nose-+Z,
  // so it needs no +π yaw compensator and the renderer's Rx(pitch) is the
  // inverse of the flight pitch.  Model-less shots (cannon shells / EMG bolts)
  // carry no .model and are left to the particle pool.
  _syncOverlayProjectiles() {
    const renderer = this.renderer
    const scene = this._scene
    if (!renderer || typeof renderer.setOverlayProjectiles !== 'function') return
    const projos = (scene && typeof scene.projectiles === 'function') ? scene.projectiles() : null
    if (!projos || projos.length === 0) {
      renderer.setOverlayProjectiles(null)
      return
    }
    const out = []
    for (const proj of projos) {
      if (!proj || !proj.model) continue
      const pm = this._ensureProjModel(proj.model)
      if (!pm) continue
      out.push({
        model: pm,
        transform: {
          x: proj.pos.x, y: proj.pos.y, z: proj.pos.z,
          headingRad: proj.heading,
          pitchRad: -proj.pitch,
        },
      })
    }
    renderer.setOverlayProjectiles(out.length ? out : null)
  }

  // _ensureProjModel returns the loaded projectile Model for a TDF model name,
  // kicking off a lazy load on first sight (idempotent — concurrent loads of
  // the same name are coalesced via _projModelLoading).  Returns null until
  // the load resolves; the projectile simply skips a frame.
  _ensureProjModel(name) {
    if (!name || !this.loader) return null
    const cached = this._projModels.get(name)
    if (cached) return cached
    if (this._projModelLoading.has(name)) return null
    this._projModelLoading.add(name)
    this.loader.load(name).then((m) => {
      this._projModelLoading.delete(name)
      this._projModels.set(name, m)
      if (this.renderer) this.renderer.requestRedraw()
    }).catch(() => { this._projModelLoading.delete(name) })
    return null
  }

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
    // Orbit / pan / zoom gestures live in a shared module so single-
    // entity and multi-entity host views feel identical.  The
    // onUserInteract callback drops view-side state (Tracking
    // checkbox, auto-rotate UI mirror) the camera-controls module
    // can't reach on its own.
    this._detachInputs = attachOrbitControls({
      canvas: this.canvas,
      renderer: this.renderer,
      camera: this.camera,
      dialogId: 'model-viewer-dialog',
      onUserInteract: (kind) => {
        if (kind === 'pan' && this._mvControls?.tracking) {
          this._mvControls.setTracking(false)
        }
        // Wheel-during-auto-rotate stops the rotation visually at the
        // renderer; the host's window-level notifier flips the React
        // Camera dropdown's check-mark + persisted cache through one
        // entry point so a future click re-arms cleanly.  Optional —
        // missing in test harnesses, in which case the rotation just
        // stops without the UI mirror.
        if (kind === 'wheel' && typeof window !== 'undefined' &&
            typeof window.__mvNotifyAutoRotateOff === 'function') {
          try { window.__mvNotifyAutoRotateOff() } catch { /* ignore */ }
        }
      },
    })
  }
}
