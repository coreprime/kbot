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
import { TAPalette } from './ta-palette.js'
import { SandboxScene } from './sandbox-scene.js'

export class SandboxView {
  constructor({ canvas, statusEl, onModelLoaded } = {}) {
    this.canvas = canvas
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
    }
    if (!this.scene) this.scene = new SandboxScene()
    // Empty-scene framing — camera looks at a generous patch of
    // ground so spawned units have room around the origin.
    this.camera.frameBounds([-200, 0, -200], [200, 40, 200])
    this.camera.yaw = 215 * Math.PI / 180
    this.camera.pitch = 28 * Math.PI / 180
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
      this.#refreshEntities()
    }
    this.#wirePointer()
    this.#setStatus('Sandbox ready — click "Spawn Unit" to add a unit to the field.')
    if (this.onModelLoaded) this.onModelLoaded(null, null)
  }

  // spawn loads geometry + COB for `name` and adds a unit instance to
  // the scene at (x, z).  Returns the new UnitInstance (or null on
  // failure).  Loader caches by name so repeated spawns of the same
  // unit reuse the parsed model + uploaded textures.
  async spawn(name, { x = 0, z = 0, headingRad = 0 } = {}) {
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
      const inst = this.scene.addUnit({ name, model, cobScript, x, z, headingRad })
      // Auto-run Create on spawn so the unit immediately settles into
      // its idle pose (flares hidden, panels at rest) without the user
      // having to click anything per-unit.  Skipped silently when the
      // unit has no Create script.
      if (inst.cobUnit && inst.cobUnit.scriptNames && inst.cobUnit.scriptNames.includes('Create')) {
        try { inst.cobUnit.start('Create') } catch { /* ignore */ }
      }
      this.#refreshEntities()
      this.#setStatus(`Spawned ${name} at (${x.toFixed(0)}, ${z.toFixed(0)}) — ${this.scene.unitCount()} unit${this.scene.unitCount() === 1 ? '' : 's'} on field.`)
      return inst
    } catch (err) {
      this.#setStatus(`Spawn failed: ${err.message || err}`)
      return null
    }
  }

  // setPendingCommand — called by the controls UI when the user
  // clicks Move / Attack.  Next canvas click consumes it.
  setPendingCommand(cmd) {
    this._pendingCmd = (cmd === 'move' || cmd === 'attack') ? cmd : null
    if (this._pendingCmd) {
      this.#setStatus(`${cmd[0].toUpperCase() + cmd.slice(1)} — click a ${cmd === 'attack' ? 'target unit' : 'destination'}.`)
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
      entities.push({
        model: u.model,
        binding: u.binding,
        buildPercent: u.buildPercent,
        transform: { x: u.pos.x, y: u.pos.y, z: u.pos.z, headingRad: u.heading },
        selected: this.scene.isSelected(u.id),
      })
    }
    this.renderer.setEntities(entities)
  }

  #wirePointer() {
    if (this._pointerWired) return
    this._pointerWired = true
    const canvas = this.canvas
    canvas.addEventListener('click', (e) => this.#onClick(e))
  }

  #onClick(e) {
    if (!this.scene) return
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    // Project the click into world coords on the ground plane via
    // the camera's screen-to-world helper (if available).  Fall back
    // to selecting the nearest unit by screen-projected distance.
    const world = this.#screenToGround(sx, sy)
    // If a command is pending (Move / Attack), consume it.
    if (this._pendingCmd === 'move' && world && this.scene.selected.size > 0) {
      for (const id of this.scene.selected) {
        const u = this.scene.unitById(id)
        if (u) u.moveTarget = { x: world[0], z: world[2] }
      }
      this._pendingCmd = null
      this.#setStatus(`Move order issued to ${this.scene.selected.size} unit(s).`)
      return
    }
    if (this._pendingCmd === 'attack') {
      const hit = this.#pickUnitAt(sx, sy)
      if (hit && this.scene.selected.size > 0) {
        for (const id of this.scene.selected) {
          if (id === hit.id) continue  // don't attack self
          const u = this.scene.unitById(id)
          if (u) u.attackTarget = hit
        }
        this.#setStatus(`Attack order issued — ${this.scene.selected.size} unit(s) targeting ${hit.name}.`)
      }
      this._pendingCmd = null
      return
    }
    // Default click — selection.  Click on a unit selects only it;
    // click on empty ground clears selection.
    const picked = this.#pickUnitAt(sx, sy)
    if (picked) {
      this.scene.selectOnly(picked.id)
      this.#setStatus(`Selected ${picked.name} (HP ${picked.health}).`)
    } else {
      this.scene.selectClear()
      this.#setStatus(`Selection cleared.`)
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
    if (this.renderer) this.renderer.dispose()
    this.renderer = null
    this.scene = null
  }
}
