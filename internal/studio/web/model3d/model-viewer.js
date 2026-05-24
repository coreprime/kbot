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
  }

  // resetState clears EVERYTHING the user could have driven on the
  // current COB: kills threads, zeroes static vars, returns every
  // animator to its rest pose, drops lifecycle state.  Pieces snap
  // back to their original 3DO positions on the next render tick.
  resetState() {
    if (!this.cob) return
    const unit = this.cob.unit
    const rt = this.cob.runtime
    unit.killAllThreads()
    // Clear thread list completely (killAllThreads only marks
    // dead; the next tick removes them, but we want it INSTANT).
    unit._threads.length = 0
    unit._recentlyKilled.length = 0
    // Zero static vars in place so any subsequent script start
    // sees the same blank-slate state Create would have set up.
    for (let i = 0; i < unit.staticVars.length; i++) unit.staticVars[i] = 0
    // Drop every animator slot so pieceOffset / pieceRotation
    // return 0 immediately — the per-frame sync writes 0/0/0 into
    // piece.move/rotate and the renderer draws the rest pose.
    unit._moveAnims.length = 0
    unit._rotAnims.length = 0
    // Reset the runtime-wide tick accumulator so the next script
    // run starts at a clean clock.  Playback rate is intentionally
    // preserved — the user dialled it in and would expect Reset
    // to keep their slow-mo / fast-forward setting.
    rt._tickAccumMs = 0
    // Restore every piece to fully visible — Create() typically
    // hides muzzle flares + decorative panels, so the visibility
    // state needs explicit reset back to the 3DO default of
    // "everything shown".
    for (let i = 0; i < unit._pieceVisible.length; i++) unit._pieceVisible[i] = true
    // Reset the render-flag arrays to their defaults too — Create
    // typically calls hide / dont-shade on flares to set up the
    // idle pose, and Reset State should mimic the freshly-loaded
    // state where every flag is back to TA's engine default.
    for (let i = 0; i < unit._pieceShade.length; i++)  unit._pieceShade[i]  = true
    for (let i = 0; i < unit._pieceCache.length; i++)  unit._pieceCache[i]  = false
    for (let i = 0; i < unit._pieceShadow.length; i++) unit._pieceShadow[i] = true
    // Drop lifecycle tracking — Activate/Deactivate go back to a
    // fresh "no idea what state this is" path AND Create gating
    // re-engages (so the user has to click Create again before
    // any other script can fire, matching first-open behaviour).
    this.cob._lifecycle = (this.cob.hasScript && this.cob.hasScript('Create')) ? 'unborn' : 'created'
    // Drop SFX particles so smoke + sparks from prior runs vanish.
    if (this.cob.particles) this.cob.particles.count = 0
    // Controls overlay state (move target, aim targets, walk pos)
    // gets cleared too so Reset really does mean "start over".
    if (this._mvControls && typeof this._mvControls.resetState === 'function') {
      this._mvControls.resetState()
    }
    // Force a redraw so the user sees the snap-back even when the
    // renderer's idle (no auto-rotate, no pending animations).
    if (this.renderer) this.renderer.requestRedraw()
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
        // ?decompile=0 — skip the slow BOS-decompile pass on the
        // initial unit-load fetch.  The debugger fetches a second
        // time (decompile=1) the first time it opens, which keeps
        // model-load latency low for users who never crack open the
        // thread viewer.
        const cobResp = await fetch(`/api/studio/cob/${encodeURIComponent(modelName)}?decompile=0`)
        if (cobResp.ok) {
          const cobJson = await cobResp.json()
          // Reuse the host runtime across model loads so its time
          // state + paused flag survive a swap.  Each model load
          // tears down its previous unit and registers a fresh one.
          if (!this._runtime) this._runtime = new CobRuntime()
          if (this._unit) {
            this._runtime.removeUnit(this._unit)
            this._unit = null
          }
          const hooks = {
            // Tag log lines so they're easy to spot in the console.
            log: (msg) => console.warn(`[cob:${modelName}]`, msg),
            // Provide the unit-value port reads the bos scripts
            // query.  Most ports read from cobPorts (which the user
            // can edit via the Ports inspector); HEALTH and
            // BUILD_PERCENT_LEFT derive from the cobDamage /
            // cobBuildPercent sliders so the existing Unit Attributes
            // UI stays the source of truth for those two.
            getUnitValue: (port) => {
              switch (port) {
                case 1:  /* ACTIVATION         */ return this.cobPorts.activation | 0
                case 2:  /* STANDINGMOVEORDERS */ return this.cobPorts.moveOrders | 0
                case 3:  /* STANDINGFIREORDERS */ return this.cobPorts.fireOrders | 0
                case 4:  /* HEALTH             */ return Math.max(0, 100 - (this.cobDamage || 0))
                case 5:  /* INBUILDSTANCE      */ return this.cobPorts.inBuildStance | 0
                case 17: /* BUILD_PERCENT_LEFT */ return Math.max(0, 100 - (this.cobBuildPercent || 0))
                case 18: /* YARD_OPEN          */ return this.cobPorts.yardOpen | 0
                case 19: /* BUGGER_OFF         */ return this.cobPorts.buggerOff | 0
                case 20: /* ARMORED            */ return this.cobPorts.armoured | 0
                default: return 0
              }
            },
            // setUnitValue is invoked by SET_VALUE opcodes (rare —
            // mostly factory scripts toggle YARD_OPEN / BUGGER_OFF
            // and IN_BUILD_STANCE during build cycles).  Write-back
            // keeps the Ports panel + cobDamage/cobBuildPercent in
            // sync with what the running scripts have done.
            setUnitValue: (port, value) => {
              const v = value | 0
              switch (port) {
                case 1:  this.cobPorts.activation = v ? 1 : 0; break
                case 2:  this.cobPorts.moveOrders = Math.max(0, Math.min(2, v)); break
                case 3:  this.cobPorts.fireOrders = Math.max(0, Math.min(2, v)); break
                case 4:  this.cobDamage = Math.max(0, Math.min(100, 100 - v)); break
                case 5:  this.cobPorts.inBuildStance = v ? 1 : 0; break
                case 17: this.cobBuildPercent = Math.max(0, Math.min(100, 100 - v)); break
                case 18: this.cobPorts.yardOpen = v ? 1 : 0; break
                case 19: this.cobPorts.buggerOff = v ? 1 : 0; break
                case 20: this.cobPorts.armoured = v ? 1 : 0; break
              }
            },
          }
          this._unit = this._runtime.addUnit(cobJson, hooks)
          // Cache the decompiled BOS source on the unit so the
          // thread-debugger's right pane can render side-by-side
          // without an extra fetch.  Empty string when the initial
          // ?decompile=0 fetch skipped it (debugger will fetch on
          // open).
          this._unit.decompiled = cobJson.decompiled || ''
          this._unit.name = modelName
          this.cob = new CobBinding(model, this._unit)
          this.renderer.setCobBinding(this.cob)
          // Earlier this auto-fired Create + Activate so freshly-
          // opened units stood in their idle "deployed" pose
          // (factories with doors open, gantries with tower raised,
          // construction bots with guncase open).  That hid the
          // raw 3DO rest state, which is what most artists need to
          // see when inspecting a model.  Removed — the user opens
          // the unit in its un-animated rest geometry, then drives
          // Create / Activate / etc from the Actions panel.
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
        // Shift = axis-locked pan.  Picks the dominant axis from
        // the gesture's accumulated motion (not just this delta —
        // a single frame's dy can flicker between zero and a few
        // pixels) and zeroes the other so the pan reads as a
        // clean vertical OR horizontal slide instead of drifting
        // diagonally.  Plain right-drag still pans freely.
        if (e.shiftKey) {
          // Intentional camera move overrides any active follow-
          // the-unit tracking.  Otherwise the next render frame's
          // _followCamera would yank the target straight back to
          // the unit and undo the pan.
          if (this._mvControls?.tracking) this._mvControls.setTracking(false)
          const acc = this._pointerState
          acc.lockDxAccum = (acc.lockDxAccum || 0) + dx
          acc.lockDyAccum = (acc.lockDyAccum || 0) + dy
          if (Math.abs(acc.lockDxAccum) > Math.abs(acc.lockDyAccum)) {
            this.camera.panBy(dx, 0)
          } else {
            this.camera.panBy(0, dy)
          }
        } else {
          this.camera.panBy(dx, dy)
        }
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
