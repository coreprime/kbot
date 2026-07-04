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
//
// Presentation extras a replay driver leans on (all documented at their
// methods below):
//   weaponEffect()  — data-driven weapon visuals from pack weapon defs
//   unitDeath()     — wreck swap or flying-polygon debris on unit death
//   unitImpulse()   — damped hit-rock on weapon impact
//   setTerrain()    + terrainHeightAt/terrainNormalAt — battlefield surface
//   applyState unit fields: grounded, hp01, rank, roll
//   setQuality()    — 'standard' | 'cinematic' renderer preset

import { TAPalette } from './palette.js'
import { TextureCache } from './texture-cache.js'
import { ModelLoader, setLodHidePatterns } from './model-loader.js'
import { ModelRenderer } from './model-renderer.js'
import { OrbitCamera } from './orbit-camera.js'
import { attachOrbitControls } from './camera-controls.js'
import { setAssetProvider, toTexImageSource } from './assets.js'
import { setTeamSides, teamColorForSide, TA_TEAM_SIDES } from './team-colors.js'
import {
  setProjectileFallbackColors,
  SmokeTrailManager,
  spawnProjectileInFlight,
  SFX_PROJECTILE_LASER,
} from './weapon-driver.js'
import {
  ParticlePool,
  SFX_SMOKE_GREY,
  SFX_SMOKE_WHITE,
  SFX_SUB_BUBBLES,
  SFX_FIRE_FLASH,
  SFX_SPARK,
  SFX_NANO_PARTICLES,
} from './cob-particles.js'
import { gatherSceneLights } from './scene-lights.js'
import { loadWorlds } from './worlds.js'
import { applyPackedPieces } from './cob-pose.js'
import {
  normalizePackWeaponDef,
  spawnWeaponVisual,
  stepModelShots,
  modelShotPose,
  impactBurst,
  resolveDeathPlan,
  unitRocksOnImpact,
  damageSmokeIntervalMs,
  debrisBurst,
  stepDebrisRecord,
  latheConeSpray,
} from './world-fx.js'
import { buildFeatureField, mulberry32, featureSeed } from './map-features.js'
import { raycastTerrain } from './terrain-los.js'
import { fragmentGeometry, targetFragmentCount } from './debris-fragments.js'
import { Piece } from './piece.js'
import { Model } from './model.js'
import { planetEnvironment } from './map-terrain.js'
import { ExplosionManager } from './explosion-fx.js'
import { PULSE_LIGHT_ENERGY_BUDGET } from './performance.js'

// Loaded models rest nose toward -Z (the direction a raw game heading of 0
// faces — see cob-pose.js), so the default display pose for a bare addUnit
// is a half turn: the unit faces +Z, toward the default camera.
const REST_HEADING = Math.PI

// Hit-rock spring constants: stiffness/damping tuned so a hit reads as a
// quick shudder (~2 oscillations over ~0.7 s) rather than a wobble.
const IMPULSE_SPRING_K = 55
const IMPULSE_SPRING_C = 7
// IMPULSE_KICK_SCALE sets the hit-rock AMPLITUDE (the spring K/C above fix the
// shape; this scales the kick velocity, which the lean is linear in).  0.33 =
// 0.6 × the earlier 0.55 — the visible rock was 40 % too strong.
export const IMPULSE_KICK_SCALE = 0.33

// Slope-tilt smoothing time constant (seconds) — fast enough to track a
// moving tank crossing a ridge, slow enough to hide heightfield stairsteps.
const TILT_SMOOTH_SEC = 0.15

// How long flying-polygon debris persists.  Pieces now bounce off the
// terrain and settle (world-fx stepDebrisRecord), so the window covers the
// flight + a beat on the ground; the last DEBRIS_FADE_MS alpha-fade the
// pieces out where they lie.
const DEBRIS_LIFE_MS = 2600
const DEBRIS_FADE_MS = 420
// Global concurrent debris-fragment budget: when a mass death pushes past
// it, the OLDEST records get their remaining life clamped to the fade window
// — they fade first, keeping the per-frame fragment integration bounded.
// Deaths now shatter into many small SHARDS (debris-fragments.js — up to
// FRAG_MAX per death) rather than one record per COB piece, so this is
// raised accordingly; each shard is a tiny slice draw + one parabola step,
// so a few dozen concurrent deaths still integrate cheaply.
const DEBRIS_MAX_PIECES = 1200

// Air-unit presentation: hover-bob amplitude/frequency and the speed at which
// contrails start.  Aircraft deaths now explode in place + arc debris (the
// same treatment as ground units), so there is no spiral-crash tuning.
const AIR_BOB_WU = 1.6
const AIR_BOB_HZ = 0.45
const CONTRAIL_MIN_SPEED = 55
const CONTRAIL_INTERVAL_MS = 60

// Surface-vessel wake cadence + the band around the waterline that counts
// as "on the surface".
const WAKE_INTERVAL_MS = 100
const WAKE_MIN_SPEED = 10
const SURFACE_BAND_WU = 4

// Nanolathe / reclaim beam cadence + particle speed.
const LATHE_EMIT_INTERVAL_MS = 26
const LATHE_PARTICLE_SPEED = 220

// Steam-vent wisp cadence + drift.  A lazy geothermal plume: one soft
// white puff every third of a second rising off the vent throat, phase-
// staggered per vent.  Velocities come from each vent's own seeded rng
// so the plume is deterministic under a driven fx clock.
const STEAM_INTERVAL_MS = 340
const STEAM_RISE_WU_S = 16
const STEAM_LIFE_MS = 1700

// Reclaimed wrecks shrink toward this scale while a reclaim beam holds
// them (full shrink over RECLAIM_SHRINK_MS of beam time).
const RECLAIM_MIN_SCALE = 0.12
const RECLAIM_SHRINK_MS = 3800

// Capture flash duration (bright team-coloured shell pulse).
const CAPTURE_FLASH_MS = 700

// Wrecks embed slightly into the ground like TA's corpse features do.
const CORPSE_SINK_WU = 1.5

// Renderer quality presets — see setQuality().  'standard' matches the
// renderer's defaults (specular, metal hints, running lights, god beams and
// shadows are already on); 'cinematic' additionally routes the frame
// through the post chain: bloom (weapon glow / running lights bleed),
// the ACES tonemap + grade, and FXAA.
const QUALITY_PRESETS = {
  standard: { bloom: false, cinematic: false, antialias: false, drawDistance: 1 },
  cinematic: { bloom: true, bloomStrength: 1.0, cinematic: true, cinematicStrength: 0.85, antialias: true, drawDistance: 4 },
}

/**
 * @param {HTMLCanvasElement} canvas  Surface to render into.
 * @param {Object} opts
 * @param {import('./assets.js').AssetProvider} opts.assets  REQUIRED asset source.
 * @param {Object} [opts.game]  Per-game view configuration:
 *   { teamSides?, lodHidePatterns?, projectileFallbackColors? } — the
 *   game adapter's view3d table.  Omitted teamSides default to the TA
 *   player palette (TA_TEAM_SIDES) so pack-driven replays get team
 *   recolouring without the studio adapter.
 * @param {string|Object} [opts.environment]  World/environment preset key
 *   (e.g. 'greenworld', 'mars') or a full preset object.
 * @param {string} [opts.quality='standard']  Renderer quality preset —
 *   'standard' or 'cinematic' (see setQuality).
 * @param {boolean} [opts.controls=true]  Attach orbit/pan/zoom gestures.
 * @param {boolean} [opts.autoStart=false]  Run the renderer's own rAF
 *   loop.  Off by default — callers drive frames explicitly via
 *   step(dtMs), which is what a replayer or a headless test wants.
 *   Explicitly-stepped worlds also drive the renderer's effect clock
 *   (running-light blink, sea bob) from step's dtMs, so all animated
 *   effects are a deterministic function of the fed timeline.
 * @param {Object} [opts.contextAttributes]  Extra WebGL context attributes.
 */
export async function createWorld(canvas, {
  assets,
  game = {},
  environment = null,
  quality = 'standard',
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
  setTeamSides(game.teamSides || TA_TEAM_SIDES)
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
  // Track whether the caller pinned an environment. If they didn't, an
  // installed battlefield auto-selects a map-appropriate sky from its OTA
  // planet (see setTerrain) so the beyond-map background shows a sky/cloud
  // layer instead of reading blank.
  const envPinned = !!environment
  if (environment) renderer.setEnvironment(environment)
  const detachControls = controls
    ? attachOrbitControls({ canvas, renderer, camera })
    : null

  // Explicitly-stepped worlds own the effect clock: step(dtMs) advances it
  // so blink/wobble phase follows the driven timeline exactly.
  if (!autoStart && typeof renderer.setFxClockExternal === 'function') {
    renderer.setFxClockExternal(true)
  }

  // ── unit / projectile registry ────────────────────────────────────
  // One uploaded Model per model NAME (geometry lives once per GL
  // context); one cloneForInstance() per unit so each instance owns its
  // animated piece tree.
  const modelCache = new Map()   // name → Promise<Model>
  const modelReady = new Map()   // name → resolved base Model (sync re-attach)
  const units = new Map()        // id → unit record
  const corpses = new Map()      // id → persistent wreck record
  const featureModels = []       // 3DO map features (static, from setTerrain)
  const steamVents = []          // live steam-wisp emitters (vent features)
  const beams = new Map()        // latheBeam/reclaimBeam key → beam record
  let debris = []                // flying-chunk death records
  let modelShots = []            // weaponEffect() projectile meshes in flight
  let projectiles = []           // transient snapshot-provided shots
  let tracers = []               // fireWeapon() visual tracers
  let weaponFx = []              // legacy explicit beam/tracer line effects
  let weaponDefsCache = null     // id → normalised pack weapon def
  let featureDefsCache = null    // id → pack feature def (features.json)
  let featureBuildToken = 0      // cancels stale async feature builds
  let fxTimeMs = 0               // world fx clock (sum of step dtMs)
  let nextId = 1
  let disposed = false
  let scriptPieceQuery = null    // (unitId, fnName) → COB piece index | -1

  // World-level effects binding: ONE shared particle pool for every
  // weapon / impact / damage-smoke emission (the studio uses per-unit
  // pools; a state-driven world has no per-unit script bindings, so a
  // single pool with the renderer attached serves the same visuals).
  const worldBinding = {
    particles: new ParticlePool(4096),
    audio: null,
    _renderer: renderer,
    // Polygonal explosion manager — every impactBurst detonation routes
    // its fireball/shockwave through here (capped + coalesced; see
    // explosion-fx.js).  Stepped by _stepPresentation on the fx clock.
    explosions: new ExplosionManager(),
  }
  const smokeTrails = new SmokeTrailManager()
  renderer.setParticlePool(worldBinding.particles)
  // Impacts: when a travelling projectile particle expires, detonate the
  // last-fired weapon's burst at its final position — the studio's
  // particle-expire impact path.
  worldBinding.particles.onExpire = (slot, pool) => {
    const kind = pool.kind[slot]
    if (kind < 200 || kind > 206 || kind === SFX_PROJECTILE_LASER) return
    if (!pool.noFade[slot]) return
    const w = worldBinding._lastFiredWeapon
    impactBurst(worldBinding, [pool.x[slot], pool.y[slot], pool.z[slot]], {
      aoe: (w && w.areaOfEffectWU) || 16,
    })
  }

  const loadBaseModel = (name) => {
    if (!modelCache.has(name)) {
      const p = loader.load(name)
      modelCache.set(name, p)
      // Remember the resolved base so a later re-add of the same type can
      // attach its model clone SYNCHRONOUSLY.  The promise path defers the
      // attach past the caller's own step(), which renders the unit
      // invisible for at least one frame — visible as whole-unit pop-in
      // whenever a driver's snapshot drops and re-lists a unit.
      p.then((base) => { if (!disposed) modelReady.set(name, base) }).catch(() => {})
    }
    return modelCache.get(name)
  }

  const weaponDefs = async () => {
    if (weaponDefsCache) return weaponDefsCache
    let raw = {}
    if (assets && typeof assets.weaponDefs === 'function') {
      raw = await assets.weaponDefs().catch(() => null) || {}
    }
    const out = {}
    for (const [id, def] of Object.entries(raw)) {
      out[id.toLowerCase()] = normalizePackWeaponDef(id, def)
    }
    weaponDefsCache = out
    return out
  }

  const featureDefs = async () => {
    if (featureDefsCache) return featureDefsCache
    let raw = null
    if (assets && typeof assets.featureDefs === 'function') {
      raw = await assets.featureDefs().catch(() => null)
    }
    featureDefsCache = raw || {}
    return featureDefsCache
  }

  // waterY — the installed battlefield's sea surface Y, or null on dry
  // maps / the flat pad.  Splashes, torpado depth and wakes key on it.
  const waterY = () => {
    const mt = renderer._mapTerrain
    return mt && mt.waterVbo ? mt.seaY : null
  }

  const terrainHeightAt = (x, z) =>
    (typeof renderer.terrainHeightAt === 'function' ? renderer.terrainHeightAt(x, z) : 0)
  const terrainNormalAt = (x, z) =>
    (typeof renderer.terrainNormalAt === 'function' ? renderer.terrainNormalAt(x, z) : [0, 1, 0])

  // _unitPose composes a unit's final render transform: grounded units clamp
  // Y to the terrain surface, slope tilt + the hit-rock impulse ride the
  // pitch/roll channels on top of any driver-provided base pitch/roll.
  const _unitPose = (u) => {
    let y = u.y
    if (u.grounded) y = terrainHeightAt(u.x, u.z)
    // Airborne hover bob: a gentle deterministic heave off the fx clock,
    // phase-offset per unit id so a squadron doesn't pump in unison.
    if (u.air && !u.grounded) {
      const phase = (typeof u.id === 'number' ? u.id : 0) * 2.39996
      y += Math.sin((fxTimeMs / 1000) * AIR_BOB_HZ * Math.PI * 2 + phase) * AIR_BOB_WU
    }
    const pitch = (u.pitchRad || 0) + (u._tiltP || 0) + (u._imp ? u._imp.p : 0)
    const roll = (u.rollRad || 0) + (u._tiltR || 0) + (u._imp ? u._imp.r : 0)
    return { x: u.x, y, z: u.z, headingRad: u.headingRad, pitchRad: pitch, rollRad: roll }
  }

  // _unitVelocity estimates a unit's WORLD travel velocity ([vx,vy,vz], WU/s)
  // from the motion latch (_px/_py/_pz sampled at _pt in fx-clock ms), which
  // _stepPresentation refreshes every step.  A unit that has moved since the
  // previous frame carries momentum into its death debris (item: debris throws
  // along the unit's travel direction).  Returns null when there's no prior
  // sample (a unit that died the frame it appeared has no measurable motion).
  const _unitVelocity = (u) => {
    if (!u || u._pt == null) return null
    const dt = (fxTimeMs - u._pt) / 1000
    if (!(dt > 1e-3)) return null
    const vx = (u.x - u._px) / dt
    const vy = (u.y - (u._py != null ? u._py : u.y)) / dt
    const vz = (u.z - u._pz) / dt
    if (!(Math.abs(vx) + Math.abs(vy) + Math.abs(vz) > 1e-3)) return null
    // Clamp absurd single-frame jumps (a teleport / re-add) so a snapshot
    // discontinuity can't fling debris across the map.
    const MAX = 400
    const sp = Math.hypot(vx, vy, vz)
    if (sp > MAX) { const k = MAX / sp; return [vx * k, vy * k, vz * k] }
    return [vx, vy, vz]
  }

  const syncEntities = () => {
    const entities = []
    const overlays = []
    for (const u of units.values()) {
      if (!u.model) continue
      const ent = {
        id: u.id,
        model: u.model,
        transform: _unitPose(u),
        teamColor: u.teamColor,
        buildPercent: u.buildPercent,
        selected: !!u.selected,
      }
      // Air units bank into their turns and hovercraft gyrate via the
      // renderer's locomotion overlay (the same path the studio sandbox
      // uses); the flags arrive on applyState as air / hover.
      if (u.air || u.hover) {
        ent.meta = { isAircraft: !!u.air, isHovercraft: !!u.hover, bankScale: 1, pitchScale: 1 }
      }
      // Capture flash: a bright wireframe shell pulse for the flash window.
      if (u._captureMs > 0) ent.highlight = true
      entities.push(ent)
      // Status overlay only while the unit is damaged: the health bar is
      // the gate, and the veteran-rank stars ride beneath it — a
      // full-health unit shows neither.
      if (u.hp01 != null && u.hp01 < 1) {
        const t = entities[entities.length - 1].transform
        overlays.push({
          x: t.x, y: t.y, z: t.z,
          rWU: u.model.boundsRadius || 12,
          hp01: u.hp01,
          rank: u.rank | 0,
        })
      }
    }
    for (const c of corpses.values()) {
      if (!c.model) continue
      entities.push({
        id: 'corpse-' + c.id,
        model: c.model,
        transform: { x: c.x, y: c.y, z: c.z, headingRad: c.headingRad, pitchRad: c.pitchRad || 0, rollRad: c.rollRad || 0, scale: c.scale != null ? c.scale : 1 },
        teamColor: null,
      })
    }
    for (const fm of featureModels) {
      if (!fm.model) continue
      entities.push({
        id: 'feat-' + fm.idx,
        model: fm.model,
        transform: { x: fm.x, y: fm.y, z: fm.z, headingRad: fm.heading },
        teamColor: null,
      })
    }
    for (const d of debris) {
      if (!d.model) continue
      // Fade the pieces out where they lie over the last DEBRIS_FADE_MS.
      const remain = d.lifeMs - d.ageMs
      const opacity = remain < DEBRIS_FADE_MS ? Math.max(0, remain / DEBRIS_FADE_MS) : 1
      entities.push({
        id: 'debris-' + d.id,
        model: d.model,
        transform: { x: d.x, y: d.y, z: d.z, headingRad: d.headingRad },
        teamColor: d.teamColor || null,
        opacity,
        buildFadeOnly: true,
      })
    }
    for (const s of modelShots) {
      if (!s.model) continue
      const pose = modelShotPose(s)
      entities.push({
        id: 'wshot-' + (s.id != null ? s.id : 0),
        model: s.model,
        transform: { x: s.x, y: s.y, z: s.z, headingRad: pose.heading, pitchRad: pose.pitch },
        isProjectile: true,
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
    renderer.setUnitOverlays(overlays)
    // Dynamic lights: the shared pool's light-emitting particles (muzzle
    // flashes, D-gun ball, impact fireballs) wash nearby surfaces — the
    // studio's per-frame gatherSceneLights path — plus the legacy
    // fireWeapon tracer glows.
    const lights = gatherSceneLights([worldBinding.particles])
    // Explosion lights — the manager's strongest few, already budgeted.
    for (const l of worldBinding.explosions.lights()) lights.push(l)
    for (const s of tracers) {
      lights.push({ pos: [s.x, s.y, s.z], color: s.color, strength: s.strength })
    }
    // Light-energy budget: the shader's per-light wash is additive, so a
    // barrage's worth of full-strength beam lights floodlights the ground
    // white.  Total reach saturates at PULSE_LIGHT_ENERGY_BUDGET — every
    // light dims proportionally past it (readability discipline; see
    // explosion-fx.js).
    let lightEnergy = 0
    for (const l of lights) lightEnergy += l.strength
    if (lightEnergy > PULSE_LIGHT_ENERGY_BUDGET) {
      const k = PULSE_LIGHT_ENERGY_BUDGET / lightEnergy
      for (const l of lights) l.strength *= k
    }
    renderer.setPulseLights(lights)
    renderer.setWeaponEffects(weaponFxSegments())
    renderer.setExplosionTris(worldBinding.explosions.tris(), worldBinding.explosions.vertCount())
  }

  // weaponFxSegments turns the live legacy weaponEffect() records into the
  // line segments the renderer's scene pass draws this frame: a beam is its
  // full muzzle→target span fading out over its duration; a tracer is a
  // short streak riding the shot's straight-line flight, fading near arrival.
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

  // _stepPresentation advances every world-owned effect by dtMs of sim
  // time: particles, smoke trails, projectile meshes, debris, hit-rock
  // springs, slope-tilt smoothing and health-driven damage smoke.
  const _stepPresentation = (dtMs) => {
    if (!(dtMs > 0)) return
    const dt = dtMs / 1000
    fxTimeMs += dtMs
    worldBinding.particles.tick(dtMs)
    smokeTrails.tick(dtMs)
    worldBinding.explosions.step(dtMs)
    stepModelShots(modelShots, dtMs, { env: { waterY: waterY(), heightAt: terrainHeightAt } })
    _stepBeams(dtMs)
    // Steam vents: lazy geothermal wisps off each vent throat.  Gated on
    // the feature toggle so hiding map features silences the plumes too.
    if (steamVents.length && !world._featuresOff) {
      for (const v of steamVents) {
        v.accMs += dtMs
        while (v.accMs >= STEAM_INTERVAL_MS) {
          v.accMs -= STEAM_INTERVAL_MS
          const jx = (v.rng() * 2 - 1) * v.r * 0.2
          const jz = (v.rng() * 2 - 1) * v.r * 0.2
          worldBinding.particles.emit(SFX_SMOKE_WHITE, [v.x + jx, v.y, v.z + jz], {
            size: 3.5 + v.r * 0.12,
            lifeMs: STEAM_LIFE_MS + v.rng() * 400,
            color: [0.92, 0.95, 0.98, 0.30],
            velocity: [
              (v.rng() * 2 - 1) * 2.5,
              STEAM_RISE_WU_S * (0.8 + v.rng() * 0.4),
              (v.rng() * 2 - 1) * 2.5,
            ],
          })
        }
      }
    }
    // Debris: parabolic world-space flight with terrain bounces; a global
    // piece budget clamps the OLDEST records into their fade window when a
    // mass death would blow the frame budget.
    if (debris.length) {
      let totalPieces = 0
      for (const d of debris) totalPieces += d.pieces.length
      if (totalPieces > DEBRIS_MAX_PIECES) {
        // debris[] is push-ordered — oldest first.
        let excess = totalPieces - DEBRIS_MAX_PIECES
        for (const d of debris) {
          if (excess <= 0) break
          const remain = d.lifeMs - d.ageMs
          if (remain > DEBRIS_FADE_MS) {
            d.lifeMs = d.ageMs + DEBRIS_FADE_MS
            excess -= d.pieces.length
          }
        }
      }
      let w = 0
      for (const d of debris) {
        d.ageMs += dtMs
        if (d.ageMs >= d.lifeMs) {
          // Record gone — free its shard VBO (each death owns one).
          if (d.shardVbo) { gl.deleteBuffer(d.shardVbo); d.shardVbo = null }
          continue
        }
        stepDebrisRecord(d, dtMs, { heightAt: terrainHeightAt })
        debris[w++] = d
      }
      debris.length = w
    }
    const tiltK = 1 - Math.exp(-dt / TILT_SMOOTH_SEC)
    for (const u of units.values()) {
      // Hit-rock spring.
      const imp = u._imp
      if (imp && (imp.p || imp.r || imp.vp || imp.vr)) {
        imp.vp += (-IMPULSE_SPRING_K * imp.p - IMPULSE_SPRING_C * imp.vp) * dt
        imp.vr += (-IMPULSE_SPRING_K * imp.r - IMPULSE_SPRING_C * imp.vr) * dt
        imp.p += imp.vp * dt
        imp.r += imp.vr * dt
        if (Math.abs(imp.p) < 1e-4 && Math.abs(imp.r) < 1e-4 &&
            Math.abs(imp.vp) < 1e-4 && Math.abs(imp.vr) < 1e-4) {
          imp.p = 0; imp.r = 0; imp.vp = 0; imp.vr = 0
        }
      }
      // Slope tilt toward the terrain normal under a grounded unit.
      if (u.grounded && u.tilt !== false) {
        const n = terrainNormalAt(u.x, u.z)
        const c = Math.cos(u.headingRad), s = Math.sin(u.headingRad)
        const nlx = c * n[0] - s * n[2]
        const nlz = s * n[0] + c * n[2]
        const targetP = Math.atan2(nlz, n[1])
        const targetR = Math.atan2(-nlx, n[1])
        u._tiltP = (u._tiltP || 0) + (targetP - (u._tiltP || 0)) * tiltK
        u._tiltR = (u._tiltR || 0) + (targetR - (u._tiltR || 0)) * tiltK
      } else if (u._tiltP || u._tiltR) {
        u._tiltP = (u._tiltP || 0) * (1 - tiltK)
        u._tiltR = (u._tiltR || 0) * (1 - tiltK)
      }
      // Motion-derived presentation: speed from position deltas feeds the
      // aircraft contrail + surface-vessel wake emitters.
      let speed = 0
      if (u._pt != null) {
        const pdt = (fxTimeMs - u._pt) / 1000
        if (pdt > 1e-4) speed = Math.hypot(u.x - u._px, u.z - u._pz) / pdt
      }
      const wy = waterY()
      // Water-entry splash: the unit's render Y crossed the sea surface
      // downward since last step (a crashing aircraft, an amphib wading in).
      if (wy != null && u._py != null && u._py > wy && u.y <= wy) {
        impactBurst(worldBinding, [u.x, wy, u.z], { aoe: 40, water: true })
      }
      u._px = u.x; u._py = u.y; u._pz = u.z; u._pt = fxTimeMs
      // Aircraft contrail: white wisps behind a fast mover.
      if (u.air && speed >= CONTRAIL_MIN_SPEED) {
        u._trailAccMs = (u._trailAccMs || 0) + dtMs
        if (u._trailAccMs >= CONTRAIL_INTERVAL_MS) {
          u._trailAccMs -= CONTRAIL_INTERVAL_MS
          const pose = _unitPose(u)
          const back = (u.model && u.model.boundsRadius) || 8
          const bx = u.x + Math.sin(u.headingRad) * back
          const bz = u.z + Math.cos(u.headingRad) * back
          worldBinding.particles.emit(SFX_SMOKE_WHITE, [bx, pose.y, bz], {
            size: 3.5, lifeMs: 700, riseSpeed: 0.3, drift: 0.4,
            color: [0.95, 0.96, 1.0, 0.30],
          })
        }
      } else {
        u._trailAccMs = 0
      }
      // Surface-vessel wake: foam behind a ship under way on the sheet.
      if (u.naval && wy != null && Math.abs(u.y - wy) <= SURFACE_BAND_WU && speed >= WAKE_MIN_SPEED) {
        u._wakeAccMs = (u._wakeAccMs || 0) + dtMs
        if (u._wakeAccMs >= WAKE_INTERVAL_MS) {
          u._wakeAccMs -= WAKE_INTERVAL_MS
          const r = (u.model && u.model.boundsRadius) || 10
          const sternX = u.x + Math.sin(u.headingRad) * r * 0.8
          const sternZ = u.z + Math.cos(u.headingRad) * r * 0.8
          // Two foam puffs peeling off the stern quarters.
          const px = Math.cos(u.headingRad), pz = -Math.sin(u.headingRad)
          for (const side of [-1, 1]) {
            worldBinding.particles.emit(SFX_SMOKE_WHITE, [sternX + px * side * r * 0.35, wy + 0.4, sternZ + pz * side * r * 0.35], {
              size: 5 + Math.min(6, speed * 0.05), lifeMs: 1200,
              riseSpeed: 0.1, drift: 0.7,
              color: [0.95, 0.98, 1.0, 0.40],
            })
          }
        }
      } else {
        u._wakeAccMs = 0
      }
      // Capture flash timer.
      if (u._captureMs > 0) u._captureMs -= dtMs
      // Health-driven damage smoke (TA units smoke below ~2/3 health,
      // harder as they near death).
      const interval = damageSmokeIntervalMs(u.hp01)
      if (interval != null && u.model) {
        u._smokeAccMs = (u._smokeAccMs || 0) + dtMs
        if (u._smokeAccMs >= interval) {
          u._smokeAccMs = 0
          const cy = u.model.boundsCentre ? u.model.boundsCentre[1] : 6
          const jx = (Math.random() * 2 - 1) * 3
          const jz = (Math.random() * 2 - 1) * 3
          const pose = _unitPose(u)
          worldBinding.particles.emit(SFX_SMOKE_GREY, [u.x + jx, pose.y + cy, u.z + jz], {})
        }
      } else {
        u._smokeAccMs = 0
      }
    }
  }

  // _pieceWorldPos computes a live unit piece's WORLD position through the
  // rendered transform chain (position + heading/pitch/roll + the piece
  // tree's current COB pose).  `pieceRef` is a piece NAME, or a COB piece-
  // table INDEX resolved through the unit's pieceNames (applyState).  Null
  // when the unit, its model, or the piece can't be resolved.
  const _pieceWorldPos = (id, pieceRef) => {
    const u = units.get(id)
    if (!u || !u.model) return null
    let piece = null
    if (typeof pieceRef === 'number') {
      // Numeric refs are COB piece-table indexes — they only map onto the
      // model through the unit's piece-name table (COB order is NOT the
      // model hierarchy order, so a flat-order fallback would silently
      // pick the wrong piece).
      const nm = Array.isArray(u.pieceNames) ? u.pieceNames[pieceRef] : null
      if (nm) piece = u.model.findPiece(nm)
    } else if (pieceRef != null) {
      piece = u.model.findPiece(String(pieceRef))
    }
    if (!piece) return null
    const pose = _unitPose(u)
    return u.model.resolvePieceWorld(
      piece, pose.x, pose.y, pose.z, pose.headingRad, pose.pitchRad, pose.rollRad)
  }

  // _midHull is the generic beam/effect anchor: the unit origin plus a
  // small vertical offset to mid-hull — the graceful fallback whenever a
  // COB query / piece lookup can't resolve a real emitter piece.
  const _midHull = (u) => {
    const pose = _unitPose(u)
    const cy = u.model && u.model.boundsCentre ? u.model.boundsCentre[1] : 6
    return [pose.x, pose.y + cy, pose.z]
  }

  // _queryPiece asks the installed script-piece resolver (an engine
  // session's queryScriptPiece, wired via setScriptPieceQuery) for a COB
  // Query* function's piece index.  -1 when no resolver is installed or
  // the query fails — callers fall back to the unit origin.
  const _queryPiece = (unitId, fnName) => {
    if (typeof scriptPieceQuery !== 'function') return -1
    try {
      const idx = scriptPieceQuery(unitId, fnName)
      return Number.isFinite(idx) ? idx : -1
    } catch {
      return -1
    }
  }

  // Weapon slots resolve muzzles through TA's per-slot COB queries.
  const QUERY_SLOT_FN = ['QueryPrimary', 'QuerySecondary', 'QueryTertiary']

  // _nanoPiece resolves a builder's nanolathe emitter piece index via its
  // COB QueryNanoPiece, or null for the mid-hull fallback.  Resolved once
  // per beam start (each start re-queries, so multi-nozzle builders cycle
  // emitters between build orders the way the game's spray does).
  const _nanoPiece = (unitId) => {
    const idx = _queryPiece(unitId, 'QueryNanoPiece')
    return idx >= 0 ? idx : null
  }

  // _resolveMuzzle returns the world position a slot's shot exits from: the
  // COB Query<slot> piece when the resolver + piece table can supply it,
  // else the unit's mid-hull (origin + small vertical offset).  Null only
  // when the unit itself is gone.
  const _resolveMuzzle = (unitId, slot) => {
    const u = units.get(unitId)
    if (!u) return null
    const fn = QUERY_SLOT_FN[slot | 0] || QUERY_SLOT_FN[0]
    const idx = _queryPiece(unitId, fn)
    if (idx >= 0) {
      const pos = _pieceWorldPos(unitId, idx)
      if (pos) return pos
    }
    return _midHull(u)
  }

  // _resolveBeamEnd turns a beam endpoint spec into a live world position:
  // { unitId } tracks the unit (mid-hull; with `piece` set, that piece's
  // live world position), { corpseId } tracks a wreck, { pos: [x,y,z] } is
  // fixed.  Null when the referent is gone.
  const _resolveBeamEnd = (end) => {
    if (!end) return null
    if (end.unitId != null) {
      const u = units.get(end.unitId)
      if (!u) return null
      if (end.piece != null) {
        const p = _pieceWorldPos(end.unitId, end.piece)
        if (p) return p
      }
      return _midHull(u)
    }
    if (end.corpseId != null) {
      const c = corpses.get(end.corpseId)
      if (!c) return null
      return [c.x, c.y + 4, c.z]
    }
    if (Array.isArray(end.pos)) return end.pos
    return null
  }

  // _stepBeams advances every live lathe/reclaim beam: a deterministic
  // accumulator drips nano particles along the span (toward the target for
  // build, back toward the builder for reclaim), sparkles land on the work
  // end, and a reclaimed wreck shrinks while the beam holds it.
  const _stepBeams = (dtMs) => {
    if (!beams.size) return
    for (const [key, b] of beams) {
      const from = _resolveBeamEnd(b.from)
      const to = _resolveBeamEnd(b.to)
      if (!from || !to) { beams.delete(key); continue }
      b.accMs += dtMs
      const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]
      const dist = Math.hypot(dx, dy, dz) || 1
      const lifeMs = (dist / LATHE_PARTICLE_SPEED) * 1000
      while (b.accMs >= LATHE_EMIT_INTERVAL_MS) {
        b.accMs -= LATHE_EMIT_INTERVAL_MS
        b.count = (b.count || 0) + 1
        const reclaim = b.kind === 'reclaim'
        if (!reclaim) {
          // BUILD: a dense translucent CONE of fine bright-green motes from
          // the nano nozzle (from) converging on the build target (to).
          // Deterministic — seeded off the beam's own rng (fx-clock cadence).
          latheConeSpray(worldBinding.particles, {
            from, to, rng: b.rng, color: b.color,
          })
        } else {
          // RECLAIM: reverse stream — nano motes flow FROM the work end back
          // into the builder along the span, with slight axial scatter.
          const jx = (b.rng() * 2 - 1) * 1.6
          const jy = (b.rng() * 2 - 1) * 1.6
          const jz = (b.rng() * 2 - 1) * 1.6
          worldBinding.particles.emit(SFX_NANO_PARTICLES, [to[0] + jx, to[1] + jy, to[2] + jz], {
            velocity: [
              -(dx / dist) * LATHE_PARTICLE_SPEED,
              -(dy / dist) * LATHE_PARTICLE_SPEED,
              -(dz / dist) * LATHE_PARTICLE_SPEED,
            ],
            lifeMs,
            color: b.color,
            size: 2.2,
            noFade: true,
          })
          // Work-end sparkle every few drips.
          if ((b.count % 4) === 0) {
            worldBinding.particles.emit(SFX_SPARK, [to[0] + jx, to[1] + jy, to[2] + jz], {
              color: [b.color[0], b.color[1], b.color[2], 1],
              lifeMs: 180,
            })
          }
        }
      }
      if (b.kind === 'reclaim' && b.to && b.to.corpseId != null) {
        const c = corpses.get(b.to.corpseId)
        if (c) {
          const rate = (1 - RECLAIM_MIN_SCALE) * (dtMs / RECLAIM_SHRINK_MS)
          c.scale = Math.max(RECLAIM_MIN_SCALE, (c.scale != null ? c.scale : 1) - rate)
        }
      }
    }
  }

  // _buildShardModel shatters `sourceModel` into MANY small recentred shard
  // meshes (debris-fragments.js) and wraps them in a lightweight synthetic
  // Model the renderer draws exactly like a unit: each shard is a leaf Piece
  // whose origin sits at the shard's centroid (so `rotate` tumbles it in
  // place) and whose single drawGroup slices a freshly-uploaded shard VBO.
  // The shards keep the source material (texture / colour / hints), so the
  // debris still looks like shredded unit, not generic rubble.  Returns
  // { model, shardVbo } — or null when the model has no readable triangle
  // geometry, so the caller falls back to the legacy per-piece burst.
  const _buildShardModel = (sourceModel, count, rng) => {
    const geo = fragmentGeometry(sourceModel, { count, rng })
    if (!geo) return null
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, geo.floats, gl.STATIC_DRAW)
    const root = new Piece({ name: '__debris_root__' })
    for (const f of geo.fragments) {
      const p = new Piece({
        name: '__chunk__',
        originX: f.centroid[0], originY: f.centroid[1], originZ: f.centroid[2],
      })
      // The chunk bursts along its offset from the model centre — hand
      // debrisBurst the centroid so the scatter is a real radial explosion.
      p.centroid = f.centroid
      // A chunk is a whole COB piece and may carry several draw materials
      // (multi-texture hull); render each as its own sub-group over the shared
      // chunk VBO.  Older single-material fragments fall back to the headline.
      const subs = Array.isArray(f.groups) && f.groups.length
        ? f.groups
        : [{ first: f.first, vertexCount: f.vertexCount, textureName: f.textureName, color: f.color, depthTier: f.depthTier || 0, isDecal: !!f.isDecal, synthetic: !!f.synthetic, specScale: f.specScale, runningLights: f.runningLights, bump: f.bump }]
      p.drawGroups = subs.map((sg) => {
        const group = {
          vbo,
          mode: gl.TRIANGLES,
          first: sg.first,
          vertexCount: sg.vertexCount,
          textureName: sg.textureName,
          color: sg.color,
          depthTier: sg.depthTier || 0,
          isDecal: !!sg.isDecal,
          synthetic: !!sg.synthetic,
        }
        if (sg.specScale != null) group.specScale = sg.specScale
        if (sg.runningLights != null) group.runningLights = sg.runningLights
        if (sg.bump != null) group.bump = sg.bump
        return group
      })
      root.addChild(p)
    }
    const model = new Model({ name: '__debris__', root, bounds: sourceModel.bounds })
    // The shard VBO is this model's own buffer; Model.dispose frees it (we
    // also free it explicitly when the record leaves — see _stepPresentation).
    model.sharedVbo = vbo
    return { model, shardVbo: vbo }
  }

  // _spawnDebris pushes one flying-fragment debris record for a model at a
  // pose.  The model is SHATTERED into many small shards (finer than its COB
  // piece tree) so the death reads as an explosion of pieces flying outward,
  // not one big chunk spiralling.  Seeded from the unit's identity + cell so
  // a replay re-run scatters identically; impactDir/impactMag bias the shards
  // away from the killing blow (world-fx debrisBurst).  `severity` scales the
  // shard count (a commander blast throws the most).
  const _spawnDebris = ({ id, model, teamColor }, pose, { impactDir = null, impactMag = 0, severity = 100, velocity = null } = {}) => {
    if (!model) return
    const rng = mulberry32(featureSeed(String(id), Math.round(pose.x), Math.round(pose.z)))
    const radius = (model.boundsRadius && model.boundsRadius > 0) ? model.boundsRadius : 24
    const count = targetFragmentCount(radius, severity)
    const shard = _buildShardModel(model, count, rng)
    // Fall back to the whole per-unit clone (its COB pieces fly) when the
    // geometry can't be read for chunking — still animates, just coarser.
    const flyModel = shard ? shard.model : model
    debris.push({
      id,
      model: flyModel,
      shardVbo: shard ? shard.shardVbo : null,
      x: pose.x, y: pose.y, z: pose.z,
      headingRad: pose.headingRad || 0,
      teamColor,
      // velocity: the unit's travel velocity at death — the chunks inherit it
      // (momentum), thrown along the unit's heading on top of the radial burst.
      pieces: debrisBurst(flyModel, { rng, impactDir, impactMag, headingRad: pose.headingRad || 0, velocity }),
      ageMs: 0,
      lifeMs: DEBRIS_LIFE_MS,
    })
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

    // step advances every world-owned presentation effect (particles,
    // smoke trails, projectile meshes, debris, hit-rock, damage smoke,
    // the renderer's effect clock) by dtMs and renders exactly one frame.
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
      _stepPresentation(dtMs)
      if (!autoStart && typeof renderer.advanceFxClock === 'function') {
        renderer.advanceFxClock(dtMs)
      }
      syncEntities()
      if (!renderer.running) renderer.draw()
    },

    // addUnit loads (or reuses) the named model, clones an instance and
    // places it.  Resolves to the unit id once its geometry is ready.
    // heading defaults to the rest pose (π — TA models author the nose
    // toward -Z, so π renders the unit facing +Z un-rotated).
    // Presentation opts: grounded (clamp render Y to the terrain +
    // slope-tilt), hp01 (0..1 health fraction for the status bar +
    // damage smoke), rank (0..5 veteran stars, shown only while the
    // health bar shows), mobile (false marks a
    // structure — no hit-rock; omitted → inferred, see unitImpulse).
    async addUnit(name, { id = null, x = 0, y = 0, z = 0, heading = null, side = null, teamColor = null, buildPercent = undefined, grounded = false, hp01 = null, rank = 0, air = false, hover = false, naval = false, mobile = null, redraw = true } = {}) {
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
        rollRad: 0,
        grounded: !!grounded,
        air: !!air,
        hover: !!hover,
        naval: !!naval,
        mobile: mobile == null ? null : !!mobile,
        _posInit: true, // addUnit placement is explicit — later changes count as motion
        hp01,
        rank: rank | 0,
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
      // Motion latch — feeds the structure inference (unitRocksOnImpact).
      if ((x != null && x !== u.x) || (z != null && z !== u.z) ||
          (heading != null && heading !== u.headingRad)) {
        u._moved = true
      }
      if (x != null) u.x = x
      if (y != null) u.y = y
      if (z != null) u.z = z
      if (heading != null) u.headingRad = heading
      if (!renderer.running) world.step(0)
    },

    // setTerrain installs a battlefield (the loadMapTerrain payload) on the
    // renderer and makes terrainHeightAt/terrainNormalAt answer from it.
    // Equivalent to renderer.setMapTerrain — surfaced on the world so a
    // driver needs no renderer reach-through.  Pass null to clear.
    //
    // Features: when the payload carries features[] (packed maps do) and
    // opts.features isn't false, the map's features install too — GAF
    // sprite features as procedural 3D stand-ins baked into static batches
    // (map-features.js), object features as their real packed 3DO models.
    // Metal deposits + steam vents bake as FLAT terrain-conforming decals,
    // and each vent drives a live steam wisp off the fx clock.
    // The features.json catalogue loads from the AssetProvider
    // (featureDefs()); on a pre-v5 pack every feature falls back to a
    // category-less default stand-in.  Toggle later via
    // setFeaturesEnabled(on).
    setTerrain(terrain, { features = true } = {}) {
      featureBuildToken++
      featureModels.length = 0
      steamVents.length = 0
      if (terrain) renderer.setMapTerrain(terrain)
      else renderer.clearMapTerrain()
      // Auto-select a map-appropriate sky/environment from the OTA planet when
      // the caller didn't pin one — so the beyond-map background renders the
      // right sky dome + cloud layer (acid → marsh, lava → lava, etc.) instead
      // of the default earth sky. An explicit `environment` option always wins.
      if (terrain && !envPinned) {
        const envKey = planetEnvironment(terrain.planet)
        if (envKey) renderer.setEnvironment(envKey)
      }
      if (terrain && features && Array.isArray(terrain.features) && terrain.features.length) {
        const token = featureBuildToken
        featureDefs().then((defs) => {
          if (disposed || token !== featureBuildToken) return
          const field = buildFeatureField({
            features: terrain.features,
            defs,
            heightAt: terrainHeightAt,
            cellWU: (terrain.cellWU || 16),
          })
          renderer.setMapFeatures(field.batches)
          // Flat ground features (metal deposits, steam vents, scars…):
          // paint their REAL packed GAF art onto the terrain as textured
          // decals.  Load each distinct sprite, then install the decal
          // batches once the images have decoded (deterministic order).
          if (Array.isArray(field.decals) && field.decals.length && assets && typeof assets.featureSprite === 'function') {
            Promise.all(field.decals.map(async (d) => {
              try {
                const raw = await assets.featureSprite(d.sprite || d.feature)
                if (!raw) return null
                const image = await toTexImageSource(raw)
                return { image, data: d.data, count: d.count }
              } catch {
                return null
              }
            })).then((loaded) => {
              if (disposed || token !== featureBuildToken) return
              const ready = loaded.filter(Boolean)
              if (ready.length) {
                renderer.setFeatureDecals(ready)
                if (!renderer.running) world.step(0)
              }
            }).catch(() => { /* sprites missing — procedural fallback already baked */ })
          }
          // Steam vents: the baked decal is static; the wisp is live.
          // Each vent gets its own deterministic rng + a phase-staggered
          // accumulator so the map's vents don't puff in lockstep.
          for (const em of field.emitters || []) {
            if (em.kind !== 'steam') continue
            const rng = mulberry32(em.seed >>> 0)
            steamVents.push({ x: em.x, y: em.y, z: em.z, r: em.r, rng, accMs: rng() * STEAM_INTERVAL_MS })
          }
          field.models.forEach((m, idx) => {
            const rec = { idx, model: null, x: m.x, y: m.y, z: m.z, heading: m.heading, name: m.name }
            featureModels.push(rec)
            loadBaseModel(m.name).then((base) => {
              if (!disposed && token === featureBuildToken) rec.model = base.cloneForInstance()
            }).catch(() => { /* unpacked object feature — stays invisible */ })
          })
          if (!renderer.running) world.step(0)
        }).catch(() => { /* no feature catalogue — terrain still installed */ })
      }
      if (!renderer.running) world.step(0)
    },

    // setFeaturesEnabled toggles the map-feature pass (stand-in batches +
    // 3DO feature models) without rebuilding anything.
    setFeaturesEnabled(on) {
      renderer.setFeaturesEnabled(on)
      world._featuresOff = !on
      if (!renderer.running) world.step(0)
    },

    // terrainHeightAt samples the installed battlefield's surface Y at a
    // world XZ (0 on the flat pad).  This is the Y a `grounded` unit
    // renders at — see terrain-sample.js for the wire-Y ↔ render-Y story.
    terrainHeightAt(x, z) { return terrainHeightAt(x, z) },

    // terrainNormalAt returns the smoothed surface normal at a world XZ.
    terrainNormalAt(x, z) { return terrainNormalAt(x, z) },

    // setScriptPieceQuery installs the COB Query* resolver the weapon /
    // lathe conveniences use to find emitter pieces:
    //   world.setScriptPieceQuery((unitId, fnName) => session.queryScriptPiece(unitId, fnName))
    // fn returns the COB piece-table index the unit's Query function
    // reported, or -1.  Pass null to uninstall (everything falls back to
    // unit-origin anchors).  The world stays renderer-only: it never
    // imports the engine, it just calls whatever the driver wires in.
    setScriptPieceQuery(fn) {
      scriptPieceQuery = typeof fn === 'function' ? fn : null
    },

    // unitPieceWorldPos returns the CURRENT world position [x, y, z] of one
    // of a unit's model pieces, composed through the full rendered
    // transform chain — unit position, heading/pitch/roll (slope tilt +
    // hit-rock included) and the piece tree's live COB pose.  `piece` is a
    // piece NAME, or a COB piece-table INDEX (an engine queryScriptPiece /
    // FromPiece value), resolved through the unit's pieceNames from
    // applyState.  Null when the unit / model / piece can't be resolved —
    // callers fall back to the unit origin.
    unitPieceWorldPos(id, piece) {
      return _pieceWorldPos(id, piece)
    },

    // applyState replaces the whole rendered world from a sim snapshot
    // (the engine's frame.Snapshot shape):
    //   { units: [{ id, model|name, x, y, z, heading, pitch?, roll?,
    //       buildPercent?, side?, teamColor?,
    //       grounded?,                    // clamp render Y to terrain + slope-tilt
    //       mobile?,                      // false = structure (no hit-rock); omitted → inferred
    //       hp01?,                        // 0..1 health (status bar + damage smoke)
    //       rank?,                        // 0..5 veteran stars (rendered only while damaged)
    //       dead?, deathSeverity?, corpse?, heapCorpse?,  // see unitDeath()
    //       pieceNames?: [...],           // the type's COB piece table
    //       piecesPacked?: Uint8Array,    // engine stride-7 piece buffer
    //       pieces?: [{ move:[x,y,z], rotate:[x,y,z], visible }] }],
    //     projectiles: [{ id, model?, x, y, z, heading?, pitch? }],
    //     events: [{ kind: 'emitSfx'|'explode', unitId?, sfxType?, x, y, z }] }
    //
    // heading is radians in the game convention — feed a raw TA heading
    // through headingToRadians (cob-pose.js) or pass the engine snapshot's
    // headingRad straight through.  Positions/headings may be externally
    // interpolated between engine ticks (see lerpPackedPieces in
    // cob-pose.js for the piece-transform half) — applyState just renders
    // what it is handed.
    //
    // A unit marked dead:true that is still live in this world triggers
    // unitDeath(id, { severity: deathSeverity, corpse, heapCorpse }) once —
    // the applyState-driven form of the death visual.
    //
    // Events: engine render events pass straight through — 'emitSfx'
    // (COB emit-sfx smoke/bubbles from e.g. SmokeUnit threads) emits the
    // mapped particle kind at the event's anchor; 'explode' (COB EXPLODE
    // death-throes) emits a debris flash.  Unknown kinds are ignored, so a
    // driver can forward the engine's whole events array unfiltered.
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
        if (su.dead) {
          if (units.has(su.id)) {
            world.unitDeath(su.id, {
              severity: su.deathSeverity != null ? su.deathSeverity : (su.severity || 0),
              corpse: su.corpse || null,
              heapCorpse: su.heapCorpse || null,
              impactDir: su.impactDir || null,
              impactMag: su.impactMag != null ? su.impactMag : 0,
              // Death-weapon blast diameter (WU) from the pack unitdb meta —
              // the driver forwards meta.explodeWeapon.areaOfEffectWU (or the
              // selfDestructWeapon's for a manual self-destruct). Sizes/styles
              // the blast: commander AoE → mushroom cloud.
              deathAoe: su.deathAoe != null ? su.deathAoe : 0,
              // velocity: optional [vx,vy,vz] WU/s the unit was travelling at
              // death, so its debris inherits that momentum.  When omitted the
              // world measures it from the unit's own position history — a
              // driver only needs to pass it for a unit that died the same
              // frame it appeared (no motion history to measure).
              velocity: Array.isArray(su.velocity) ? su.velocity : null,
              redraw: false,
            })
          }
          continue
        }
        const name = su.model || su.name
        if (su.id == null || !name) continue
        seen.add(su.id)
        let u = units.get(su.id)
        if (!u || u.name !== name) {
          u = { id: su.id, name, model: null, x: 0, y: 0, z: 0, headingRad: REST_HEADING, pitchRad: 0, rollRad: 0 }
          units.set(su.id, u)
          // Attach the model clone synchronously when the base is already
          // loaded — the promise path defers past this applyState's own
          // step(), leaving the unit invisible for a frame (whole-unit
          // pop-in on every snapshot re-add).  Only a type's genuinely
          // first sighting still loads async.
          const ready = modelReady.get(name)
          if (ready) {
            u.model = ready.cloneForInstance()
          } else {
            loadBaseModel(name).then((base) => {
              if (!disposed && units.get(su.id) === u) u.model = base.cloneForInstance()
            }).catch(() => units.delete(su.id))
          }
        }
        // Motion latch — a position/heading change after the FIRST
        // placement marks the unit as having moved, which the structure
        // inference (unitImpulse / unitRocksOnImpact) keys on.  The first
        // snapshot merely places the fresh record, so it doesn't count.
        if (u._posInit) {
          if ((su.x != null && Math.abs(su.x - u.x) > 1e-3) ||
              (su.z != null && Math.abs(su.z - u.z) > 1e-3) ||
              (su.heading != null && Math.abs(su.heading - u.headingRad) > 1e-4)) {
            u._moved = true
          }
        } else {
          u._posInit = true
        }
        if (su.x != null) u.x = su.x
        if (su.y != null) u.y = su.y
        if (su.z != null) u.z = su.z
        if (su.heading != null) u.headingRad = su.heading
        if (su.pitch != null) u.pitchRad = su.pitch
        if (su.roll != null) u.rollRad = su.roll
        if (su.grounded != null) u.grounded = !!su.grounded
        if (su.air != null) u.air = !!su.air
        if (su.hover != null) u.hover = !!su.hover
        if (su.naval != null) u.naval = !!su.naval
        if (su.mobile != null) u.mobile = !!su.mobile
        if (su.tilt != null) u.tilt = !!su.tilt
        if (su.hp01 != null) u.hp01 = su.hp01
        if (su.rank != null) u.rank = su.rank | 0
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
          const ready = modelReady.get(sp.model)
          if (ready) {
            rec.model = ready
          } else if (modelCache.has(sp.model)) {
            modelCache.get(sp.model).then((m) => { rec.model = m }).catch(() => {})
          } else {
            loadBaseModel(sp.model).catch(() => {})
          }
        }
        projectiles.push(rec)
      }
      for (const ev of snapshot.events || []) {
        world.sfxEvent(ev)
      }
      if (!renderer.running) world.step(0)
    },

    // sfxEvent renders one engine render event (cmd/engine-wasm event
    // shape).  Supported kinds:
    //   'emitSfx' — COB emit-sfx.  sfxType maps TA's point-based ids onto
    //     particle kinds: 256 black smoke, 257 white smoke, 259 bubbles;
    //     anything else falls back to white smoke.  This is how a COB
    //     SmokeUnit thread's damage plume reaches an applyState world.
    //   'explode' — COB EXPLODE (death-throes debris): a brief flash.
    // Unknown kinds no-op so callers can forward events unfiltered.
    sfxEvent(ev) {
      if (!ev || !Number.isFinite(ev.x)) return
      const pool = worldBinding.particles
      if (ev.kind === 'emitSfx') {
        const t = ev.sfxType | 0
        // TA SFXTYPE_POINTBASED band (256|n): 256 black smoke, 257 white
        // smoke, 259 sub bubbles; anything else reads as light smoke.
        let kind = SFX_SMOKE_WHITE
        if (t === 256) kind = SFX_SMOKE_GREY
        else if (t === 259) kind = SFX_SUB_BUBBLES
        pool.emit(kind, [ev.x, ev.y || 0, ev.z || 0], {})
      } else if (ev.kind === 'explode') {
        pool.emit(SFX_FIRE_FLASH, [ev.x, ev.y || 0, ev.z || 0], { size: 20, lifeMs: 420, color: [1.7, 0.6, 0.2, 1.0] })
      }
    },

    // unitImpulse applies a presentation-only "hit rock": the unit shudders
    // about its pitch/roll axes on a damped spring and settles back.  No
    // sim state is touched.  dirX/dirZ is the impact's push direction in
    // world space (from the shooter toward the unit); mag scales the kick
    // (1 ≈ a light autocannon round, 4 ≈ a heavy shell).
    //
    // Structures don't rock: a unit with mobile:false (addUnit/applyState),
    // or — with no flag — a grounded unit that has never moved or yawed
    // since it appeared, ignores the impulse entirely (world-fx
    // unitRocksOnImpact).  Drivers that know their buildings should pass
    // mobile:false; the never-moves inference covers those that don't.
    unitImpulse(id, { dirX = 0, dirZ = 0, mag = 1 } = {}) {
      const u = units.get(id)
      if (!u || !unitRocksOnImpact(u)) return
      const len = Math.hypot(dirX, dirZ) || 1
      const px = dirX / len, pz = dirZ / len
      // World push → the unit's local frame (inverse yaw).
      const c = Math.cos(u.headingRad), s = Math.sin(u.headingRad)
      const lx = c * px - s * pz
      const lz = s * px + c * pz
      if (!u._imp) u._imp = { p: 0, r: 0, vp: 0, vr: 0 }
      const kick = IMPULSE_KICK_SCALE * Math.min(4, Math.max(0.1, +mag || 1))
      // A push along local -Z (from the front) rocks the nose up; a push
      // along local X rolls away from the hit.
      u._imp.vp += -lz * kick
      u._imp.vr += lx * kick
    },

    // unitDeath plays a unit's death: either swap in its wreck (the FBI
    // corpse feature's 3DO, packed by kbot pack v3+; the model sinks
    // slightly into the ground and PERSISTS until removeCorpse/clearCorpses)
    // or blow the unit into flying polygons (its piece tree scatters under
    // gravity — TA's COB-EXPLODE debris look), with severity picking
    // between them the way TA's Killed(severity) corpsetype ladder does:
    //   severity < 50   → intact wreck (corpse)
    //   50 ≤ severity < 100 → debris + the damaged heap wreck (heapCorpse,
    //                        falling back to corpse)
    //   severity ≥ 100  → debris only, nothing survives
    // An explicit corpse/heapCorpse of null with debris omitted still
    // resolves through the ladder; pass corpse names from the pack's
    // unitdb meta (corpseObject / corpseHeapObject).
    //
    // The live unit is removed immediately (a corpse is not a commandable
    // actor); applyState snapshots that stop listing the unit are the
    // normal driver flow.
    // impactDir ([x, z], world frame, source → victim) + impactMag bias the
    // debris scatter away from the killing blow; a replay driver derives
    // them from the killer/victim positions on a kill event.  Airborne
    // units (applyState air:true) don't pop in place: they enter a spiral
    // crash — a spinning, rolling, smoking descent that detonates (debris
    // and all) where it meets the terrain, or splashes into the sea.
    // deathAoe — the unit's death-explosion blast DIAMETER in world units,
    // read by the CONSUMER from the pack unitdb's per-unit meta
    // (meta.explodeWeapon.areaOfEffectWU, or meta.selfDestructWeapon's for a
    // manual self-destruct — the FBI explodeas / selfdestructas weapon).  This
    // is the honest data path: the pack already resolves each unit's
    // ExplodeAs/SelfDestructAs weapon into that AoE, so the replayer passes it
    // straight through rather than the world re-deriving a size from the model
    // radius.  It SIZES + STYLES the death detonation: the explosion tier
    // ladder scales with it (peewee AoE 30 → small/medium; commander
    // COMMANDER_BLAST AoE 950 → the mushroom-cloud tier).  When omitted the
    // world falls back to a model-radius estimate (a uniform-ish pop), so old
    // drivers still work — they just don't get commander-scale blasts.
    unitDeath(id, { severity = 0, corpse = null, heapCorpse = null, impactDir = null, impactMag = 0, deathAoe = 0, velocity = null, redraw = true } = {}) {
      const u = units.get(id)
      if (!u) return false
      const pose = _unitPose(u)
      const r = u.model ? (u.model.boundsRadius || 16) : 16
      // Momentum: the unit's travel velocity at death, so a moving unit throws
      // its debris along its heading.  An explicit driver-supplied `velocity`
      // wins; otherwise measure it from the motion latch (aircraft AND ground).
      const deathVel = Array.isArray(velocity) ? velocity : _unitVelocity(u)
      const airborne = u.air && !u.grounded && pose.y > terrainHeightAt(pose.x, pose.z) + r
      // A high aircraft leaves a brief smoke puff at the detonation point so
      // the kill still reads from below, but it EXPLODES IN PLACE — no spiral
      // dive.  Its debris then arcs out and falls to terrain under gravity.
      if (airborne) {
        worldBinding.particles.emit(SFX_SMOKE_GREY, [pose.x, pose.y, pose.z], { size: 12, lifeMs: 1100 })
      }
      const plan = resolveDeathPlan({ severity, corpse, heapCorpse })
      // Death detonation.  Size from the unit's death-explosion weapon AoE
      // when the driver supplies it (commander >> peewee); otherwise fall
      // back to a model-radius estimate.  Both AoE and severity ride the
      // explosion tier ladder (a commander-class AoE selects the mushroom
      // cloud; see explosion-fx tierFor).  The particle burst (flash/sparks/
      // smoke) already scales its counts with AoE in impactBurst.  The blast
      // detonates AT the unit's current position — in place, ground or air.
      const blastAoe = deathAoe > 0 ? deathAoe : Math.max(24, r * 2.2)
      impactBurst(worldBinding, [pose.x, pose.y + r * 0.4, pose.z], {
        aoe: blastAoe, kind: 'death', severity,
      })
      if (plan.debris && u.model) {
        _spawnDebris({ id, model: u.model, teamColor: u.teamColor }, pose, { impactDir, impactMag, severity, velocity: deathVel })
      }
      if (plan.corpse) {
        const rec = {
          id,
          model: null,
          x: pose.x,
          y: terrainHeightAt(pose.x, pose.z) - CORPSE_SINK_WU,
          z: pose.z,
          headingRad: u.headingRad,
        }
        corpses.set(id, rec)
        loadBaseModel(plan.corpse).then((base) => {
          if (!disposed && corpses.get(id) === rec) rec.model = base.cloneForInstance()
        }).catch(() => corpses.delete(id))
      }
      units.delete(id)
      if (redraw && !renderer.running) world.step(0)
      return true
    },

    // removeCorpse drops one persistent wreck (e.g. when a recording shows
    // it reclaimed); clearCorpses drops them all (replay seek/reset).
    removeCorpse(id) { corpses.delete(id) },
    clearCorpses() { corpses.clear() },
    corpseIds() { return Array.from(corpses.keys()) },

    // latheBeam drives the TA construction visual: a green nano-particle
    // spray from the builder to the build target, plus the target's own
    // rising wireframe→solid treatment (which buildPercent drives through
    // applyState).  Keyed so a driver toggles per build order:
    //
    //   world.latheBeam('b1', { fromUnitId, toUnitId })      // on
    //   world.latheBeam('b1', { on: false })                 // off
    //
    // Endpoints: fromUnitId/toUnitId track live units, from/to are fixed
    // [x,y,z] positions (a build site before the frame exists).  The
    // stream is deterministic (seeded per key, fx-clock cadence).
    //
    // A fromUnitId resolves the builder's nano-spray emitter through its
    // COB QueryNanoPiece (via the setScriptPieceQuery resolver) once at
    // beam start; the spray then tracks that piece's LIVE world position —
    // a construction arm's nozzle, not the hull centre.  Missing resolver
    // / script / piece falls back to the mid-hull anchor as before.
    latheBeam(key, { fromUnitId = null, toUnitId = null, from = null, to = null, on = true, color = null } = {}) {
      if (!on) { beams.delete(key); return }
      beams.set(key, {
        kind: 'build',
        from: fromUnitId != null ? { unitId: fromUnitId, piece: _nanoPiece(fromUnitId) } : { pos: from },
        to: toUnitId != null ? { unitId: toUnitId } : { pos: to },
        color: color || [0.45, 1.9, 0.85, 0.9],
        accMs: 0,
        rng: mulberry32(featureSeed(String(key), 7, 13)),
      })
    },

    // reclaimBeam is the reverse flow: nano particles stream FROM the
    // wreck (or unit/position) back INTO the builder, and a corpseId
    // target shrinks while the beam holds it (RECLAIM_MIN_SCALE floor).
    // The consumer still owns the wreck's actual removal (removeCorpse on
    // the reclaim-finished event).
    reclaimBeam(key, { fromUnitId = null, corpseId = null, toUnitId = null, from = null, to = null, on = true, color = null } = {}) {
      if (!on) { beams.delete(key); return }
      beams.set(key, {
        kind: 'reclaim',
        from: fromUnitId != null ? { unitId: fromUnitId, piece: _nanoPiece(fromUnitId) } : { pos: from },
        to: corpseId != null ? { corpseId } : (toUnitId != null ? { unitId: toUnitId } : { pos: to }),
        color: color || [0.55, 1.7, 0.55, 0.9],
        accMs: 0,
        rng: mulberry32(featureSeed(String(key), 17, 29)),
      })
    },

    // captureFlash plays the capture-complete treatment on a unit: a brief
    // bright wireframe shell pulse + a spark shower.  Call it when the
    // recording reports the ownership flip (typically alongside applyState
    // switching the unit's side/teamColor).
    captureFlash(id) {
      const u = units.get(id)
      if (!u) return false
      u._captureMs = CAPTURE_FLASH_MS
      const pose = _unitPose(u)
      const cy = u.model && u.model.boundsCentre ? u.model.boundsCentre[1] : 6
      for (let i = 0; i < 8; i++) {
        worldBinding.particles.emit(SFX_SPARK, [pose.x, pose.y + cy, pose.z], {
          color: [0.5, 1.8, 0.8, 1], lifeMs: 320,
        })
      }
      return true
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
    // impact, no hashes.
    //
    // DATA-DRIVEN form (the replay path): pass `weapon` (a weapons.json id
    // from the pack — AssetProvider.weaponDefs(), format v4 fields) and the
    // shot renders through the same visual pipeline the studio sandbox
    // uses for that weapon:
    //   * lasers / lightning → palette-tinted pulse-chain beam + muzzle
    //     pop + impact burst, colour and duration from the def;
    //   * D-gun → the big disintegrator fireball with its flame trail and
    //     a violent scene light;
    //   * model projectiles (missiles / rockets / torpedoes / bombs) → the
    //     pack's projectile 3DO flies the trajectory (ballistic arcs for
    //     ballistic=1/dropped=1) with the TDF-cadenced smoke trail;
    //   * bitmap (rendertype 4) → the authentic fx.gaf sprite bolt (loads
    //     on first sight, synthetic tracer until it lands);
    //   * everything else → the classified particle tracer (shell /
    //     bullet / plasma), AoE-scaled, with startsmoke muzzle puffs.
    // Impacts detonate at the target with an AoE-sized burst; damage-free.
    // Explicit color/durationMs/velocity override the def.
    //
    // LEGACY explicit form: with no resolvable `weapon`, `type`
    // 'beam'|'laser' draws a fading line beam and 'tracer' a bright streak
    // (the original renderer-line path, kept for callers that pass raw
    // geometry).
    //
    // MUZZLE resolution: pass `fromUnit: { id, weaponSlot }` instead of
    // (or as well as) `from` and the shot originates at the unit's COB
    // muzzle piece — Query<Primary|Secondary|Tertiary> via the
    // setScriptPieceQuery resolver, positioned through the live piece
    // transform chain (so a swung turret's barrel tip is where the bolt
    // leaves).  Falls back gracefully to the unit's origin + a small
    // vertical offset when the resolver / query / piece is missing; an
    // explicit `from` is only used when the unit itself is gone.
    async weaponEffect({ type = null, from = null, to, color = null, durationMs = null, velocity = null, width = null, weapon = null, fromUnit = null } = {}) {
      if (fromUnit && fromUnit.id != null) {
        const muzzle = _resolveMuzzle(fromUnit.id, fromUnit.weaponSlot | 0)
        if (muzzle) from = muzzle
      }
      if (!Array.isArray(from) || !Array.isArray(to)) return
      // Line-of-sight: if a ridge sits between the muzzle and the aim point
      // the real engine BLOCKS the round (the target takes no damage), so the
      // visual must terminate on the slope with a dirt splash, NOT reach the
      // unit.  Raycast the shot path against the terrain heightfield and, when
      // it dips below the surface before the target, retarget `to` to that
      // impact and flag it a terrain hit.  Ballistic/model shots arc/step and
      // do their own terrain check, but retargeting still shortens their aim
      // and marks the impact as dirt.  Non-terrain env (headless tests with a
      // flat sampler) simply never blocks.
      let terrainImpact = false
      {
        const block = raycastTerrain(from, to, terrainHeightAt)
        if (block) {
          const toDist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
          // Only block when the slope is meaningfully closer than the target
          // (a shot skimming the target's own hilltop shouldn't misfire).
          if (block.dist < toDist - 1) {
            to = block.point
            terrainImpact = true
          }
        }
      }
      let def = null
      if (weapon) {
        const defs = await weaponDefs()
        def = defs[String(weapon).toLowerCase()] || null
      }
      if (def) {
        const res = spawnWeaponVisual({
          weapon: def,
          from,
          to,
          binding: worldBinding,
          palette,
          smokeTrails,
          modelShots,
          gravity: 100,
          overrides: { color, durationMs, velocity, width },
          env: { waterY: waterY(), heightAt: terrainHeightAt },
          terrainImpact,
        })
        worldBinding._lastFiredWeapon = def
        if (res && res.modelShot) {
          const shot = res.modelShot
          shot.id = nextId++
          loadBaseModel(shot.modelName)
            .then((m) => { shot.model = m })
            .catch(() => {
              // Mesh missing (pre-v4 pack): pick the flight up mid-air as a
              // particle tracer so the shot stays visible.
              if (disposed || shot.ageMs >= shot.lifeMs) return
              spawnProjectileInFlight({
                binding: worldBinding,
                weapon: def,
                pos: [shot.x, shot.y, shot.z],
                vel: [shot.vx, shot.vy, shot.vz],
                lifeMs: shot.lifeMs - shot.ageMs,
                palette,
                gravity: shot.gravity || 0,
              })
              const idx = modelShots.indexOf(shot)
              if (idx !== -1) modelShots.splice(idx, 1)
            })
        }
        if (!renderer.running) world.step(0)
        return
      }
      const isBeam = type ? (type === 'beam' || type === 'laser') : true
      let c = color
      if (!c) c = isBeam ? [0.4, 1, 0.35] : [1, 0.85, 0.4]
      let dur = durationMs
      if (dur == null && !isBeam) {
        const dist = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])
        const v = velocity || 300
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
        width: width || 2,
        streak: 0.18,
      })
      // Legacy path terminated on a slope: kick a dirt splash where the beam/
      // tracer buries into the terrain (no target hit).
      if (terrainImpact) {
        impactBurst(worldBinding, to.slice(0, 3), { aoe: 16, terrain: true })
      }
      if (!renderer.running) world.step(0)
    },

    // setQuality applies a renderer quality preset:
    //   'standard'  — the renderer defaults (shadows, specular + metal
    //                 hints, running lights, god beams, dynamic weapon
    //                 lights all on; no post chain).
    //   'cinematic' — adds the post chain: bloom (weapon glow + running
    //                 lights bleed into the scene), the ACES filmic
    //                 grade, and FXAA.
    // Both presets stay deterministic under an explicitly-stepped world
    // (the effect clock follows step(dtMs)).
    setQuality(name) {
      const p = QUALITY_PRESETS[name]
      if (!p) return false
      renderer.setBloomEnabled(!!p.bloom)
      if (p.bloomStrength != null) renderer.setBloomStrength(p.bloomStrength)
      renderer.setCinematic(!!p.cinematic)
      if (p.cinematicStrength != null) renderer.setCinematicStrength(p.cinematicStrength)
      renderer.setAntialiasEnabled(!!p.antialias)
      // Cinematic renders are wide establishing shots — push the far clip
      // plane out (paired with the log-depth buffer, so no z-fighting) so
      // distant units keep real geometry. The supersample factor is left to
      // the render harness (setSuperSample) since it's a heavy per-render knob.
      if (p.drawDistance != null && typeof renderer.setDrawDistanceScale === 'function') {
        renderer.setDrawDistanceScale(p.drawDistance)
      }
      return true
    },

    // setSuperSample forwards the render harness's supersample factor to the
    // renderer (offscreen SSAA). 1 = native (interactive default); the 1080p
    // render harness sets 2 for cleaner unit edges + less texture shimmer.
    setSuperSample(factor) {
      if (typeof renderer.setSuperSample === 'function') renderer.setSuperSample(factor)
    },

    // setDrawDistanceScale forwards a far-plane multiplier (1..8). The
    // cinematic quality preset already sets 4; a harness can override.
    setDrawDistanceScale(scale) {
      if (typeof renderer.setDrawDistanceScale === 'function') renderer.setDrawDistanceScale(scale)
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
      corpses.clear()
      featureModels.length = 0
      steamVents.length = 0
      beams.clear()
      for (const d of debris) {
        if (d.shardVbo) { try { gl.deleteBuffer(d.shardVbo) } catch { /* ignore */ } }
      }
      debris = []
      modelShots = []
      projectiles = []
      tracers = []
      weaponFx = []
      smokeTrails.clear()
      worldBinding.explosions.clear()
      renderer.dispose()
    },
  }

  world.setQuality(quality)
  if (autoStart) renderer.start()
  else world.step(0)
  return world
}
