// create-world.js — the package's top-level factory.
//
// createWorld(canvas, { assets, game }) assembles the full renderer
// stack the studio sandbox builds by hand — palette, texture cache,
// model loader, ModelRenderer, OrbitCamera — against ANY AssetProvider,
// and returns a small world handle for driving it:
//
//   const world = await createWorld(canvas, { assets: provider })
//   const id = await world.addUnit('armpw', { x: 0, z: 0 })
//   world.step(16)                 // render one frame
//   world.moveUnit(id, { x: 40 })
//   world.dispose()
//
// The world is renderer-only: it draws whatever unit/projectile state
// it is given and knows no game rules.  Simulation (movement, COB
// animation, combat) belongs to a driver — typically @kbot/engine,
// whose per-tick snapshot maps straight onto applyState().

import { TAPalette } from './palette.js'
import { TextureCache } from './texture-cache.js'
import { ModelLoader, setLodHidePatterns } from './model-loader.js'
import { ModelRenderer } from './model-renderer.js'
import { OrbitCamera } from './orbit-camera.js'
import { attachOrbitControls } from './camera-controls.js'
import { setAssetProvider } from './assets.js'
import { setTeamSides, teamColorForSide } from './team-colors.js'
import { setProjectileFallbackColors } from './weapon-driver.js'
import { loadWorlds } from './worlds.js'
import { applyPackedPieces } from './cob-pose.js'

// Loaded models rest nose toward -Z (the direction a raw game heading of 0
// faces — see cob-pose.js), so the default display pose for a bare addUnit
// is a half turn: the unit faces +Z, toward the default camera.
const REST_HEADING = Math.PI

/**
 * @param {HTMLCanvasElement} canvas  Surface to render into.
 * @param {Object} opts
 * @param {import('./assets.js').AssetProvider} opts.assets  REQUIRED asset source.
 * @param {Object} [opts.game]  Per-game view configuration:
 *   { teamSides?, lodHidePatterns?, projectileFallbackColors? } — the
 *   game adapter's view3d table.  Omitted fields keep the defaults.
 * @param {string|Object} [opts.environment]  World/environment preset key
 *   (e.g. 'greenworld', 'mars') or a full preset object.
 * @param {boolean} [opts.controls=true]  Attach orbit/pan/zoom gestures.
 * @param {boolean} [opts.autoStart=false]  Run the renderer's own rAF
 *   loop.  Off by default — callers drive frames explicitly via
 *   step(dtMs), which is what a replayer or a headless test wants.
 * @param {Object} [opts.contextAttributes]  Extra WebGL context attributes.
 */
export async function createWorld(canvas, {
  assets,
  game = {},
  environment = null,
  controls = true,
  autoStart = false,
  contextAttributes = {},
} = {}) {
  if (!canvas) throw new Error('createWorld: a canvas is required')
  if (!assets) throw new Error('createWorld: { assets } (an AssetProvider) is required')
  setAssetProvider(assets)

  // Game view config — same injection points the studio's per-game
  // adapter drives.  Applied before any model load so LOD tagging and
  // team palettes affect the first unit.
  if (game.teamSides) setTeamSides(game.teamSides)
  if (game.lodHidePatterns) setLodHidePatterns(game.lodHidePatterns)
  if (game.projectileFallbackColors) setProjectileFallbackColors(game.projectileFallbackColors)

  await loadWorlds()
  const palette = await TAPalette.load()
  const gl = canvas.getContext('webgl', {
    antialias: true,
    premultipliedAlpha: false,
    alpha: false,
    ...contextAttributes,
  })
  if (!gl) throw new Error('createWorld: WebGL unavailable')
  const textureCache = new TextureCache(gl)
  const loader = new ModelLoader({ gl, palette, textureCache })
  const renderer = new ModelRenderer({ canvas, textureCache, gl })
  const camera = new OrbitCamera({})
  renderer.setCamera(camera)
  await renderer.init()
  if (environment) renderer.setEnvironment(environment)
  const detachControls = controls
    ? attachOrbitControls({ canvas, renderer, camera })
    : null

  // ── unit / projectile registry ────────────────────────────────────
  // One uploaded Model per model NAME (geometry lives once per GL
  // context); one cloneForInstance() per unit so each instance owns its
  // animated piece tree.
  const modelCache = new Map()   // name → Promise<Model>
  const units = new Map()        // id → unit record
  let projectiles = []           // transient snapshot-provided shots
  let tracers = []               // fireWeapon() visual tracers
  let weaponFx = []              // weaponEffect() beams / ballistic tracers
  let weaponDefsCache = null     // lazily-loaded pack weapons.json index
  let nextId = 1
  let disposed = false

  const loadBaseModel = (name) => {
    if (!modelCache.has(name)) modelCache.set(name, loader.load(name))
    return modelCache.get(name)
  }

  const syncEntities = () => {
    const entities = []
    for (const u of units.values()) {
      if (!u.model) continue
      entities.push({
        id: u.id,
        model: u.model,
        transform: { x: u.x, y: u.y, z: u.z, headingRad: u.headingRad, pitchRad: u.pitchRad || 0 },
        teamColor: u.teamColor,
        buildPercent: u.buildPercent,
        selected: !!u.selected,
      })
    }
    for (const pr of projectiles) {
      if (!pr.model) continue
      entities.push({
        id: 'proj-' + pr.id,
        model: pr.model,
        transform: { x: pr.x, y: pr.y, z: pr.z, headingRad: pr.headingRad || 0, pitchRad: pr.pitchRad || 0 },
        isProjectile: true,
      })
    }
    renderer.setEntities(entities)
    // fireWeapon tracers render as dynamic pulse lights — visible glow
    // without inventing projectile game rules in the renderer.
    renderer.setPulseLights(tracers.map((s) => ({
      pos: [s.x, s.y, s.z],
      color: s.color,
      strength: s.strength,
    })))
    renderer.setWeaponEffects(weaponFxSegments())
  }

  // weaponFxSegments turns the live weaponEffect() records into the line
  // segments the renderer's scene pass draws this frame: a beam is its full
  // muzzle→target span fading out over its duration; a tracer is a short
  // streak riding the shot's straight-line flight, fading near arrival.
  const weaponFxSegments = () => {
    if (!weaponFx.length) return null
    const out = []
    for (const fx of weaponFx) {
      const t = fx.ageMs / fx.durationMs
      if (fx.type === 'tracer') {
        const head = Math.min(1, t)
        const tail = Math.max(0, head - fx.streak)
        out.push({
          a: [
            fx.from[0] + (fx.to[0] - fx.from[0]) * tail,
            fx.from[1] + (fx.to[1] - fx.from[1]) * tail,
            fx.from[2] + (fx.to[2] - fx.from[2]) * tail,
          ],
          b: [
            fx.from[0] + (fx.to[0] - fx.from[0]) * head,
            fx.from[1] + (fx.to[1] - fx.from[1]) * head,
            fx.from[2] + (fx.to[2] - fx.from[2]) * head,
          ],
          color: fx.color,
          alpha: Math.max(0, 1 - t * t),
          width: fx.width,
        })
      } else {
        out.push({
          a: fx.from.slice(),
          b: fx.to.slice(),
          color: fx.color,
          alpha: Math.max(0, 1 - t),
          width: fx.width,
        })
      }
    }
    return out
  }

  const world = {
    // Escape hatches for hosts that drive the renderer directly (the
    // studio's sandbox view attaches its own gesture handling, entity
    // building and engine bridge through these).
    scene: renderer,
    renderer,
    camera,
    loader,
    palette,
    textureCache,
    gl,

    // step advances tracer visuals and renders exactly one frame.
    // Call from your own loop (or a test) — or pass autoStart to let
    // the renderer self-drive with requestAnimationFrame instead.
    step(dtMs = 16.7) {
      if (disposed) return
      if (tracers.length) {
        const dt = dtMs / 1000
        for (const s of tracers) {
          s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt
          s.lifeMs -= dtMs
        }
        tracers = tracers.filter((s) => s.lifeMs > 0)
      }
      if (weaponFx.length) {
        for (const fx of weaponFx) fx.ageMs += dtMs
        weaponFx = weaponFx.filter((fx) => fx.ageMs < fx.durationMs)
      }
      syncEntities()
      if (!renderer.running) renderer.draw()
    },

    // addUnit loads (or reuses) the named model, clones an instance and
    // places it.  Resolves to the unit id once its geometry is ready.
    // heading defaults to the rest pose (π — TA models author the nose
    // toward -Z, so π renders the unit facing +Z un-rotated).
    async addUnit(name, { id = null, x = 0, y = 0, z = 0, heading = null, side = null, teamColor = null, buildPercent = undefined, redraw = true } = {}) {
      const base = await loadBaseModel(name)
      const unitId = id != null ? id : nextId++
      if (unitId >= nextId && typeof unitId === 'number') nextId = unitId + 1
      units.set(unitId, {
        id: unitId,
        name,
        model: base.cloneForInstance(),
        x, y, z,
        headingRad: heading != null ? heading : REST_HEADING,
        pitchRad: 0,
        teamColor: teamColor || (side != null ? teamColorForSide(side) : null),
        buildPercent,
      })
      // redraw:false skips the immediate frame — bulk callers (e.g. a
      // replayer preloading every unit type) otherwise pay one full
      // scene draw per add/remove, which with a battlefield terrain
      // installed turns a warm-up loop into minutes of rendering.
      if (redraw && !renderer.running) world.step(0)
      return unitId
    },

    removeUnit(id, { redraw = true } = {}) {
      units.delete(id)
      if (redraw && !renderer.running) world.step(0)
    },

    moveUnit(id, { x, y, z, heading } = {}) {
      const u = units.get(id)
      if (!u) return
      if (x != null) u.x = x
      if (y != null) u.y = y
      if (z != null) u.z = z
      if (heading != null) u.headingRad = heading
      if (!renderer.running) world.step(0)
    },

    // applyState replaces the whole rendered world from a sim snapshot
    // (the engine's frame.Snapshot shape):
    //   { units: [{ id, model|name, x, y, z, heading, pitch?,
    //       buildPercent?, side?, teamColor?, dead?,
    //       pieceNames?: [...],           // the type's COB piece table
    //       piecesPacked?: Uint8Array,    // engine stride-7 piece buffer
    //       pieces?: [{ move:[x,y,z], rotate:[x,y,z], visible }] }],
    //     projectiles: [{ id, model?, x, y, z, heading?, pitch? }] }
    //
    // heading is radians in the game convention — feed a raw TA heading
    // through headingToRadians (cob-pose.js) or pass the engine snapshot's
    // headingRad straight through.
    //
    // Piece animation prefers the engine's native form: pieceNames (static
    // per unit type — resend or set once, it's remembered) + piecesPacked
    // per tick. Pieces are addressed BY NAME because COB piece-table order
    // is not the model's hierarchy order — index-blind application is how
    // a Samson's hidden build flares land on its body and make the truck
    // vanish. The conventions conversion lives in cob-pose.js. The legacy
    // pieces[] array (pre-converted renderer channels, Model.flat order,
    // or COB order when pieceNames is present) still applies for callers
    // that pose pieces themselves.
    applyState(snapshot = {}) {
      const seen = new Set()
      for (const su of snapshot.units || []) {
        if (su.dead) continue
        const name = su.model || su.name
        if (su.id == null || !name) continue
        seen.add(su.id)
        let u = units.get(su.id)
        if (!u || u.name !== name) {
          u = { id: su.id, name, model: null, x: 0, y: 0, z: 0, headingRad: REST_HEADING, pitchRad: 0 }
          units.set(su.id, u)
          loadBaseModel(name).then((base) => {
            if (!disposed && units.get(su.id) === u) u.model = base.cloneForInstance()
          }).catch(() => units.delete(su.id))
        }
        if (su.x != null) u.x = su.x
        if (su.y != null) u.y = su.y
        if (su.z != null) u.z = su.z
        if (su.heading != null) u.headingRad = su.heading
        if (su.pitch != null) u.pitchRad = su.pitch
        if (su.buildPercent != null) u.buildPercent = su.buildPercent
        if (su.teamColor) u.teamColor = su.teamColor
        else if (su.side != null) u.teamColor = teamColorForSide(su.side)
        if (Array.isArray(su.pieceNames)) u.pieceNames = su.pieceNames
        if (u.model) {
          if (u._pieceCacheModel !== u.model) {
            u._pieceCacheModel = u.model
            u._pieceCache = new Map()
          }
          if (su.piecesPacked && u.pieceNames) {
            applyPackedPieces(u.model, u.pieceNames, su.piecesPacked, u._pieceCache)
          } else if (Array.isArray(su.pieces)) {
            // Pre-converted renderer channels. With pieceNames the entries
            // are COB-table-ordered and land by name; without, they map
            // onto Model.flat by index (single-hierarchy callers).
            const n = su.pieces.length
            for (let i = 0; i < n; i++) {
              const ps = su.pieces[i]
              if (!ps) continue
              let piece
              if (u.pieceNames) {
                const nm = u.pieceNames[i]
                if (!nm) continue
                piece = u._pieceCache.get(nm)
                if (piece === undefined) {
                  piece = u.model.findPiece(nm)
                  u._pieceCache.set(nm, piece || null)
                }
              } else {
                piece = u.model.flat[i]
              }
              if (!piece) continue
              if (Array.isArray(ps.move)) {
                piece.move[0] = ps.move[0]; piece.move[1] = ps.move[1]; piece.move[2] = ps.move[2]
              }
              if (Array.isArray(ps.rotate)) {
                piece.rotate[0] = ps.rotate[0]; piece.rotate[1] = ps.rotate[1]; piece.rotate[2] = ps.rotate[2]
              }
              if (ps.visible != null) piece.visible = !!ps.visible
            }
          }
        }
      }
      for (const id of units.keys()) {
        if (!seen.has(id)) units.delete(id)
      }
      projectiles = []
      for (const sp of snapshot.projectiles || []) {
        const rec = {
          id: sp.id != null ? sp.id : nextId++,
          model: null,
          x: sp.x || 0, y: sp.y || 0, z: sp.z || 0,
          headingRad: sp.heading || 0,
          pitchRad: sp.pitch != null ? -sp.pitch : 0,
        }
        if (sp.model) {
          const cached = modelCache.get(sp.model)
          if (cached) {
            cached.then((m) => { rec.model = m }).catch(() => {})
          } else {
            loadBaseModel(sp.model).catch(() => {})
          }
        }
        projectiles.push(rec)
      }
      if (!renderer.running) world.step(0)
    },

    // fireWeapon spawns a purely visual tracer: a moving light that
    // travels from `from` toward `to` (or along `vel`) and expires.
    // Real projectile simulation belongs to the engine — feed its
    // snapshot through applyState for authoritative shots.
    fireWeapon({ from, to = null, vel = null, speed = 300, color = [1, 0.85, 0.4], strength = 2, lifeMs = null } = {}) {
      if (!Array.isArray(from)) return
      let v = vel
      let life = lifeMs
      if (!v && Array.isArray(to)) {
        const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
        const dist = Math.hypot(dx, dy, dz) || 1
        v = [dx / dist * speed, dy / dist * speed, dz / dist * speed]
        if (life == null) life = (dist / speed) * 1000
      }
      if (!v) return
      tracers.push({
        x: from[0], y: from[1], z: from[2],
        vx: v[0], vy: v[1], vz: v[2],
        color, strength,
        lifeMs: life != null ? life : 1500,
      })
    },

    // weaponEffect spawns a presentation-only weapon visual — no sim
    // impact, no hashes, just scene-pass geometry that ages out:
    //   type 'beam'   — a coloured line from muzzle to target fading over
    //                   durationMs (lasers, lightning).
    //   type 'tracer' — a short bright streak flying from → to over
    //                   durationMs (cannon rounds, ballistic shots).
    // Fields: { type, from: [x,y,z], to: [x,y,z], color?: [r,g,b] 0..1,
    //   durationMs?, velocity? (wu/sec, tracer flight speed when durationMs
    //   is unset), width? (px), weapon? }.
    //
    // Data-driven form: pass `weapon` (a weapons.json id from the pack —
    // AssetProvider.weaponDefs()) and the def's rendertype picks the visual
    // (beam for rendertype 0 lasers, tracer otherwise), its palette-resolved
    // color colours it, durationSec times a beam and velocityWU a tracer.
    // Explicit fields always win over the def.
    async weaponEffect({ type = null, from, to, color = null, durationMs = null, velocity = null, width = null, weapon = null } = {}) {
      if (!Array.isArray(from) || !Array.isArray(to)) return
      let def = null
      if (weapon) {
        if (!weaponDefsCache) {
          const provider = assets
          if (provider && typeof provider.weaponDefs === 'function') {
            weaponDefsCache = await provider.weaponDefs().catch(() => null) || {}
          } else {
            weaponDefsCache = {}
          }
        }
        def = weaponDefsCache[String(weapon).toLowerCase()] || null
      }
      const isBeam = type ? (type === 'beam' || type === 'laser') : (def ? def.renderType === 0 : true)
      let c = color
      if (!c && def && Array.isArray(def.color)) c = [def.color[0] / 255, def.color[1] / 255, def.color[2] / 255]
      if (!c) c = isBeam ? [0.4, 1, 0.35] : [1, 0.85, 0.4]
      let dur = durationMs
      if (dur == null && isBeam && def && def.durationSec > 0) dur = def.durationSec * 1000
      if (dur == null && !isBeam) {
        const dist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
        const v = velocity || (def && def.velocityWU) || 300
        dur = (dist / Math.max(1, v)) * 1000
      }
      if (dur == null) dur = 150
      weaponFx.push({
        type: isBeam ? 'beam' : 'tracer',
        from: from.slice(0, 3),
        to: to.slice(0, 3),
        color: c,
        durationMs: Math.max(1, dur),
        ageMs: 0,
        width: width || (isBeam ? 2 : 2),
        streak: 0.18,
      })
      if (!renderer.running) world.step(0)
    },

    // stats exposes the renderer's per-frame cull counters
    // ({ drew, culled, total, … }) — the draw-count assertion hook.
    stats() {
      return renderer.getCullStats()
    },

    units() {
      return Array.from(units.keys())
    },

    dispose() {
      if (disposed) return
      disposed = true
      if (detachControls) { try { detachControls() } catch { /* ignore */ } }
      renderer.stop()
      units.clear()
      projectiles = []
      tracers = []
      weaponFx = []
      renderer.dispose()
    },
  }

  if (autoStart) renderer.start()
  else world.step(0)
  return world
}
