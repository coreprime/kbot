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
    // Pending placement — set when the user picks a unit in the spawn
    // dialog.  Holds the loaded model + (optional) preloaded COB so
    // a mouse-driven ghost preview can follow the cursor on the
    // ground plane.  Click confirms the spawn at the current ghost
    // pos; Escape / right-click cancels.
    this._placement = null  // { name, model, cobScript, pos: {x, z} }
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

  // beginPlacement loads the unit's geometry + COB up front (so the
  // ghost preview snaps in without a network round-trip on every
  // mouse move) and enters placement mode.  The next canvas click on
  // the ground plane commits the spawn at the cursor; Escape or
  // right-click cancels.  Calling this with a unit that's already
  // pending placement is a no-op.
  async beginPlacement(name) {
    if (!this.loader || !this.scene) return false
    if (this._placement && this._placement.name === name) return true
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
      this._placement = { name, model, cobScript, pos: { x: tx, z: tz } }
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
    this.#setStatus('Placement cancelled.')
  }

  // setPendingCommand — called by the controls UI when the user
  // clicks Move / Attack.  Next canvas click consumes it.  Also
  // flips the canvas cursor so the user has an unambiguous visual
  // signal that an action is armed (the unit-editor uses a custom
  // animated TA cursor for the same purpose; sandbox falls back to
  // a CSS crosshair so we don't need to plumb MvControls' overlay
  // <img> machinery through the multi-unit pipeline).
  setPendingCommand(cmd) {
    this._pendingCmd = (cmd === 'move' || cmd === 'attack') ? cmd : null
    if (this.canvas) {
      this.canvas.style.cursor = this._pendingCmd ? 'crosshair' : ''
    }
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
      entities.push({
        model: u.model,
        binding: u.binding,
        buildPercent: u.buildPercent,
        transform: { x: u.pos.x, y: u.pos.y + lift, z: u.pos.z, headingRad: u.heading + Math.PI },
        selected: this.scene.isSelected(u.id),
      })
    }
    // Placement ghost — appended LAST so it draws over the live units
    // (renderer iterates entities in order).  The renderer checks
    // ent.ghost and emits a translucent green wireframe instead of a
    // solid main pass.
    if (this._placement && this._placement.model) {
      const p = this._placement
      const lift = p.model.bounds ? -p.model.bounds.min[1] : 0
      entities.push({
        model: p.model,
        transform: { x: p.pos.x, y: lift, z: p.pos.z, headingRad: Math.PI },
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
    // Esc cancels placement.  Bound on window because the canvas
    // doesn't take focus by default (would need tabindex), and Esc
    // there feels more "global cancel" anyway.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._placement) {
        this.cancelPlacement()
      }
    })
  }

  // #onMouseMove updates the ghost preview's position to follow the
  // cursor on the ground plane.  Cheap: just a screen-to-ground
  // unproject; the renderer re-builds the entity transforms each
  // frame anyway.
  #onMouseMove(e) {
    if (!this._placement) return
    const rect = this.canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const world = this.#screenToGround(sx, sy)
    if (!world) return
    this._placement.pos.x = world[0]
    this._placement.pos.z = world[2]
    this.#refreshEntities()
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
    let n = 0
    for (const id of this.scene.selected) {
      const u = this.scene.unitById(id)
      if (u) { u.moveTarget = { x: world[0], z: world[2] }; u.attackTarget = null; n++ }
    }
    this.#setStatus(`Move — ${n} unit(s) heading to (${world[0].toFixed(0)}, ${world[2].toFixed(0)}).`)
  }

  #onClick(e) {
    if (!this.scene) return
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
      })
      // Auto-run Create on spawn so the unit immediately settles into
      // its idle pose (flares hidden, panels at rest).
      if (inst && inst.cobUnit && inst.cobUnit.scriptNames && inst.cobUnit.scriptNames.includes('Create')) {
        try { inst.cobUnit.start('Create') } catch { /* ignore */ }
      }
      this.#setStatus(`Spawned ${p.name} at (${x.toFixed(0)}, ${z.toFixed(0)}) — ${this.scene.unitCount()} unit${this.scene.unitCount() === 1 ? '' : 's'} on field.`)
      // Keep placement active so the user can drop multiple copies of
      // the same unit in quick succession.  Esc / right-click cancels.
      this.#refreshEntities()
      return
    }
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
      if (this.canvas) this.canvas.style.cursor = ''
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
      } else if (!hit) {
        this.#setStatus('Attack — click cancelled (no unit under cursor).')
      }
      this._pendingCmd = null
      if (this.canvas) this.canvas.style.cursor = ''
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
