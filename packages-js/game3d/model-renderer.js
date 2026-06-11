// ModelRenderer — owns the WebGL context for a single canvas and the
// per-frame render loop.  The render pipeline is:
//
//   1. shadow pass  — re-render the model from the directional light's
//      POV into a depth texture, producing the shadow map.
//   2. sky pass     — paint a vertical gradient as the scene backdrop
//      via a full-screen quad with depth-test disabled.
//   3. ground pass  — a textured ground plane underneath the model
//      receives the projected shadow.
//   4. main pass    — model geometry, sampling the shadow map to
//      darken self-shadowed fragments and combining a sun directional
//      with a sky/ground hemisphere ambient.
//
// The pipeline is deliberately a hair richer than the editor's flat
// map renderer because the user wants the modelling tab to feel like
// a "showroom" — the geometry is the star.  Browsers without
// WEBGL_depth_texture skip step 1; the model falls back to flat
// lighting + a soft blob shadow on the ground plane.

import { Mat4 } from './mat4.js'
import { loadAllShaders } from './shader-loader.js'
import {
  DEFAULT_CULL_ENABLED,
  CULL_RADIUS_PADDING_WU,
  PARTICLE_CULL_RADIUS_PADDING_WU,
  DEFAULT_SHADOW_LOD_ENABLED,
  SHADOW_LOD_MIN_PX,
  LOD_HYSTERESIS,
  TIER_FULL_MIN_PX,
  TIER_MID_MIN_PX,
  PROJECTILE_LOD_MULTIPLIER,
  SELECTED_IMPOSTOR_FLICKER_MS,
  EFFECT_LOD_SURFACE_MAX_WU,
  EFFECT_LOD_RUNNINGLIGHTS_MAX_WU,
  EFFECT_LOD_FADE_WU,
  RUNNING_LIGHT_COLOR_MERGE_PX,
  RUNNING_LIGHT_TIMING_BUCKETS,
  HOVERCRAFT_WOBBLE_SCALE,
  AIRCRAFT_BANK_SCALE,
} from './performance.js'
import { displayRgbForSide } from './team-colors.js'
import {
  SKY_PRESETS, ENVIRONMENT_PRESETS, GRAVITY_BY_ENV, GRAVITY_EARTH, loadWorlds,
} from './worlds.js'
import { applyResolvedHints } from './hints-textures.js'
import { pieceLightFor, hasOverridesFor, pulseAlpha } from './piece-light-overrides.js'
import { MAX_PULSE_LIGHTS, setMaxSceneLights } from '/engine/scene-lights.js'

const VERTEX_STRIDE = 9 * 4 // 9 floats × 4 bytes (pos×3, normal×3, uv×2, ao×1)
// Scratch buffers for the dynamic pulse-light uniform arrays, sized to
// MAX_PULSE_LIGHTS so the per-frame upload never allocates.  Positions and
// colours are vec3 (3 floats each); ranges are scalar.
const _PULSE_POS = new Float32Array(MAX_PULSE_LIGHTS * 3)
const _PULSE_COLOR = new Float32Array(MAX_PULSE_LIGHTS * 3)
const _PULSE_RANGE = new Float32Array(MAX_PULSE_LIGHTS)
// Fallback transform for entities with no explicit transform field —
// referenced by the frustum-cull predicate so the hot path doesn't
// allocate a fresh object per entity per frame.
const _IDENTITY_T = Object.freeze({ x: 0, y: 0, z: 0, headingRad: 0 })
// LOD tier ids — stored on each entity as `_lodTier` between frames so
// the hysteresis classifier knows the previous tier.  Ordered
// largest→smallest so a numeric comparison works ("tier > Mid" =
// "looks more detailed than Mid").
const LOD_TIER_FULL = 0
const LOD_TIER_MID  = 1
const LOD_TIER_FAR  = 2
const POS_OFFSET = 0
const NRM_OFFSET = 3 * 4
const UV_OFFSET = 6 * 4
const AO_OFFSET = 8 * 4

const SHADOW_MAP_SIZE = 1024

// Multi-entity (sandbox) shadow-frustum clamp.  A single shadow map only
// stays crisp while its ortho box is small: sizing it to enclose every
// spawned unit collapses each unit's footprint to a handful of texels
// (blocky "square" shadows) and stretches the depth range until the
// fixed bias can't stop peter-panning (the shadow tears off and reads as
// sinking through the ground).  Instead the sandbox follows the CAMERA —
// the same anchor the ground plane uses — with the half-extent clamped to
// this window so resolution stays high where the user is looking.  Units
// outside it cast no shadow, which already matches the shadow-distance LOD
// dropping faraway casters.
const SHADOW_FRUSTUM_MIN_WU = 48
const SHADOW_FRUSTUM_MAX_WU = 160

// DoF tuning bases.  DOF_BASE_GAP is the window-depth gap from 1.0 that
// puts the blur onset at the unit's default framing distance (~25 wu)
// at a "1×" Distance setting; because window depth is ~inversely
// proportional to world distance in our near/far range, the onset
// distance scales as 1/gap, so a Distance multiplier m just divides the
// gap.  DOF_BASE_BLUR is the max blur radius (px) at a "100 %" Amount.
const DOF_BASE_GAP = 0.002
const DOF_BASE_BLUR = 8

// Shader sources live in shaders/{main,sky,ground,shadow,wire,dof}/
// as .vert/.frag files so they open with proper GLSL highlighting in
// editors.  shader-loader.js fetches + resolves `#include` directives
// and the renderer pulls the bodies via init() before linking
// programs.  All the inline template-literal shader constants that
// used to live here have moved to those files; this comment is the
// trail of breadcrumbs.

// SKY_PRESETS / ENVIRONMENT_PRESETS / GRAVITY_BY_ENV now live in the editable
// per-world JSON under game3d/worlds/ and are loaded by worlds.js (imported
// above).  The renderer consumes the same map shapes it always has; the only
// behavioural change is each world now carries its own unit key-light colour
// (env.lightColor), applied in setEnvironment so the world's sun tints units
// + scenery.  Add/edit a world by editing its JSON file — no code change.

export class ModelRenderer {
  constructor({ canvas, textureCache, gl }) {
    this.canvas = canvas
    const ctx = gl || canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false, stencil: false, alpha: false })
    if (!ctx) throw new Error('WebGL unavailable')
    this.gl = ctx
    this.textureCache = textureCache
    this.model = null

    // Light comes from above-left-forward.  Direction points *toward*
    // the light from the model — typical convention for dot(N, L).
    this.lightDir = ModelRenderer.#normalise([-0.6, 0.95, 0.4])
    // Brighter than 1.0 — Studio Mode was reading darker than Flat /
    // Wireframe because the per-pixel lighting goes through the
    // tone-map (`col / (col + 0.55)`), which clips a single light
    // unit to ~0.65 luminance.  Bumping the sun + ambient pushes
    // typical hull pixels back into a comfortable 0.7-0.85 range.
    this.lightColor = [1.55, 1.45, 1.30]
    // Optional second light, used by the twin-sun environment.  All
    // zeros → no second light, no second shadow pass.  Set by
    // setEnvironment when the active sky scheme defines sun2.
    this.lightDir2 = [0, 1, 0]
    this.lightColor2 = [0, 0, 0]
    // Exposure — master scene light-intensity multiplier applied to the
    // lit unit colour before the tone curve (Graphics Options Brightness
    // slider).  1.0 = default; lower for richer/darker, higher to
    // brighten.  Unit-shader only — ground/sky/water keep their own
    // levels.
    this.exposure = 1.0
    // Specular intensity — scales the hull Blinn-Phong sheen (Graphics
    // Options "Specular Highlights" intensity slider).  1 = default.
    this.specularStrength = 1.0
    // Surface-hint intensity sliders — scale the running-lights glow and the
    // auto-bump relief (Graphics Options).  1 = default.
    this.rlStrength = 1.0
    this.bumpStrength = 1.0
    // skyScheme picks the gradient + suns + clouds painted by the
    // skybox shader.  Setter `setSkyScheme(name)` swaps presets at
    // runtime; the renderer doesn't care which preset is active —
    // it just hands the uniforms to the GPU each frame.
    this.skyScheme = SKY_PRESETS.earth
    // activeEnvironment tracks the full env preset (sky scheme +
    // terrain + light dir + water tints).  Pulled from each frame
    // when the sea shader needs its tint stops.
    this.activeEnvironment = ENVIRONMENT_PRESETS.greenworld
    this.skyColor = [0.95, 1.00, 1.08]
    this.groundColor = [0.32, 0.30, 0.26]
    this.skyTop = [0.35, 0.45, 0.6]
    this.skyBottom = [0.07, 0.09, 0.12]
    this.groundColorA = [0.12, 0.14, 0.18]
    this.groundColorB = [0.18, 0.2, 0.25]

    // Team colour picker.  When teamColorEnable is true, the MAIN_FS
    // shifts the texture's blue (hue ≈ 225°) team palette range to
    // this RGB.  The "blue" team is the original game default, so
    // null means "leave the texture alone".
    this.teamColor = null
    this.teamColorEnable = false

    // Background mountain ring.  The renderer paints procedural
    // mountains on non-sea ground modes, outside a clearing centred
    // on the unit.  Style + colours come from the active environment
    // preset; the radius / falloff / height multiplier scale with
    // the unit's bounding span so a Krogoth gets a bigger valley
    // than a flea.  optBgTerrain gates the whole feature.
    this.optBgTerrain = true
    this.bgTerrainHeightMul = 1.0       // user-controlled scalar applied to env's mountainHeight
    this.bgTerrainScaleMul = 1.0        // user-controlled scalar applied to env's mountainScale
    this.bgTerrainStyle = 0             // 0=rocky 1=angular metal 2=sand dunes (env overrides on setEnv)
    this.bgTerrainBase = [0.30, 0.30, 0.34]
    this.bgTerrainPeak = [0.85, 0.85, 0.90]
    this.bgTerrainGloss = 0.0
    // Seabed feature sliders mirror the same idea for sea worlds.
    // These multiply uniforms in the GLSL seabedHeight() helper - 1.0
    // = stock tuning, 0 = smooth dune-only bed, larger = more
    // dramatic outcrops.
    this.seabedHeightMul = 1.0
    this.seabedScaleMul = 1.0
    this.seabedRockChance = 0.12

    // Auto-rotate is OFF by default — the user opts in (R key or the
    // Camera menu's Auto-Rotate toggle).  The sandbox already forces it
    // off explicitly; the unit viewer reads its persisted/host default
    // via tab activate.  Starting false avoids an initial spin before
    // that host value is applied.
    this.autoRotate = false
    this.rotateY = 0
    this.lastFrameMs = 0
    this.running = false
    this.rafId = 0
    // _t0: monotonic clock baseline for the Sea ground shader's
    // animated waves (uTime = (now − _t0) / 1000).  Anchored at
    // construction so each ModelRenderer has its own t=0.
    this._t0 = performance.now()
    // Unit "effect clock" — a pausable, speed-scaled clock that drives every
    // animation tied to the sim: running-light blink, sea bobbing/swaying, and
    // the sea SURFACE waves the hull rides on (so the bob stays glued to the
    // swell at any playback rate).  It advances each frame by the wall delta
    // times the attached COB runtime's `playbackRate`, and by 0 while paused —
    // so the effects freeze on pause and run faster/slower in lock-step with
    // the Runtime Speed slider.  Integrated once per frame in _syncFxClock;
    // _fxTimeSec just reads the accumulator so all reads in a frame agree.
    // The sky keeps real wall time (see uSkyTime) so the scene never looks
    // wholly dead when the sim is paused.
    this._fxPaused = false
    this._fxTimeMs = 0
    this._fxLastMs = performance.now()
    // hoveredPieceName: the piece currently hovered in the sidebar
    // tree, set by the host UI via setHoveredPieceName.  Triggers a
    // red-wireframe overlay around just that piece during draw.
    this._hoveredPieceName = null
    // _hoveredTexture — the Textures tab in the left panel sets
    // this when the user hovers a texture row.  Every piece whose
    // drawGroups reference that texture gets its wireframe painted
    // alongside the piece-hover highlight, so the user can see
    // which faces use that atlas.
    this._hoveredTexture = null

    // ── View settings ────────────────────────────────────────────────
    // renderMode: 'full' (lit + textured), 'flat' (textured + flat
    // shading, no shadows), or 'wireframe' (line edges only).
    this.renderMode = 'full'
    // wireframeOverlay: draw the wireframe edges on top of whichever
    // mode is active.  Independent of renderMode.
    this.wireframeOverlay = false
    // wireframeWidth: thickness hint passed to gl.lineWidth.  Most
    // drivers cap at 1 — to make wider lines visible the renderer
    // also draws the wireframe pass multiple times with a tiny NDC
    // jitter as a cheap fake "wider line" fallback.
    this.wireframeWidth = 1
    // buildPercent: 0..100 simulated construction progress.  Below
    // 100, the main pass renders at reduced alpha and a pulsing
    // green nano-wireframe overlay is drawn underneath / over (so
    // the unit reads as "still building").  100 = textured normally.
    this.buildPercent = 100
    // groundMode: 'grid' (light-green TA-tile lattice), 'terrain'
    // (greenworld flat texture, tiled), or 'off' (no ground plane).
    this.groundMode = 'terrain'
    // ── Terrain texture (lazy-loaded the first time the user picks
    // the Terrain ground mode).  GL texture ID + a ready flag the
    // ground shader uses to fall back to its plain look until decode.
    this._terrainTex = null
    this._terrainReady = false
    // Tileset name to fetch when the user picks Terrain.  Environment
    // presets swap this to match the visual world (mars → 'desert',
    // arctic → 'arctic', etc.).
    this.terrainTileset = 'greenworld'

    // ── Studio Options toggles ──────────────────────────────────
    // Each gates a specific effect that the user can flip off when
    // they want a cleaner / faster render or are looking for
    // something specific in the model.  All default to on.
    // Submersion mode tells the renderer how to position the unit
    // relative to the water plane: 'surface' = ship riding the
    // boot-stripe at waterline; 'submerged' = submarine fully under
    // water; '' = sits ON the water (the previous default).  Comes
    // in from the host via setSubmersionMode().
    this.submersionMode = ''
    this.optReflections = true       // unit's mirrored reflection on the water
    this.optBob = true               // unit heave + pitch + roll on the swell
    this.optWaterReflections = true  // sky / sun reflected in the water surface
    this.optSpecular = true          // sun's specular highlight on water + hull
    this.optMetalSpec = true         // boost hull specular on metal-named textures
    this.optRunningLights = true     // colour-keyed blinking emissive status lamps
    this.optBump = true              // derivative auto-bump relief on tagged tiles
    this.optGodBeams = true          // light shafts from the sun(s)
    this.optWaves = true             // animate sea surface; false → flat sea
    // Slider-controlled multipliers — all default to 1.0 (no scaling).
    this.bobAmount = 1.0             // scales heave + pitch + roll
    this.bobSpeed = 1.0              // scales the bob's time progression
    this.wavesIntensity = 1.0        // scales wave amplitude (both vertex + frag)

    // Enable optional extensions.  Anisotropic gets forwarded to the
    // texture cache so future uploads use it; depth-texture gates the
    // entire shadow-mapping pipeline.
    this._depthExt = ctx.getExtension('WEBGL_depth_texture') || ctx.getExtension('WEBKIT_WEBGL_depth_texture')
    // Screen-space derivatives — enables the auto-bump surface hint
    // (dFdx/dFdy in main.frag).  Universally available on the desktop
    // browsers the studio targets; when absent we leave the bump batches
    // un-flagged so the shader's gated branch never runs.
    this._derivExt = ctx.getExtension('OES_standard_derivatives')
    const aniso = ctx.getExtension('EXT_texture_filter_anisotropic') || ctx.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
    if (aniso && textureCache) textureCache.setAnisotropicExt(aniso)

    // DoF toggle + tuning parameters.  Default off so users see no
    // surprises until they opt in via the Graphics Options menu.
    this.optDof = false
    // NDC depth is wildly nonlinear: with near=0.05 / far=6000,
    // z_ndc=0.985 sits at only ~3 world units from the camera.  The
    // "in-focus" plane is therefore expressed as a window-depth value
    // (uFocalDepth); blur ramps from there to uFocalDepth+range.
    //
    // In this near/far regime the depth GAP from 1.0 is ~inversely
    // proportional to the onset world distance (gap ≈ near/distance),
    // so the user-facing "Distance" control is a plain multiplier on a
    // base onset (DOF_BASE_GAP → focalDepth 0.998 ≈ 25 wu at 1×).  The
    // default is 5× — blur only the genuine far background, leaving the
    // unit and its near surroundings sharp.  "Amount" scales the max
    // blur radius off DOF_BASE_BLUR.
    this.dofDistanceMul = 5
    this.dofFocalDepth = 1 - DOF_BASE_GAP / this.dofDistanceMul
    this.dofFocalRange = 0.0015
    this.dofMaxBlur = DOF_BASE_BLUR

    // Cinematic post-grade — gentle filmic contrast/saturation + highlight
    // roll-off + vignette.  Default off so the baseline look is unchanged
    // until the user opts in via Graphics Options.  Any post-FX (DoF,
    // cinematic, bloom, lens flare, anti-aliasing) routes the scene through
    // the offscreen FBO + composite chain.
    this.optCinematic = false
    this.cinematicStrength = 1.0    // 0..1 grade mix toward the graded image
    this.optBloom = false
    this.bloomStrength = 1.0
    this.optLensFlare = false
    this.lensFlareStrength = 1.0
    // Anti-aliasing (FXAA) — its own toggle, independent of the cinematic
    // grade.  When on it forces the scene through the offscreen FBO +
    // composite so the final image can be run through the edge-smoothing
    // FXAA pass even with every other post-effect disabled.
    this.optAntialias = false
    // Shader program init is deferred to ModelRenderer.init() — that
    // method fetches shader sources from shaders/ and links them.  Set
    // to true once init() has resolved so render() bails early when
    // called from a stray RAF before shaders are ready.
    this._programsReady = false

    // Scratch matrices live on the instance so per-frame work doesn't
    // allocate.  worldScratch threads through Piece.computeWorldMatrix.
    this._scratch = Mat4.create()
    this._worldScratch = Mat4.create()
    this._modelMatrix = Mat4.identity(Mat4.create())
    // unitTransform = { x, y, z, headingRad } — applied to
    // _modelMatrix every frame so the Controls panel's Move action
    // can walk / fly the unit around the scene.  Y is the runtime
    // altitude offset (aircraft rise during flight); the
    // mode-specific submersion offset is layered on TOP via
    // getUnitYOffset so a flying-over-water unit still sits above
    // the surface, not below.  Defaults are zero so legacy call
    // sites that never set this see the unit at world origin.
    this._unitTransform = { x: 0, y: 0, z: 0, headingRad: 0 }
    // Locomotion-flavoured orientation overlay layered on top of the unit
    // transform: aircraft bank into turns + pitch their nose on climb/descend,
    // and hovercraft gyrate/wobble on their air cushion.  `_loco` is the
    // FBI-derived descriptor the host sets via setUnitLocomotion; `_orient` is
    // the smoothed pitch/roll/heave applied each frame; `_locoPrev` tracks the
    // previous transform so we can derive turn rate + speed from the stream.
    this._loco = { hover: false, aircraft: false, bankScale: 0, pitchScale: 0 }
    // Per-unit overlay state — previous transform (to derive turn-rate / speed
    // / climb) + the smoothed pitch/roll/heave currently applied.  The single
    // unit uses _locoState; sandbox entities each get their own in _entOrient
    // (keyed by entity id) so every flier banks + every hovercraft wobbles.
    this._locoState = { heading: 0, x: 0, z: 0, y: 0, t: 0, init: false, pitch: 0, roll: 0, heave: 0 }
    this._entOrient = new Map()
    // Multi-entity mode — when an array is set here, draw() iterates
    // over each entity and renders its model independently after the
    // shared sky/ground pass.  Each entity is
    // { model, transform: {x,y,z,headingRad}, binding, buildPercent,
    //   particles, selected }.  When null, the renderer falls back
    //  to single-unit mode driven by `this.model` + _unitTransform.
    this._entities = null
    // Single-model overlay projectiles — in-flight weapon meshes
    // (missiles / rockets / bombs) the single-unit viewer draws on top
    // of its one unit.  Each entry is { model, transform:{x,y,z,
    // headingRad, pitchRad} }.  Null when none in flight.  Multi-entity
    // hosts (sandbox) render projectiles as ordinary entities and leave
    // this unset.
    this._overlayProjectiles = null
    // Frustum-cull toggle — runtime debug knob, exposed via the
    // Developer Tools / View menu so the user can A/B the culled vs
    // un-culled render to confirm visual parity.  Default lives in
    // ./performance.js so every perf knob is in one file.
    this.cullEnabled = DEFAULT_CULL_ENABLED
    // Per-frame frustum-cull bookkeeping.  Counts entities drawn vs
    // skipped on the camera frustum so the Renderer panel can show
    // "drew 12 / culled 38" and the user can verify culling is in
    // effect.  Reset at the top of draw() and read by the inspector
    // through getCullStats().  `shadowed` counts entities that ran
    // the shadow pass this frame (i.e. weren't shadow-LOD-skipped).
    this._cullStats = { drew: 0, culled: 0, total: 0, shadowed: 0, full: 0, mid: 0, far: 0 }
    // Shadow-LOD knobs.  When enabled, entities whose projected
    // bounding-sphere radius (in screen-space pixels) drops below
    // `shadowMinPx` skip the shadow pass — near units cast shadows,
    // far units don't, exactly the "zoom out → shadows fade away"
    // behaviour the user described.  Defaults + threshold live in
    // ./performance.js; hysteresis is applied via a per-entity
    // `_lodShadowOn` flag (LOD_HYSTERESIS-wide band).
    this.shadowLodEnabled = DEFAULT_SHADOW_LOD_ENABLED
    this.shadowMinPx = SHADOW_LOD_MIN_PX
    // Graphics Options shadow controls (global, user-driven):
    //   shadowsEnabled — master on/off; gates the whole shadow pass.
    //   shadowStrength — 0..1 darkness multiplier for the cast (ground)
    //                    + self shadows.
    //   selfShadow     — whether the unit shadows its own geometry (the
    //                    ground cast shadow is independent of this).
    // Defaults preserve the prior look (shadows on, full strength,
    // self-shadowing on).
    this.shadowsEnabled = true
    this.shadowStrength = 1.0
    this.selfShadow = true
    // Distance-LOD toggle for the MAIN pass — at mid tier an entity's
    // cosmetic pieces (flares, muzzles, exhausts; tagged with
    // `piece.lodHide` by the model loader) get skipped on the
    // geometry walk.  Off → every entity draws every piece regardless
    // of projected size (A/B verification).  Hysteresis from
    // performance.js's LOD_HYSTERESIS keeps tiers stable near the
    // boundary.  Independent from shadowLodEnabled: a unit can be in
    // Mid tier (no flares) and still cast a shadow.
    this.lodEnabled = true
    this._lightView = Mat4.create()
    this._lightProj = Mat4.create()
    this._lightSpace = Mat4.create()
    // Second-light matrices (twin-sun worlds).  Same role as the
    // first set, but driven by lightDir2.  Live alongside the
    // first set so #updateLightMatrices can fill both in one go.
    this._lightView2 = Mat4.create()
    this._lightProj2 = Mat4.create()
    this._lightSpace2 = Mat4.create()

    if (this.textureCache) this.textureCache.onAnyTextureReady = () => this.requestRedraw()

    // Kick off the terrain texture fetch eagerly — the user's first
    // sight of the scene should already have grass, not the
    // procedural fallback ground.
    if (this.groundMode === 'terrain') this.#loadTerrainTexture()
  }

  // init fetches every shader from shaders/ + links the GPU programs.
  // Must be awaited before the renderer is asked to draw a frame; the
  // caller wires this into open() before calling start().  Safe to
  // call more than once - subsequent calls return the same Promise so
  // multiple async callers can join on a single init.
  init() {
    if (this._initPromise) return this._initPromise
    this._initPromise = (async () => {
      // Fetch the editable world JSON in parallel with the shaders; both
      // resolve before the first frame.  loadWorlds() fills the preset maps
      // the constructor seeded with Greenworld, so all worlds are available
      // by the time the host applies an environment.
      const [sources] = await Promise.all([loadAllShaders(), loadWorlds()])
      // If an environment was selected against the synchronous seed before
      // the JSON arrived, re-apply it now that the full data is loaded.
      if (this._envKey && ENVIRONMENT_PRESETS[this._envKey]) {
        this.setEnvironment(this._envKey)
      }
      this.#initMainProgram(sources.main.vs, sources.main.fs)
      this.#initShadowProgram(sources.shadow.vs, sources.shadow.fs)
      this.#initSkyProgram(sources.sky.vs, sources.sky.fs)
      this.#initGroundProgram(sources.ground.vs, sources.ground.fs)
      this.#initWireProgram(sources.wire.vs, sources.wire.fs)
      this.#initParticlesProgram(sources.particles.vs, sources.particles.fs)
      this.#initSpritesProgram(sources.sprites.vs, sources.sprites.fs)
      this.#initImpostorProgram(sources.impostor.vs, sources.impostor.fs)
      if (this._depthExt) {
        this.#initShadowFBO()
        // DoF needs the same depth-texture extension as shadows -
        // when missing, the renderer skips the post-process pass
        // entirely.
        this.#initDoFProgram(sources.dof.vs, sources.dof.fs)
        this.#initFxaaProgram(sources.fxaa.vs, sources.fxaa.fs)
        this.#initBloomPrograms(sources.bloomBright, sources.bloomBlur)
      }
      this._programsReady = true
      this.requestRedraw()
    })()
    return this._initPromise
  }

  setModel(model) {
    this.model = model
  }

  // setCobBinding attaches a binding to this renderer.  Two modes:
  //
  //  - driveTick: true  (default, single-renderer hosts) — the draw
  //    loop calls binding.tick(dtMs) before each frame so script
  //    animators run, the runtime advances, and per-piece state
  //    lands in the model before geometry is drawn.  This is the
  //    legacy behaviour every existing caller depends on.
  //  - driveTick: false — the host owns the tick (e.g. a tab-owned
  //    rAF loop calling binding.tick directly).  The renderer still
  //    reads binding.particles for the SFX pass + binding.getSceneLight
  //    for the dynamic light slot, but does NOT advance the binding.
  //    Used by multi-pane unit-editor tabs since Phase 4: the primary
  //    pane's renderer would double-tick the runtime if it both drove
  //    the binding AND the tab kicked the binding from its own loop.
  setCobBinding(binding, { driveTick = true } = {}) {
    this.cobBinding = binding || null
    this._cobBindingDriveTick = !!driveTick
    // Forward the binding's particle pool to the renderer's SFX
    // pass.  Detaching the binding also detaches the pool so the
    // old unit's particles don't keep drawing.
    this.setParticlePool(binding ? binding.particles : null)
    // Force a redraw on attach so static scripts (Create) get
    // their initial piece transforms applied immediately.  We only
    // fire the seed-tick when we own the tick; host-driven hosts
    // are expected to call binding.tick(0) themselves on attach.
    if (binding && this._cobBindingDriveTick) binding.tick(0)
    this.requestRedraw()
  }

  setCamera(camera) {
    this.camera = camera
  }

  setAutoRotate(on) {
    this.autoRotate = !!on
  }

  // setPulseLights pushes up to MAX_PULSE_LIGHTS dynamic point lights into the
  // next main + ground + reflection passes.  `lights` is an array of
  // { pos:[x,y,z], color:[r,g,b], strength } — over-1 colour values are fine
  // (the contribution is additive and tone-mapped post-lighting); strength is
  // the WORLD-unit radius at which intensity falls to ~50%.  Several lights at
  // once means concurrent weapon SFX each cast their own glow rather than only
  // the strongest.  Pass an empty array to clear and let the shaders skip the
  // path.  Called per-frame by the host view from the scene's live
  // light-emitting particles.
  setPulseLights(lights) {
    const out = []
    if (Array.isArray(lights)) {
      for (const l of lights) {
        if (!l || !l.pos || !l.color || !(l.strength > 0)) continue
        out.push({ pos: l.pos, color: l.color, range: l.strength })
        if (out.length >= MAX_PULSE_LIGHTS) break
      }
    }
    this._pulseLights = out
  }

  // setPulseLight is the legacy single-slot entry point, kept so callers that
  // still resolve one light (the per-binding renderer path) keep working.  It
  // delegates to the multi-light store.
  setPulseLight(pos, color, range) {
    if (!pos || !color || !(range > 0)) {
      this._pulseLights = []
    } else {
      this._pulseLights = [{ pos, color, range }]
    }
  }

  // setMaxDynamicLights sets the live cap on simultaneous dynamic lights from
  // the "Dynamic Lights" graphics option (0..MAX_PULSE_LIGHTS).  The cap is
  // enforced by the shared scene-lights collector — routing it there keeps
  // every render path (sandbox, multi-unit engine, single-binding viewer) in
  // agreement — and a renderer-side copy clamps the per-frame upload as a
  // defensive backstop.
  setMaxDynamicLights(n) {
    const v = Math.max(0, Math.min(MAX_PULSE_LIGHTS, Math.floor(n) || 0))
    this._maxPulseLights = v
    setMaxSceneLights(v)
  }

  // #uploadPulseLights flattens the active dynamic lights into the scratch
  // uniform arrays and uploads them to the bound program's pulse-light
  // uniforms.  Only the active count is filled + uploaded (uPulseLightCount
  // tells the shader where to stop), so a low slider value costs the GPU
  // nothing past that count even though the arrays are sized for the worst
  // case.  A null location (program without the uniform) is a no-op.  Shared by
  // the main, reflection and ground passes.
  #uploadPulseLights(gl, locPos, locColor, locRange, locCount) {
    if (!locPos && !locColor && !locRange && !locCount) return
    const lights = this._pulseLights || []
    const cap = Math.min(this._maxPulseLights ?? MAX_PULSE_LIGHTS, MAX_PULSE_LIGHTS)
    const n = Math.min(lights.length, cap)
    for (let i = 0; i < n; i++) {
      const l = lights[i]
      const base = i * 3
      _PULSE_POS[base] = l.pos[0]; _PULSE_POS[base + 1] = l.pos[1]; _PULSE_POS[base + 2] = l.pos[2]
      _PULSE_COLOR[base] = l.color[0]; _PULSE_COLOR[base + 1] = l.color[1]; _PULSE_COLOR[base + 2] = l.color[2]
      _PULSE_RANGE[i] = l.range
    }
    if (locCount) gl.uniform1i(locCount, n)
    if (n > 0) {
      if (locPos) gl.uniform3fv(locPos, _PULSE_POS.subarray(0, n * 3))
      if (locColor) gl.uniform3fv(locColor, _PULSE_COLOR.subarray(0, n * 3))
      if (locRange) gl.uniform1fv(locRange, _PULSE_RANGE.subarray(0, n))
    }
  }

  setRenderMode(mode) {
    if (['full', 'flat', 'wireframe'].includes(mode)) this.renderMode = mode
    this.requestRedraw()
  }

  setWireframeOverlay(on) {
    this.wireframeOverlay = !!on
    this.requestRedraw()
  }

  setWireframeWidth(px) {
    const n = Math.max(1, Math.min(6, parseInt(px, 10) || 1))
    this.wireframeWidth = n
    this.requestRedraw()
  }

  // setBuildPercent updates the nano-frame fade.  0 = pure green
  // pulsing wireframe (textures invisible), 100 = textured normal.
  // Below 100 we keep the render loop running so the pulse
  // animates continuously; at exactly 100 the existing redraw is
  // enough (the static textured model doesn't need a frame loop).
  setBuildPercent(percent) {
    this.buildPercent = Math.max(0, Math.min(100, +percent || 0))
    if (this.buildPercent < 100 && !this.running) this.start()
    this.requestRedraw()
  }

  setHoveredPieceName(name) {
    const next = (typeof name === 'string' && name) ? name.toLowerCase() : null
    if (next === this._hoveredPieceName) return
    this._hoveredPieceName = next
    this.requestRedraw()
  }

  // ── Per-piece rotation pose (studio "Rotate" dial) ───────────────────────
  // The Pieces tab opens a 3-axis dial on a piece; each axis writes an
  // ABSOLUTE rotation here.  Two channels are written so the pose shows
  // instantly AND survives:
  //   • piece.rotate[axis] — immediate visual feedback this frame (even when
  //     the runtime is paused and the binding isn't lerping).
  //   • the COB rotation animator (engine state, via setPieceRotationNowRad)
  //     — so the per-frame binding sync lands on the SAME value instead of
  //     lerping the piece back to its script pose ("snap back").  A later
  //     script TURN / SPIN still re-drives the axis, so the dial never fights
  //     scripting.
  // Angles are radians; the binding's per-axis sign flip (X/Y negated, Z
  // passthrough) is mirrored here so the direct write and the synced write
  // agree on direction.
  _pieceRotSign(axis) { return axis === 2 ? 1 : -1 }
  rotatePiece(name, axis, rad) {
    if (!this.model || !this.model.root || axis < 0 || axis > 2) return
    const piece = this.model.root.findByName(name)
    if (!piece) return
    piece.rotate[axis] = this._pieceRotSign(axis) * rad
    const unit = this.cobBinding && this.cobBinding.unit
    if (unit && typeof unit.setPieceRotationNowRad === 'function') {
      const idx = unit.pieceIndexByName(name)
      if (idx >= 0) unit.setPieceRotationNowRad(idx, axis, rad)
    }
    this.requestRedraw()
  }

  // getPieceRotation returns the piece's current [x, y, z] rotation in radians,
  // in TA game-unit convention (the value the dial maps onto 0-360°).  Reads
  // the engine animator when a COB is bound (the live pose a script may have
  // set), else the renderer's transient piece.rotate.
  getPieceRotation(name) {
    if (!this.model || !this.model.root) return [0, 0, 0]
    const unit = this.cobBinding && this.cobBinding.unit
    if (unit && typeof unit.pieceRotation === 'function') {
      const idx = unit.pieceIndexByName(name)
      if (idx >= 0) return unit.pieceRotation(idx)
    }
    const piece = this.model.root.findByName(name)
    if (!piece) return [0, 0, 0]
    return [
      piece.rotate[0] * this._pieceRotSign(0),
      piece.rotate[1] * this._pieceRotSign(1),
      piece.rotate[2] * this._pieceRotSign(2),
    ]
  }

  // setHoveredTexture flags every piece whose drawGroups reference
  // the given texture name for the red-wireframe overlay.  Pair
  // with a texture list in the host UI — the user hovers a texture
  // row and every face painted with that atlas lights up.  null
  // clears the highlight.
  setHoveredTexture(name) {
    const next = (typeof name === 'string' && name) ? name.toLowerCase() : null
    if (next === this._hoveredTexture) return
    this._hoveredTexture = next
    this.requestRedraw()
  }

  // setUnitTransform places the unit at (x, y, z) world units with
  // the given Y-axis heading.  Used by the Controls panel's Move
  // action to walk the unit toward a clicked target, and by the
  // flight scheduler to raise aircraft above the ground while in
  // motion.  Values are written into _modelMatrix at the start of
  // every frame; persists across ticks so the move-loop only needs
  // to update on motion change.  The legacy 3-arg signature
  // (x, z, headingRad) is still accepted for callers that don't
  // care about altitude.
  setUnitTransform(x, yOrZ, zOrHeading, headingRad) {
    if (headingRad === undefined) {
      // Legacy 3-arg form: (x, z, headingRad).  Altitude stays 0.
      this._unitTransform.x = +x || 0
      this._unitTransform.y = 0
      this._unitTransform.z = +yOrZ || 0
      this._unitTransform.headingRad = +zOrHeading || 0
    } else {
      this._unitTransform.x = +x || 0
      this._unitTransform.y = +yOrZ || 0
      this._unitTransform.z = +zOrHeading || 0
      this._unitTransform.headingRad = +headingRad || 0
    }
    this.requestRedraw()
  }

  // setUnitLocomotion installs the FBI-derived movement flavour for the
  // single-unit pose overlay: { hover, aircraft, bankScale, pitchScale }.
  // The renderer derives turn-rate + speed from the per-frame transform
  // stream and turns them into bank / pitch / wobble in _updateUnitOrientation
  // below.  Pass null (or a non-unit) to clear it.  Resets the smoothed state
  // so a freshly-loaded unit never inherits the previous one's lean.
  setUnitLocomotion(desc) {
    const d = desc || {}
    this._loco = {
      hover: !!d.hover,
      aircraft: !!d.aircraft,
      bankScale: (d.bankScale > 0) ? d.bankScale : 0,
      pitchScale: (d.pitchScale > 0) ? d.pitchScale : 0,
    }
    this._locoState.pitch = 0
    this._locoState.roll = 0
    this._locoState.heave = 0
    this._locoState.prevSpeed = undefined
    this._locoState.init = false
    // Hovercraft gyrate even at rest, so keep the continuous render loop
    // alive (otherwise an idle hovercraft on dry ground would only redraw
    // on demand and the wobble would freeze).  Idempotent; aircraft don't
    // need this (they sit level until they actually fly).
    if (this._loco.hover) this.start()
    else this.requestRedraw()
  }

  // _computeOrientation derives the pose overlay for ONE unit from the change
  // in its transform since the last frame, easing the result into `st`
  // (st.pitch / st.roll / st.heave):
  //   * aircraft — roll INTO the turn (turn-rate × FBI BankScale ×
  //     AIRCRAFT_BANK_SCALE) and pitch the nose up/down with climb/descent;
  //   * hovercraft — a continuous multi-frequency gyration (× the tunable
  //     HOVERCRAFT_WOBBLE_SCALE) that grows with ground speed, plus a light
  //     bank into turns, so it visibly floats on its cushion even at rest.
  // `st` carries both the previous transform and the smoothed overlay, so the
  // single unit and each sandbox entity can keep independent state.  Time is
  // the pausable, speed-scaled fx clock so the wobble freezes on pause and
  // scales with the Runtime Speed slider.
  _computeOrientation(loco, st, ut, t) {
    if (!loco.hover && !loco.aircraft) { st.pitch = 0; st.roll = 0; st.heave = 0; return st }
    if (!st.init) {
      st.init = true
      st.heading = ut.headingRad; st.x = ut.x; st.z = ut.z; st.y = ut.y; st.t = t
    }
    const dt = t - st.t
    let turnRate = 0, speed = 0, climb = 0
    if (dt > 1e-4) {
      let dh = ut.headingRad - st.heading
      while (dh > Math.PI) dh -= Math.PI * 2
      while (dh < -Math.PI) dh += Math.PI * 2
      turnRate = dh / dt
      speed = Math.hypot(ut.x - st.x, ut.z - st.z) / dt
      climb = (ut.y - st.y) / dt
      st.heading = ut.headingRad; st.x = ut.x; st.z = ut.z; st.y = ut.y; st.t = t
    }
    // Exponential smoothing factor — quick enough to feel responsive, slow
    // enough to hide the per-frame jitter in the derived turn rate.
    const k = dt > 1e-4 ? (1 - Math.exp(-dt / 0.18)) : 0
    let targetPitch = 0, targetRoll = 0, targetHeave = 0
    if (loco.aircraft) {
      // Bank: lean INTO the turn.  +turnRate rolls the inside wing down for a
      // right turn (the sign was inverted before — banking the wrong way).
      // Magnitude = turn rate × FBI BankScale × the global AIRCRAFT_BANK_SCALE.
      const maxBank = 1.0
      targetRoll = Math.max(-maxBank, Math.min(maxBank,
        turnRate * 0.45 * (loco.bankScale || 1) * AIRCRAFT_BANK_SCALE))
      // Pitch: nose up while climbing, down while descending (× PitchScale).
      const maxPitch = 0.35
      targetPitch = Math.max(-maxPitch, Math.min(maxPitch, (climb / 60) * 0.3 * (loco.pitchScale || 1)))
    }
    if (loco.hover) {
      // Continuous gyration on the air cushion.  Two incommensurate
      // frequencies per axis so it never reads as a clean loop; heave is a
      // gentle vertical breathe.  Scaled by the tunable HOVERCRAFT_WOBBLE_SCALE.
      //
      // The at-rest baseline is cut ~40% from the old constant so a parked
      // hovercraft barely shivers; the bulk of the wobble now rides a "motion"
      // factor that blends ground speed with the magnitude of acceleration, so
      // a craft surging under throttle or braking gyrates harder than one
      // idling, and a slow craft wobbles less than a fast one.
      const spd = Math.min(1, speed / 40)
      let accelMag = 0
      if (dt > 1e-4) {
        const prevSpeed = (st.prevSpeed !== undefined) ? st.prevSpeed : speed
        accelMag = Math.min(1, Math.abs(speed - prevSpeed) / dt / 80)
        st.prevSpeed = speed
      }
      const motion = Math.min(1, spd + 0.4 * accelMag)
      const amp = (0.027 + 0.075 * motion) * HOVERCRAFT_WOBBLE_SCALE
      targetPitch += amp * (Math.sin(t * 1.7) * 0.6 + Math.sin(t * 0.9 + 1.3) * 0.4)
      targetRoll  += amp * (Math.sin(t * 1.3 + 0.7) * 0.6 + Math.sin(t * 2.1) * 0.4)
      targetHeave += (0.48 + 1.3 * motion) * HOVERCRAFT_WOBBLE_SCALE * Math.sin(t * 1.1)
      // Light bank into turns on top of the idle wobble (same sign as above).
      targetRoll  += Math.max(-0.3, Math.min(0.3, turnRate * 0.18))
      // The hover gyration is procedural (already smooth), so chase it fast.
      st.pitch += (targetPitch - st.pitch) * Math.max(k, 0.4)
      st.roll  += (targetRoll  - st.roll)  * Math.max(k, 0.4)
      st.heave += (targetHeave - st.heave) * Math.max(k, 0.4)
      return st
    }
    st.pitch += (targetPitch - st.pitch) * k
    st.roll  += (targetRoll  - st.roll)  * k
    st.heave += (targetHeave - st.heave) * k
    return st
  }

  // _locoForMeta builds the overlay descriptor for a sandbox entity from its
  // FBI meta (mirrors the single-unit descriptor set via setUnitLocomotion).
  _locoForMeta(meta) {
    if (!meta) return null
    if (!meta.isHovercraft && !meta.isAircraft) return null
    return {
      hover: !!meta.isHovercraft,
      aircraft: !!meta.isAircraft,
      bankScale: (meta.bankScale > 0) ? meta.bankScale : 0,
      pitchScale: (meta.pitchScale > 0) ? meta.pitchScale : 0,
    }
  }

  // unitWorldXZ returns the unit's current world XZ position.  The
  // aim+fire scheduler uses this to compute the vector from unit
  // origin to target so its heading/pitch math is in the same
  // coordinate space the renderer translates by.
  unitWorldXZ() { return [this._unitTransform.x, this._unitTransform.z] }
  unitWorldY() { return this._unitTransform.y }
  unitHeading() { return this._unitTransform.headingRad }

  // getUnitOrientation returns the live pose overlay {pitch, roll, heave}
  // currently being applied to a unit's model matrix.  Used by the Movement
  // panel so the cockpit attitude indicator reflects aircraft banking,
  // hovercraft wobble, and (single-unit mode only) the sea-bob sway of a
  // ship.  All angles in radians.  Returns an all-zero overlay when no
  // overlay applies to the unit — the panel can still render a level
  // horizon for ground units.
  //
  //   unitId == null → single-unit mode (unit editor): combines _locoState
  //     plus the sea-bob sample at the model's centre.
  //   unitId != null → multi-entity mode (sandbox): returns the entity's
  //     _entOrient overlay only.  Entities don't sea-bob today (see the
  //     gate around _applySeaBob in draw()), so the panel matches the
  //     renderer's actual visual behaviour.
  getUnitOrientation(unitId) {
    let pitch = 0, roll = 0, heave = 0
    if (unitId == null) {
      // Single-unit (unit editor) — locomotion overlay if a hover/aircraft
      // descriptor is installed, plus the sea bob when groundMode is 'sea'.
      if (this._loco && (this._loco.hover || this._loco.aircraft)) {
        pitch += this._locoState.pitch
        roll  += this._locoState.roll
        heave += this._locoState.heave
      }
      if (this.groundMode === 'sea' && this.optBob && this.model) {
        const cx = (this.model.bounds.min[0] + this.model.bounds.max[0]) * 0.5
        const cz = (this.model.bounds.min[2] + this.model.bounds.max[2]) * 0.5
        const tSlow = this._fxTimeSec() * 0.75 * this.bobSpeed
        const s = this.seaWaveSample(cx, cz, tSlow)
        const BOB_SCALE = 0.30 * this.bobAmount
        const tilt = 0.55 * BOB_SCALE
        pitch += Math.atan2(s.dhz, 1) * tilt
        roll  += -Math.atan2(s.dhx, 1) * tilt
        heave += s.h * BOB_SCALE
      }
    } else {
      const est = this._entOrient.get(unitId)
      if (est) { pitch += est.pitch; roll += est.roll; heave += est.heave }
    }
    return { pitch, roll, heave }
  }

  // setEntities switches the renderer into multi-entity mode.  When
  // entities are present, draw() draws each entity's model after the
  // shared sky / ground pass instead of the single `this.model`.
  // Pass null to return to single-unit mode.  Each entity:
  //   { model, transform: {x, y, z, headingRad},
  //     particles?, buildPercent?, selected?, teamColor? }
  setEntities(entitiesArr) {
    this._entities = (Array.isArray(entitiesArr) && entitiesArr.length > 0) ? entitiesArr : null
    this.requestRedraw()
  }

  // setOverlayProjectiles feeds the single-unit viewer the in-flight
  // projectile meshes to draw on top of its one unit (the sandbox draws
  // these as ordinary entities instead).  Each entry is
  //   { model, transform: {x, y, z, headingRad, pitchRad} }.
  // Pass null / empty when nothing is in flight.
  setOverlayProjectiles(arr) {
    this._overlayProjectiles = (Array.isArray(arr) && arr.length > 0) ? arr : null
    this.requestRedraw()
  }

  // setCullEnabled — runtime toggle for the frustum cull.  Off →
  // every entity draws regardless of camera frustum (the old behaviour,
  // useful for A/B verifying visual parity).  On (default) → entities
  // outside the camera frustum skip their main pass and shadow pass.
  setCullEnabled(on) {
    this.cullEnabled = !!on
    this.requestRedraw()
  }

  // setShadowLodEnabled — runtime toggle for distance-based shadow
  // culling.  When on (default), entities whose projected size on
  // screen drops below shadowMinPx skip the shadow pass — zoom-out
  // gradually thins out the shadow-caster set so the GPU isn't
  // re-rasterising a hundred barely-visible silhouettes every frame.
  setShadowLodEnabled(on) {
    this.shadowLodEnabled = !!on
    this.requestRedraw()
  }

  // setShadowsEnabled — Graphics Options master shadow toggle.  Off
  // skips the shadow depth pass entirely (no self + no cast shadows)
  // and forces uShadowEnabled to 0 in both the unit + ground shaders.
  setShadowsEnabled(on) {
    this.shadowsEnabled = !!on
    this.requestRedraw()
  }

  // setShadowStrength — 0..1 darkness of the cast + self shadows.  1 =
  // full (prior look), 0 = invisible (equivalent to off, but the pass
  // still runs).  Clamped.
  setShadowStrength(v) {
    const n = +v
    this.shadowStrength = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
    this.requestRedraw()
  }

  // setSelfShadow — whether the unit shadows its own geometry.  Off
  // lights the unit as if it never occludes itself; the cast shadow on
  // the ground (ground shader) is unaffected.
  setSelfShadow(on) {
    this.selfShadow = !!on
    this.requestRedraw()
  }

  // setLodEnabled — runtime toggle for the main-pass LOD tier
  // classifier.  Off → every entity renders in Full tier (every
  // piece, every draw group) regardless of projected size.  On
  // (default) → entities below TIER_FULL_MIN_PX skip cosmetic
  // (lodHide) pieces; below TIER_MID_MIN_PX they collapse further
  // (currently a no-op; Phase 3 will replace them with impostors).
  setLodEnabled(on) {
    this.lodEnabled = !!on
    this.requestRedraw()
  }

  // getCullStats returns the most recent frame's cull breakdown for
  // the Renderer overlay.  Snapshot — counters are reset at the top
  // of the next draw() call.
  getCullStats() { return this._cullStats }

  // _pxRadius — returns the projected screen-space radius of an
  // entity's bounding sphere in CSS pixels.  Uses the cached
  // halfFovTan from OrbitCamera.updateMatrices so the per-frame cost
  // is one sqrt + two divides.  Returns +Infinity when the camera is
  // inside the sphere (treat as max-detail), 0 when the model has no
  // bounds yet (treat as max-detail so the shadow LOD doesn't pop a
  // freshly-loaded unit's shadow off until the next frame).
  _pxRadius(ent) {
    if (!ent || !ent.model) return 0
    const m = ent.model
    const r = m.boundsRadius
    if (!(r > 0)) return 0
    const t = ent.transform || _IDENTITY_T
    const cx = t.x + (m.boundsCentre ? m.boundsCentre[0] : 0)
    const cy = t.y + (m.boundsCentre ? m.boundsCentre[1] : 0)
    const cz = t.z + (m.boundsCentre ? m.boundsCentre[2] : 0)
    const dx = cx - this.camera.eye[0]
    const dy = cy - this.camera.eye[1]
    const dz = cz - this.camera.eye[2]
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist <= r) return Infinity
    const halfH = this.gl.drawingBufferHeight * 0.5
    const hft = this.camera.halfFovTan || Math.tan(35 * Math.PI / 180 * 0.5)
    return (r / dist) * (halfH / hft)
  }

  // _castsShadow — distance-based shadow LOD with hysteresis.  Decides
  // whether `ent` runs the shadow pass this frame.  When shadow LOD
  // is off, always true (every entity casts).  Otherwise the entity
  // flips ON above shadowMinPx and OFF below shadowMinPx/LOD_HYSTERESIS
  // — the band prevents flicker at the boundary.  Ghost / selected
  // entities always cast (UI consistency: a selected unit should
  // always show its shadow as part of the user's focus).
  _castsShadow(ent) {
    // Helper: pin _lodShadowOn so the lighting-LOD gate
    // (cheap = _lodShadowOn === false) always reads a meaningful
    // value, never a stale or undefined one from a previous frame.
    if (!this.shadowLodEnabled) { if (ent) ent._lodShadowOn = true;  return true }
    if (!ent || !ent.model)     { return true }
    if (ent.ghost)              { ent._lodShadowOn = true; return true }
    // NOTE: selected entities follow the regular pixel-radius
    // rule — a selected unit that's too far for geometry (and
    // renders as a flickering impostor dot) shouldn't be the
    // single thing on the map casting a shadow.  The selection
    // is communicated by the dot itself.
    const px = this._pxRadius(ent)
    const prev = ent._lodShadowOn !== false  // default ON when undefined
    // Projectiles get the same multiplier as the main-pass tiers, so a
    // bomb's shadow doesn't disappear right after release — the silhouette
    // on the ground is what makes a bomb-run readable.
    const mult = ent.isProjectile ? (PROJECTILE_LOD_MULTIPLIER || 1) : 1
    const shadowPx = this.shadowMinPx / mult
    let next
    if (prev) {
      // Currently casting — only drop when comfortably below the
      // threshold so a unit hovering near the boundary doesn't
      // flicker its shadow on/off.
      next = px >= (shadowPx / LOD_HYSTERESIS)
    } else {
      // Not casting — only enter when comfortably above so we don't
      // re-enter from the same border.
      next = px >= shadowPx
    }
    ent._lodShadowOn = next
    return next
  }

  // _pickLodTier — classify an entity into LOD_TIER_FULL / _MID / _FAR
  // for the main pass.  Same hysteresis pattern as _castsShadow:
  // entering a denser tier requires crossing the threshold by
  // LOD_HYSTERESIS; leaving back to a sparser tier requires crossing
  // by the same factor on the way out.  Per-entity state in
  // `_lodTier` carries between frames so the band actually applies.
  //
  // Tier semantics:
  //   FULL — geometry walk includes every piece (incl. lodHide-tagged
  //     cosmetic pieces); shaders run at full quality.
  //   MID  — skips piece.lodHide pieces.  Currently the only visible
  //     change; Phase 2's shader changes (no specular / no rim) will
  //     hang off this tier in a follow-up.
  //   FAR  — currently identical to MID; Phase 3 will swap in the
  //     impostor-batch path here.
  //
  // Ghost entities are always Full (placement preview must stay
  // legible).  Selected entities classify normally — when they
  // fall to Far tier they render as a flickering impostor instead
  // of a full geometry walk, so the user sees the selection at a
  // glance without paying the per-piece cost of a unit they can
  // barely see.  When the LOD toggle is off, every entity is Full
  // and the classifier is a no-op.
  _pickLodTier(ent) {
    if (!this.lodEnabled) return LOD_TIER_FULL
    if (!ent || !ent.model) return LOD_TIER_FULL
    if (ent.ghost) return LOD_TIER_FULL
    const px = this._pxRadius(ent)
    const prev = ent._lodTier != null ? ent._lodTier : LOD_TIER_FULL
    // In-flight model projectiles (bombs, missiles, rockets) have tiny
    // bounding spheres compared to their host unit, so by the unit-tier
    // thresholds they pop down to the impostor dot long before they reach
    // their target — the bomb appears to "vanish" mid-air.  Divide both
    // tier thresholds by performance.js's PROJECTILE_LOD_MULTIPLIER for
    // these so they stay drawn at the same on-screen size band as units.
    const mult = ent.isProjectile ? (PROJECTILE_LOD_MULTIPLIER || 1) : 1
    const fullPx = TIER_FULL_MIN_PX / mult
    const midPx  = TIER_MID_MIN_PX  / mult
    // Symmetric hysteresis around each threshold:
    //   enter denser tier at threshold × HYST    (going up)
    //   exit  to sparser tier at threshold / HYST (going down)
    const fullEnter = fullPx * LOD_HYSTERESIS
    const fullExit  = fullPx / LOD_HYSTERESIS
    const midEnter  = midPx  * LOD_HYSTERESIS
    const midExit   = midPx  / LOD_HYSTERESIS
    let next
    if (prev === LOD_TIER_FULL) {
      // Stay Full unless we fall below the exit threshold.
      next = px >= fullExit ? LOD_TIER_FULL
           : px >= midEnter ? LOD_TIER_MID
           : LOD_TIER_FAR
    } else if (prev === LOD_TIER_MID) {
      // Promote back to Full if comfortably above; drop to Far if
      // comfortably below.
      next = px >= fullEnter ? LOD_TIER_FULL
           : px >= midExit   ? LOD_TIER_MID
           : LOD_TIER_FAR
    } else {
      next = px >= fullEnter ? LOD_TIER_FULL
           : px >= midEnter  ? LOD_TIER_MID
           : LOD_TIER_FAR
    }
    ent._lodTier = next
    return next
  }

  // _entityVisible — Phase 1 frustum cull.  Returns true when the
  // entity's world-space bounding sphere intersects the camera
  // frustum (so the renderer needs to issue draw calls for it),
  // false when the sphere is entirely behind one of the six planes
  // (skippable).  Special cases:
  //   - cullEnabled === false      → always visible (debug toggle).
  //   - ghost / selected entities  → always visible (UI / placement
  //                                  preview must render even off-
  //                                  centre of the camera framing).
  //   - missing model bounds       → always visible (defensive — a
  //                                  loader race could leave bounds
  //                                  null on the very first frame).
  // Callers also bump `_cullStats` so the Renderer panel can show
  // the drew / culled split per frame.
  _entityVisible(ent) {
    if (!this.cullEnabled) return true
    if (!ent || !ent.model) return true
    if (ent.ghost || ent.selected) return true
    const m = ent.model
    if (!m.boundsCentre || !(m.boundsRadius > 0)) return true
    const t = ent.transform || _IDENTITY_T
    // Object → world translation only — the bounding sphere is
    // rotation-invariant, so heading + sea-bob don't affect the
    // centre+radius test.  Sea-bob can lift the sphere by ~5 wu;
    // pad the radius slightly to absorb it.
    const cx = t.x + m.boundsCentre[0]
    const cy = t.y + m.boundsCentre[1]
    const cz = t.z + m.boundsCentre[2]
    const r = m.boundsRadius + CULL_RADIUS_PADDING_WU  // padding for sea-bob / heading wobble
    return this.camera.sphereInFrustum(cx, cy, cz, r)
  }

  // worldToCanvas projects a world-space (x, y, z) point onto the
  // canvas's CSS pixel grid using the camera's live VP matrix.  The
  // caller adds the canvas's bounding-rect offset to get viewport
  // coordinates suitable for a position:fixed overlay.  Returns null
  // when the point is behind the near plane (w <= 0) so the overlay
  // can be hidden in that case rather than drawn off-screen with a
  // post-divide NaN.
  worldToCanvas(world) {
    if (!this.camera) return null
    const c = this.camera
    const x = world[0], y = world[1], z = world[2]
    // Apply view × proj manually so we can read the w component
    // before the homogeneous divide.  proj * view * p = clip.
    const view = c.viewMatrix, proj = c.projMatrix
    // view * (x,y,z,1)
    const vx = view[0]*x + view[4]*y + view[8] *z + view[12]
    const vy = view[1]*x + view[5]*y + view[9] *z + view[13]
    const vz = view[2]*x + view[6]*y + view[10]*z + view[14]
    const vw = view[3]*x + view[7]*y + view[11]*z + view[15]
    // proj * view * p
    const cx = proj[0]*vx + proj[4]*vy + proj[8] *vz + proj[12]*vw
    const cy = proj[1]*vx + proj[5]*vy + proj[9] *vz + proj[13]*vw
    /*const cz = proj[2]*vx + proj[6]*vy + proj[10]*vz + proj[14]*vw*/
    const cw = proj[3]*vx + proj[7]*vy + proj[11]*vz + proj[15]*vw
    if (cw <= 1e-6) return null // behind camera or at the eye
    const ndcX = cx / cw
    const ndcY = cy / cw
    // CSS pixels (canvas-local).  Y flipped because NDC Y is up but
    // CSS Y is down.
    const w = this.canvas?.clientWidth || this.gl.drawingBufferWidth
    const h = this.canvas?.clientHeight || this.gl.drawingBufferHeight
    return {
      x: (ndcX * 0.5 + 0.5) * w,
      y: (1 - (ndcY * 0.5 + 0.5)) * h,
    }
  }

  // canvasToGroundPoint translates a viewport pixel (canvas-local)
  // into the world-space ground-plane (Y=0) point under that pixel.
  // Returns null when the ray misses the plane (e.g. user clicked
  // the sky above the horizon).  Used by the Controls panel to
  // resolve a click into a move/aim target.
  canvasToGroundPoint(cx, cy) {
    if (!this.camera) return null
    const w = this.gl.drawingBufferWidth
    const h = this.gl.drawingBufferHeight
    // Normalised device coordinates [-1, 1].
    const ndcX = (cx / Math.max(1, w)) * 2 - 1
    const ndcY = 1 - (cy / Math.max(1, h)) * 2
    const c = this.camera
    // Reuse the camera's live proj+view matrices — they're already
    // synced by the per-frame update so they match what the user
    // actually sees on screen.  Combine into a VP, then invert to
    // unproject NDC back into world coords.  Mat4.invert returns
    // null on a singular matrix (degenerate camera state).
    const vp = Mat4.create()
    Mat4.multiply(vp, c.projMatrix, c.viewMatrix)
    const inv = Mat4.create()
    if (!Mat4.invert(inv, vp)) return null
    // Unproject NDC at the near + far depth, then intersect the ray
    // (eye → far point) with the y=0 ground plane.  Inline 4-vector
    // multiplication keeps this self-contained (mat4.js has no
    // transformPoint helper).
    const unproject = (nx, ny, nz) => {
      const w = inv[3] * nx + inv[7] * ny + inv[11] * nz + inv[15]
      if (Math.abs(w) < 1e-9) return null
      return [
        (inv[0] * nx + inv[4] * ny + inv[8]  * nz + inv[12]) / w,
        (inv[1] * nx + inv[5] * ny + inv[9]  * nz + inv[13]) / w,
        (inv[2] * nx + inv[6] * ny + inv[10] * nz + inv[14]) / w,
      ]
    }
    const nearP = unproject(ndcX, ndcY, -1)
    const farP  = unproject(ndcX, ndcY,  1)
    if (!nearP || !farP) return null
    // Intersection plane Y — for sea ground mode we want the water
    // surface, not y=0 (which sits well below the visible water
    // and would map a click "on the boat" to a far-distant point).
    // Other ground modes (terrain / grid / off) use y=0.
    const planeY = (this.groundMode === 'sea') ? this._getWaterY() : 0
    const dy = farP[1] - nearP[1]
    if (Math.abs(dy) < 1e-6) return null
    const t = (planeY - nearP[1]) / dy
    if (t < 0) return null
    return [
      nearP[0] + (farP[0] - nearP[0]) * t,
      planeY,
      nearP[2] + (farP[2] - nearP[2]) * t,
    ]
  }

  setGroundMode(mode) {
    if (!['grid', 'terrain', 'sea', 'off'].includes(mode)) return
    this.groundMode = mode
    if (mode === 'terrain' && !this._terrainTex) this.#loadTerrainTexture()
    // Sea mode wants the renderer ticking every frame so its time
    // uniform advances the wave animation even when auto-rotate is
    // off.  Start the RAF loop if it isn't already running.
    if (mode === 'sea' && !this.running) this.start()
    this.requestRedraw()
  }

  // setSkyScheme swaps the skybox preset.  Accepts a preset name
  // (key of SKY_PRESETS) or a fully-formed scheme object — the
  // latter lets callers script bespoke skies without touching the
  // preset table.  Falls back silently to the current scheme if the
  // name isn't recognised.
  setSkyScheme(nameOrScheme) {
    if (typeof nameOrScheme === 'string') {
      const preset = SKY_PRESETS[nameOrScheme]
      if (!preset) return
      this.skyScheme = preset
    } else if (nameOrScheme && nameOrScheme.zenith) {
      this.skyScheme = nameOrScheme
    }
    this.requestRedraw()
  }

  // skyPresets exposes the available named presets to the UI so the
  // host (Studio) can populate a picker without re-importing them.
  static get skyPresets() { return SKY_PRESETS }

  // setEnvironment swaps the whole world look (sky scheme + terrain
  // tileset + scene light direction + water hints) from one of the
  // ENVIRONMENT_PRESETS.  The Studio Options UI calls this when the
  // user picks Mars / Lava / etc.; passing a custom object also
  // works for scripted scenes.
  // reapplyTextureHints — recompute every draw group's material-hint
  // fields (specular / running-lights / bump) from the hints table, which
  // now includes any live session overrides set from the Textures panel,
  // then redraw.  Lets the user tweak a tile's parameters and see the
  // change instantly without reloading the model.
  reapplyTextureHints() {
    if (!this.model || !this.model.root) return
    const visit = (p) => {
      if (!p) return
      for (const g of (p.drawGroups || [])) {
        applyResolvedHints(g, g.textureName || g.texture)
      }
      for (const c of (p.children || [])) visit(c)
    }
    visit(this.model.root)
    this.requestRedraw()
  }

  setEnvironment(nameOrPreset) {
    let env
    let envKey = null
    if (typeof nameOrPreset === 'string') {
      env = ENVIRONMENT_PRESETS[nameOrPreset]
      if (!env) return
      envKey = nameOrPreset
    } else if (nameOrPreset && nameOrPreset.sky) {
      env = nameOrPreset
    } else {
      return
    }
    // Cache the active env so the sea shader can pull water tints
    // from it each frame.  See #renderGround.
    this.activeEnvironment = env
    // Track the environment key separately — gravity lookups go
    // through this rather than the preset object so the ballistic
    // aim solver can be redirected to a different world's gravity
    // without rebuilding the entire env (useful for a future
    // "gravity slider" debug control too).
    this._envKey = envKey
    this.setSkyScheme(env.sky)
    if (env.lightDir) this.lightDir = ModelRenderer.#normalise(env.lightDir)
    // Primary key-light colour comes from the world now (each world JSON
    // carries its own sun tint), so picking Mars / Lava / Night actually
    // re-tints the units + scenery — warm amber, hot orange, dim moonlight
    // — instead of every world reusing one neutral daylight.
    if (env.lightColor) this.lightColor = env.lightColor.slice()
    // Pull sun2 from the active sky scheme so the scene-lighting
    // pass casts a shadow from it too (single suns leave it at
    // zero colour, in which case the shadow pass is skipped).
    const sky = this.skyScheme || {}
    const sun2 = sky.sun2 || { color: [0, 0, 0] }
    const sun2Mag = sun2.color[0] + sun2.color[1] + sun2.color[2]
    if (sun2Mag > 0.001 && sun2.dir) {
      this.lightDir2 = ModelRenderer.#normalise(sun2.dir)
      // Dim the second light a bit so its shadow contribution
      // doesn't overpower the primary — twin-sun scenes still want
      // a clear primary key light, with the second adding texture.
      this.lightColor2 = [sun2.color[0] * 0.6, sun2.color[1] * 0.6, sun2.color[2] * 0.6]
    } else {
      this.lightColor2 = [0, 0, 0]
    }
    // Tileset switch: drop the cached terrain texture so the lazy
    // fetcher picks up the new tileset the next time Terrain mode is
    // active.  If the user is currently in Terrain mode, trigger the
    // fetch right away so the swap is instant.
    if (env.terrainTileset && env.terrainTileset !== this.terrainTileset) {
      this.terrainTileset = env.terrainTileset
      if (this._terrainTex) {
        this.gl.deleteTexture(this._terrainTex)
        this._terrainTex = null
        this._terrainReady = false
      }
      if (this.groundMode === 'terrain') this.#loadTerrainTexture()
    }
    this.requestRedraw()
  }

  static get environmentPresets() { return ENVIRONMENT_PRESETS }

  // ── Studio Options setters ──────────────────────────────────
  // Each flag drops its corresponding visual contribution.  The
  // shaders/passes read the flag via uniforms so flipping a toggle
  // takes effect on the next frame.
  // setSubmersionMode shifts the water plane so the unit reads as
  // sitting in the water at an appropriate depth.  Values:
  //   'surface'   — ship; water covers the bottom ~15% of the hull
  //   'submerged' — sub; entire unit ~2 wu below water surface
  //   ''          — no shift; unit sits ON the water
  // The shift is achieved by raising the water plane (uGroundY) for
  // the sea pass instead of moving the unit, so the bob math, the
  // seabed Y, and the reflection mirror all stay in sync via the
  // same _getWaterY().
  setSubmersionMode(mode) {
    this.submersionMode = mode || ''
    this.requestRedraw()
  }

  // getGravity returns the world gravity in wu/sec² for the active
  // environment, used by the ballistic aim solver to set barrel
  // pitch on cannon-class weapons.  Switching to a lunar / mars
  // env lowers this value and the next aim cycle naturally elevates
  // the barrels further to compensate.  Defaults to Earth gravity
  // when the env name doesn't appear in the GRAVITY_BY_ENV table
  // (custom env objects, unknown keys).
  getGravity() {
    const k = this._envKey
    if (k && Object.prototype.hasOwnProperty.call(GRAVITY_BY_ENV, k)) {
      return GRAVITY_BY_ENV[k]
    }
    return GRAVITY_EARTH
  }

  // getUnitYOffset returns the world-Y translation to apply to the
  // unit model in Sea mode.  For submerged units (subs) the model
  // bounds are at the origin but the water plane is far above and
  // the seabed sits 45 wu below the water — without an offset, a
  // sub at bounds.min[1] = 0 would be buried inside the bed.  This
  // method lifts the unit so its TOP sits ~12 wu below the water
  // surface (periscope depth), guaranteeing clearance over the bed.
  // Surface ships and other modes return 0.  Exposed so the host
  // can also offset the camera target to keep framing locked on
  // the actually-rendered unit position.
  getUnitYOffset() {
    if (!this.model || this.submersionMode !== 'submerged') return 0
    const waterY = this._getWaterY()
    const height = Math.max(1, this.model.bounds.max[1] - this.model.bounds.min[1])
    const desiredTop = waterY - 12.0
    const desiredMin = desiredTop - height
    return desiredMin - this.model.bounds.min[1]
  }

  // _getWaterY returns the world Y of the water surface.  Centralised
  // here because every sea pass (ground, reflection, bob, main shader
  // uniform) needs the same value — drift between them would float
  // the unit off the wave or misposition the reflection mirror.
  _getWaterY() {
    if (!this.model) return 0
    const base = this.model.bounds.min[1] - 0.05
    const height = Math.max(1, this.model.bounds.max[1] - this.model.bounds.min[1])
    if (this.submersionMode === 'surface') {
      // Push water up by 15% of unit height so the boot-stripe area
      // lines up with the visible waterline on most TA hull textures.
      return base + height * 0.15
    }
    if (this.submersionMode === 'submerged') {
      // Push the water plane well above the unit so the orbit-
      // camera's default framing puts the eye below the surface —
      // the user opens a sub and is immediately looking at it
      // through metres of water above (periscope-cam feel).  The
      // camera's eye is ~target + distance*sin(pitch); for typical
      // units distance ≈ 1.5× span at pitch 18°, so the eye sits
      // about 0.5× span above the unit centroid.  Water at top +
      // 3× unit-height puts the surface a good margin above the
      // eye for any reasonable bounding box.
      return base + height + Math.max(height * 3.0, 40)
    }
    return base
  }

  // _fillColor returns the cinematic fill light tint — a cool, ~30% blue
  // tinge of the sky's ambient.  Cool fill against a warm key reads as
  // the classic 3-point film lighting (key=sun, fill=skylight bounce,
  // back=hot rim).  We pull from the active sky ambient so each
  // environment preset gets a fill that matches the world's mood (cold
  // arctic skylight vs warm sunset bounce).
  _fillColor() {
    const s = this.skyColor || [1, 1, 1]
    return [s[0] * 0.55, s[1] * 0.65, s[2] * 0.80]
  }

  // _backColor returns the back-light tint — warm, slightly hotter than
  // the key so the rim picks out the silhouette cleanly.  Mirrors the
  // active sun colour but with a 20% lift so it shows up even on
  // overcast presets where the sun colour itself is muted.
  _backColor() {
    const k = this.lightColor || [1, 1, 1]
    return [Math.min(1.2, k[0] * 1.2), Math.min(1.2, k[1] * 1.1), Math.min(1.2, k[2] * 0.95)]
  }

  // setTeamColor accepts either null (use original blue) or an [r,g,b]
  // triple in 0–1 linear space.  The shader compares the texture's hue
  // against the blue team-color range and rotates matching pixels to
  // the chosen team's hue.
  setTeamColor(rgb) {
    if (rgb == null) {
      this.teamColor = null
      this.teamColorEnable = false
    } else {
      this.teamColor = [rgb[0], rgb[1], rgb[2]]
      this.teamColorEnable = true
    }
    this.requestRedraw()
  }

  // setDoFEnabled turns the post-process depth-of-field pass on/off.
  // When off, the renderer skips the scene FBO entirely so the cost is
  // a single extra `if` per frame.
  setDoFEnabled(on) { this.optDof = !!on; this.requestRedraw() }

  // setDoFDistance sets the blur-onset distance as a multiplier of the
  // base (~25 wu) framing distance.  Higher = blur starts further out
  // (only the deep background softens); 1× matches the legacy onset.
  // Converts to the shader's window-depth focal plane via 1 - gap/m.
  setDoFDistance(mult) {
    const m = Math.max(0.2, Math.min(40, +mult || 1))
    this.dofDistanceMul = m
    this.dofFocalDepth = Math.max(0.9, Math.min(0.999995, 1 - DOF_BASE_GAP / m))
    this.requestRedraw()
  }

  // setDoFLevel scales the maximum blur radius.  1.0 == DOF_BASE_BLUR
  // (the legacy 8 px cap); 0 disables the blur without touching the
  // toggle, 2.0 doubles it for a heavier cinematic look.
  setDoFLevel(frac) {
    const f = Math.max(0, Math.min(4, +frac || 0))
    this.dofMaxBlur = DOF_BASE_BLUR * f
    this.requestRedraw()
  }

  // setCinematic toggles the ACES tonemap + colour grade + vignette +
  // FXAA post pass.  setCinematicStrength scales how far the grade
  // pushes from the raw image (0 = none, 1 = full).
  setCinematic(on) { this.optCinematic = !!on; this.requestRedraw() }
  setCinematicStrength(v) {
    this.cinematicStrength = Math.max(0, Math.min(1, +v || 0))
    this.requestRedraw()
  }

  // setBloomEnabled toggles the bright-pass glow; setBloomStrength
  // scales the additive bloom contribution.
  setBloomEnabled(on) { this.optBloom = !!on; this.requestRedraw() }
  setBloomStrength(v) {
    this.bloomStrength = Math.max(0, Math.min(4, +v || 0))
    this.requestRedraw()
  }

  // setLensFlareEnabled toggles the screen-space sun flare; strength
  // scales the glow + ghosts.
  setLensFlareEnabled(on) { this.optLensFlare = !!on; this.requestRedraw() }
  setLensFlareStrength(v) {
    this.lensFlareStrength = Math.max(0, Math.min(4, +v || 0))
    this.requestRedraw()
  }

  // setAntialiasEnabled toggles the FXAA edge-smoothing pass.  Forces the
  // FBO/composite path on (see #postActive) so the final image can be
  // FXAA-resolved even when no other post-effect is active.
  setAntialiasEnabled(on) { this.optAntialias = !!on; this.requestRedraw() }

  // setExposure sets the master scene light-intensity multiplier applied
  // to the lit unit colour before the tone curve (Graphics Options
  // Brightness slider).  Clamped to a sane 0.1..3.0 so the slider can't
  // crush to black or blow the image out entirely.
  setExposure(v) { this.exposure = Math.max(0.1, Math.min(3, +v || 1)); this.requestRedraw() }

  // #postActive — true when any post-process effect needs the scene
  // rendered into the offscreen FBO + composited.  Gates the FBO path.
  #postActive() {
    return this.optDof || this.optCinematic || this.optBloom || this.optLensFlare || this.optAntialias
  }

  // setBgTerrainEnabled toggles the background-mountain ring.  When
  // off, the vertex shader's uMountainActive=0 fast-path keeps the
  // ground flat - no cost beyond a few extra clamps per vertex.
  setBgTerrainEnabled(on) { this.optBgTerrain = !!on; this.requestRedraw() }
  // setBgTerrainHeight scales the ENV-driven peak height by a user
  // factor (0..2).  1 = preset default.
  setBgTerrainHeight(v) { this.bgTerrainHeightMul = Math.max(0, +v) || 0; this.requestRedraw() }
  // setBgTerrainScale stretches the noise field horizontally so the
  // mountains read wider / narrower without changing their height.
  setBgTerrainScale(v) { this.bgTerrainScaleMul = Math.max(0.05, +v) || 1; this.requestRedraw() }

  // setSeabedHeight and setSeabedScale - the sea counterpart to the
  // mountain knobs.  Multiply the seabedHeight() output before it's
  // applied to the seabed Y, and stretch the noise scale.
  setSeabedHeight(v) { this.seabedHeightMul = Math.max(0, +v) || 0; this.requestRedraw() }
  setSeabedScale(v) { this.seabedScaleMul = Math.max(0.05, +v) || 1; this.requestRedraw() }
  setSeabedRockChance(v) { this.seabedRockChance = Math.max(0, Math.min(1, +v)) || 0; this.requestRedraw() }

  setReflectionsEnabled(on) { this.optReflections = !!on; this.requestRedraw() }
  setBobEnabled(on) { this.optBob = !!on; this.requestRedraw() }
  setWaterReflectionsEnabled(on) { this.optWaterReflections = !!on; this.requestRedraw() }
  setSpecularEnabled(on) { this.optSpecular = !!on; this.requestRedraw() }
  // setSpecularStrength scales the hull specular sheen (0..2× via the
  // "Specular Highlights" intensity slider).  Surface Hints' metal boost
  // rides on top of this, so the slider scales metal glints too.
  setSpecularStrength(v) { this.specularStrength = Math.max(0, Math.min(3, +v || 0)); this.requestRedraw() }

  // setMetalSpecEnabled toggles the Surface Hints specular boost.  When
  // off, every batch draws at the baseline specular (uSpecScale 1); when
  // on, batches the loader tagged `metallic` (per hints-textures.js) get
  // their per-group specScale.
  setMetalSpecEnabled(on) { this.optMetalSpec = !!on; this.requestRedraw() }
  // setRunningLightsEnabled / setBumpEnabled — independent toggles for the
  // two non-specular surface hints, so they can be turned on/off separately
  // from the metallic-specular inference (Surface Hints).
  setRunningLightsEnabled(on) { this.optRunningLights = !!on; this.requestRedraw() }
  setBumpEnabled(on) { this.optBump = !!on; this.requestRedraw() }
  // Intensity sliders for the two surface-hint effects (0..3, 1 = default).
  setRunningLightsStrength(v) { this.rlStrength = Math.max(0, Math.min(3, +v || 0)); this.requestRedraw() }
  setBumpStrength(v) { this.bumpStrength = Math.max(0, Math.min(3, +v || 0)); this.requestRedraw() }
  setGodBeamsEnabled(on) { this.optGodBeams = !!on; this.requestRedraw() }
  setWavesEnabled(on) { this.optWaves = !!on; this.requestRedraw() }
  setBobAmount(v) { this.bobAmount = Math.max(0, +v) || 0; this.requestRedraw() }
  setBobSpeed(v) { this.bobSpeed = Math.max(0, +v) || 0; this.requestRedraw() }
  setWavesIntensity(v) { this.wavesIntensity = Math.max(0, +v) || 0; this.requestRedraw() }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr))
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  start() {
    if (this.running) return
    this.running = true
    this.lastFrameMs = performance.now()
    const loop = (ts) => {
      if (!this.running) return
      const dt = Math.min(0.1, (ts - this.lastFrameMs) / 1000)
      this.lastFrameMs = ts
      // FPS sampling — push the per-frame dt into a rolling 60-sample
      // ring so getFPS() can return a smoothed value (1-second window
      // at 60 Hz, ~2 seconds at 30 Hz).  Cheap: push + length cap.
      if (!this._fpsSamples) this._fpsSamples = []
      if (dt > 0) {
        this._fpsSamples.push(dt)
        if (this._fpsSamples.length > 60) this._fpsSamples.shift()
      }
      if (this.autoRotate && this.camera) {
        // Drive the camera's orbit yaw rather than spinning the
        // model in place — that way the ground / sea rotate WITH
        // the unit (they don't, of course, but the camera moving
        // around them produces the same parallax) and the user
        // can pick up a manual drag from wherever the auto-rotate
        // left off.
        this.camera.yaw += dt * (Math.PI / 15)
      }
      // COB animation tick — drives per-piece move/turn/spin
      // animators and writes the results into the model's piece
      // tree.  Must run before draw() so the new transforms land
      // in this frame's geometry pass.  Skipped when the host owns
      // the tick (see setCobBinding's driveTick option) — in that
      // case the host's per-tick callback is responsible for
      // calling binding.tick before the next paint, and the
      // pose-copy / particle / light reads below still hold.
      if (this.cobBinding) {
        if (this._cobBindingDriveTick !== false) this.cobBinding.tick(dt * 1000)
        // Pull the binding's strongest live light-emitting particles into our
        // dynamic light slots.  The binding exposes this as a pure getter so it
        // has no awareness of being rendered — same shape as the engine's
        // getSceneLights().
        if (typeof this.cobBinding.getSceneLights === 'function') {
          this.setPulseLights(this.cobBinding.getSceneLights())
        } else {
          const light = this.cobBinding.getSceneLight && this.cobBinding.getSceneLight()
          this.setPulseLights(light ? [light] : [])
        }
      }
      // Pre-draw hook — runs immediately before draw() so the host can
      // sample render interpolation and rebuild the entity list for THIS
      // exact frame.  Doing it here (rather than in onAfterFrame, after the
      // draw) keeps the rendered model geometry and the tracking camera —
      // both of which read the unit's live position inside draw() — locked to
      // one coherent, frame-correct world state.  Sampling after the draw left
      // the model a frame behind the camera, which reads as stutter on any
      // display whose refresh rate isn't a clean multiple of the sim tick.
      if (this.onBeforeFrame) this.onBeforeFrame(dt * 1000)
      this.draw()
      // Notify external observers (studio inspector overlays) that
      // a frame finished.  The host wires a refresh callback so
      // overlays show up-to-date COB / camera state.  Cheap when
      // unhooked.
      if (this.onAfterFrame) this.onAfterFrame(dt * 1000)
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  // clearCanvas paints the canvas with the sky-bottom colour and
  // wipes the depth buffer.  Called by the host on tab switch so a
  // tab that's about to lose the screen doesn't leave its last
  // rendered frame visible while the incoming tab's first paint is
  // pending.  Cheap — one viewport / clearColor / clear call.
  // Multiple renderers share the same gl context (per canvas) so any
  // renderer can invoke this and it clears the shared surface.
  clearCanvas() {
    const gl = this.gl
    if (!gl) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    const c = this.skyBottom || [0.05, 0.07, 0.12]
    gl.clearColor(c[0], c[1], c[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  }

  // getFPS returns the smoothed frames-per-second over the last
  // ~60 frames of the render loop.  Returns 0 when the loop isn't
  // running yet (no model loaded) so the Renderer overlay can
  // distinguish "idle" from "running slowly".
  getFPS() {
    if (!this._fpsSamples || this._fpsSamples.length === 0) return 0
    let sum = 0
    for (const s of this._fpsSamples) sum += s
    const avg = sum / this._fpsSamples.length
    return avg > 0 ? 1 / avg : 0
  }

  requestRedraw() {
    if (this.running) return
    // Skip if this renderer was disposed — the camera-controls wheel
    // handler still has a reference to us if the owning view didn't
    // detach its inputs.  Trying to draw with deleted GL programs
    // spams the console with INVALID_OPERATION warnings.
    if (this._disposed) return
    requestAnimationFrame(() => this.draw())
  }

  // _syncFxClock — called once per frame before any animated unit uniform is
  // read.  Advances the effect clock by the wall delta scaled by the attached
  // COB runtime's playback rate (0 while paused), so blink + bob + sea waves
  // run at the sim's tempo and freeze on pause.  With no binding the rate is a
  // plain 1× (the clock then tracks wall time, matching old behaviour).
  _syncFxClock() {
    const now = performance.now()
    const dt = now - this._fxLastMs
    this._fxLastMs = now
    const rt = this.cobBinding && this.cobBinding.runtime
    const paused = !!(rt && rt.paused)
    this._fxPaused = paused
    const rate = paused
      ? 0
      : (rt && typeof rt.playbackRate === 'number' ? rt.playbackRate : 1)
    // Clamp the wall delta so a stalled / backgrounded frame (rAF throttled to
    // ~1 Hz) doesn't lurch the clock forward by a full second at once.
    this._fxTimeMs += Math.min(250, Math.max(0, dt)) * rate
  }

  // _fxTimeSec — the unit effect clock in seconds.  Pure accumulator read, so
  // every call within a frame returns the same value (the clock only advances
  // in _syncFxClock, once per frame).
  _fxTimeSec() {
    return this._fxTimeMs / 1000
  }

  draw() {
    // Same guard as requestRedraw — the RAF loop can fire one more
    // frame between the dispose call and the stop() taking effect.
    // Also covers the WebGL context-lost case, where the browser
    // evicts our GL context (too many open contexts across tabs) and
    // every subsequent useProgram / bindFramebuffer call would warn.
    if (this._disposed || this.gl?.isContextLost?.()) return
    const gl = this.gl
    // Reset per-frame frustum-cull counters at the top of the frame
    // so the Renderer panel's "drew/culled/total" rows reflect THIS
    // frame's sphere-vs-frustum tests below.  Reads are cheap so the
    // panel can poll every refresh tick without coordination.
    this._cullStats.drew = 0
    this._cullStats.culled = 0
    this._cullStats.shadowed = 0
    this._cullStats.full = 0
    this._cullStats.mid = 0
    this._cullStats.far = 0
    this._cullStats.total = (this._entities && this._entities.length) || 0
    // Phase 3 impostor batch — re-zeroed each frame so _impostorPush
    // can rebuild the buffer from this frame's classifier results.
    this._impCount = 0
    // Shader programs are loaded asynchronously by init(); until they
    // resolve there's nothing to draw.  When init completes it calls
    // requestRedraw() which triggers a fresh draw with everything
    // ready - so silently skipping here is harmless.
    if (!this._programsReady) return
    // Advance / freeze the unit effect clock for this frame before any
    // animated uniform reads it (running lights + sea bob).
    this._syncFxClock()
    this.resize()
    // Camera tracking is a per-frame operation owned by OrbitCamera —
    // when a unit is locked in, applyTracking() pulls camera.target
    // onto the unit's centre of mass BEFORE updateMatrices runs so
    // the view matrix this frame already reflects the new framing.
    // No-op when nothing's tracked.
    if (this.camera && typeof this.camera.applyTracking === 'function') {
      this.camera.applyTracking()
    }

    // In multi-entity mode we proceed even with no `this.model` since
    // the entities array supplies models per-pass.  Camera is always
    // required.
    const haveModel = !!this.model || (this._entities && this._entities.length > 0)
    if (!this.camera || !haveModel) {
      // Empty-scene fallback (multi-entity mode with nothing spawned,
      // or single-entity mode between model loads).  We still want a usable
      // backdrop: refresh the camera matrices + paint the sky AND
      // draw the ground plane so the user sees the grid / terrain /
      // sea immediately rather than a flat blue void.
      // Synth a minimal bounds so #renderGround's centre/span math
      // (model.bounds-driven) doesn't NPE — the ground geometry
      // itself is a fixed-size VBO, the bounds only affect
      // shadow-falloff radius and centre, which the empty scene
      // anchors at the world origin.
      if (this.camera) {
        const aspect = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight)
        this.camera.updateMatrices(aspect, 0.5, 8000)
      }
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.clearColor(this.skyBottom[0], this.skyBottom[1], this.skyBottom[2], 1)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      if (this.groundMode !== 'off' && this._groundVBO && this.camera) {
        const _savedModel = this.model
        const _savedEntities = this._entities
        // Pretend we're in multi-entity mode so #renderGround takes the
        // camera-target-anchored branch with a generous radius — the
        // synthesised single-pixel bounds would otherwise feather the
        // ground out before it reached the visible horizon.
        this._entities = this._entities || [{}]
        this.model = { bounds: { min: [-4, 0, -4], max: [4, 0, 4] } }
        try { this.#renderGround() } catch { /* shader may not be ready yet */ }
        this.model = _savedModel
        this._entities = _savedEntities
      }
      return
    }

    // Multi-entity mode: for the shared setup (camera + sky + ground
    // + shadow) we adopt the FIRST entity's model as `this.model` so
    // the existing bounds-based computations still work.  Per-entity
    // model matrices are built inside the per-entity loop below.
    let _savedModel = null
    if (this._entities) {
      _savedModel = this.model
      this.model = this._entities[0].model
    }
    // In Sea mode the unit bobs on the swell — height + pitch + roll
    // come from sampling the same wave function the surface uses, so
    // the hull rides exactly the visible water under it.  Other
    // ground modes leave the model matrix identity (auto-rotate now
    // spins the camera around a stationary scene).
    Mat4.identity(this._modelMatrix)
    // Unit-position translation (Controls panel Move).  Applied
    // BEFORE the rotation so the heading rotates around the unit's
    // own pivot, and BEFORE the sea-bob so the bob still rides on
    // top of the walking unit.  Y component is the aircraft-flight
    // altitude (zero for ground units).
    const ut = this._unitTransform
    if (ut.x !== 0 || ut.y !== 0 || ut.z !== 0) {
      Mat4.translate(this._modelMatrix, this._modelMatrix, ut.x, ut.y, ut.z)
    }
    if (ut.headingRad !== 0) {
      Mat4.rotateY(this._modelMatrix, this._modelMatrix, ut.headingRad)
    }
    // Locomotion pose overlay — aircraft bank/pitch into their flight, hover-
    // craft gyrate on their cushion.  Applied around the unit's own pivot
    // (after heading, before the sea bob) so it composes with both.
    if (this._loco.hover || this._loco.aircraft) {
      const o = this._computeOrientation(this._loco, this._locoState, this._unitTransform, this._fxTimeSec())
      if (o.heave) Mat4.translate(this._modelMatrix, this._modelMatrix, 0, o.heave, 0)
      if (o.pitch) Mat4.rotateX(this._modelMatrix, this._modelMatrix, o.pitch)
      if (o.roll)  Mat4.rotateZ(this._modelMatrix, this._modelMatrix, o.roll)
    }
    if (this.groundMode === 'sea' && this.model) {
      // Submersion offset comes first — the model is lifted into
      // place between water and seabed (subs) BEFORE the bob is
      // applied so the bob's vertical heave rides on top of the
      // already-positioned unit.
      const yOff = this.getUnitYOffset()
      if (yOff !== 0) {
        Mat4.translate(this._modelMatrix, this._modelMatrix, 0, yOff, 0)
      }
      if (this.optBob) {
        const t = this._fxTimeSec()
        const cx = (this.model.bounds.min[0] + this.model.bounds.max[0]) * 0.5
        const cz = (this.model.bounds.min[2] + this.model.bounds.max[2]) * 0.5
        this._applySeaBob(this._modelMatrix, cx, cz, t)
      }
    }

    // Compute light-space matrix on every frame because the model
    // bounds change between loads and the auto-rotate yaw moves
    // geometry under the static world-space light.
    this.#updateLightMatrices()

    const aspect = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight)
    const span = Math.hypot(
      this.model.bounds.max[0] - this.model.bounds.min[0],
      this.model.bounds.max[1] - this.model.bounds.min[1],
      this.model.bounds.max[2] - this.model.bounds.min[2],
    )
    // Far plane has to reach the new ~2.5 km sea horizon — the
    // ground tessellation extends much further than the unit so the
    // water + seabed are visible all the way out.
    this.camera.updateMatrices(aspect, Math.max(0.05, span * 0.01), Math.max(6000, span * 30 + 1000))

    // Shadow pass is meaningful only when the main pass actually uses
    // shadows.  In Flat / Wireframe modes we skip it to save GPU.
    const usesShadows = this.renderMode === 'full' && this.shadowsEnabled
    if (this._shadowFBO && usesShadows) {
      this.#renderShadowPass(0)
      // Second shadow pass only when the active environment has a
      // real second sun — single-sun worlds skip the cost.
      const sun2Mag = this.lightColor2[0] + this.lightColor2[1] + this.lightColor2[2]
      if (sun2Mag > 0.001 && this._shadowFBO2) this.#renderShadowPass(1)
    }

    // Post-process effects (DoF, cinematic grade, bloom) need the scene
    // rendered into an offscreen colour + depth target so the composite
    // chain can read it back.  When any are active we render into the
    // FBO and run #runPostChain below; otherwise the direct-to-screen
    // path keeps its MSAA + zero overhead.
    const useScenePass = this.#postActive() && this.#ensureSceneFBO()
    if (useScenePass) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._sceneFBO)
      gl.viewport(0, 0, this._sceneW, this._sceneH)
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    }
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    this.#renderSky()

    // Depth-test enabled for ground + model.  LEQUAL so coplanar
    // base/decal pairs both contribute (same trick as before).
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.disable(gl.CULL_FACE)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Studio Mode + Sea ground: render an upside-down "reflection"
    // copy of the unit BEFORE the water surface so the water tints
    // it as the surface paints over the reflected geometry.  Other
    // modes / grounds skip this — flat shading + wireframes don't
    // need the cinematic effect.
    // Reflection only renders when the camera is ABOVE the water
    // plane.  Below the surface the mirrored geometry would be
    // visible directly (no water surface between camera + reflection)
    // and the trick of "the reflection IS a flipped copy" leaks out.
    const waterY = this._getWaterY()
    const cameraAboveWater = !this.camera || this.camera.eye[1] > waterY
    const showReflection = this.renderMode === 'full' && this.groundMode === 'sea' && this.optReflections && cameraAboveWater
    if (this.groundMode === 'sea') {
      // Sea pipeline: seabed first (writes depth), reflection second
      // (depth-tested against the bed so it can't ghost through it),
      // water surface third (alpha-blends over both).  The reflection
      // physically sits between the bed and the surface, exactly
      // where its mirrored geometry lives in world space.
      this._groundPass = 'seabed'
      this.#renderGround()
      if (showReflection) this.#renderReflection()
      this._groundPass = 'water'
      this.#renderGround()
      this._groundPass = null
    } else if (this.groundMode !== 'off') {
      this.#renderGround()
    }

    if (this.renderMode === 'wireframe') {
      this.#renderWireframe([0.85, 0.92, 1.0, 1.0])
    } else if (this._entities) {
      // Multi-entity main pass — iterate each entity, swap this.model
      // + _modelMatrix to point at it, then run the standard single-
      // entity main pass.  Build% / unit-centre / pulse-light all
      // get recomputed inside #renderMain from this.model + the
      // mutated _modelMatrix, so each entity renders correctly.
      const savedBp = this.buildPercent
      const savedUt = { x: this._unitTransform.x, y: this._unitTransform.y, z: this._unitTransform.z, headingRad: this._unitTransform.headingRad }
      // Save the renderer's team-colour fields so the per-entity loop
      // can swap them per unit and restore on the way out — entities
      // can carry their own team colour (per-entity sides) without
      // leaking into the post-loop passes (wireframe overlay, ghost
      // placement preview, etc.).
      const savedTC = this.teamColor
      const savedTCe = this.teamColorEnable
      for (const ent of this._entities) {
        // Phase 1 frustum cull — skip the entity's main pass when its
        // bounding sphere is fully outside the camera frustum.
        // Selection rings live OUTSIDE this loop (drawn afterwards
        // from #renderSelectionRings) so culling a selected unit
        // doesn't lose its ring; ghost / selected entities are
        // exempted inside _entityVisible.
        if (!this._entityVisible(ent)) {
          this._cullStats.culled += 1
          continue
        }
        this._cullStats.drew += 1
        this.model = ent.model
        if (typeof ent.buildPercent === 'number') this.buildPercent = ent.buildPercent
        // Per-entity team colour — caller passes ent.teamColor as
        // either an [r,g,b] tuple (recolour) or null (use the model's
        // authored ARM-blue pixels untouched).  Unset entry = inherit
        // the renderer's currently-committed team colour, preserving
        // existing behaviour for entities that don't opt in.
        if (Object.prototype.hasOwnProperty.call(ent, 'teamColor')) {
          if (ent.teamColor) {
            this.teamColor = [ent.teamColor[0], ent.teamColor[1], ent.teamColor[2]]
            this.teamColorEnable = true
          } else {
            this.teamColor = null
            this.teamColorEnable = false
          }
        }
        const t = ent.transform || { x: 0, y: 0, z: 0, headingRad: 0 }
        this._unitTransform.x = +t.x || 0
        this._unitTransform.y = +t.y || 0
        this._unitTransform.z = +t.z || 0
        this._unitTransform.headingRad = +t.headingRad || 0
        Mat4.identity(this._modelMatrix)
        if (t.x !== 0 || t.y !== 0 || t.z !== 0) {
          Mat4.translate(this._modelMatrix, this._modelMatrix, t.x, t.y, t.z)
        }
        if (t.headingRad !== 0) {
          Mat4.rotateY(this._modelMatrix, this._modelMatrix, t.headingRad)
        }
        // Optional pitch — model-projectiles (missiles / bombs) tilt their
        // nose along the flight path; units leave pitchRad unset.  Applied
        // after the yaw so the mesh banks then dives like the real round.
        if (t.pitchRad) {
          Mat4.rotateX(this._modelMatrix, this._modelMatrix, t.pitchRad)
        }
        // Per-entity locomotion pose overlay — sandbox hovercraft gyrate +
        // aircraft bank into their turns, same as the single-unit path.  Each
        // entity keeps its own prev-transform/smoothing state keyed by id.
        const entLoco = ent.ghost ? null : this._locoForMeta(ent.meta)
        if (entLoco) {
          let est = this._entOrient.get(ent.id)
          if (!est) {
            est = { heading: 0, x: 0, z: 0, y: 0, t: 0, init: false, pitch: 0, roll: 0, heave: 0 }
            this._entOrient.set(ent.id, est)
          }
          const o = this._computeOrientation(entLoco, est, t, this._fxTimeSec())
          if (o.heave) Mat4.translate(this._modelMatrix, this._modelMatrix, 0, o.heave, 0)
          if (o.pitch) Mat4.rotateX(this._modelMatrix, this._modelMatrix, o.pitch)
          if (o.roll)  Mat4.rotateZ(this._modelMatrix, this._modelMatrix, o.roll)
        }
        // Ghost entities (placement preview) render as a pulsing
        // green wireframe instead of the solid main pass — no shadow,
        // no fill, just an outline so the user sees the entity's
        // silhouette under the cursor before committing to the spawn.
        if (ent.ghost) {
          const pulse = 0.55 + 0.45 * Math.sin((performance.now() - this._t0) * 0.006)
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
          gl.depthMask(false)
          const prevWidth = this.wireframeWidth
          this.wireframeWidth = 2
          this.#renderWireframe([0.3, 1.0, 0.45, 0.85 * pulse])
          this.wireframeWidth = prevWidth
          gl.depthMask(true)
          continue
        }
        // Phase 2 / 3 LOD — classify this entity's distance tier:
        //   FULL → full geometry + full lighting (existing path).
        //   MID  → skip lodHide pieces; lighting may also drop to
        //          the cheap shader path when shadow LOD already
        //          gave up on this entity (sub-40 px).
        //   FAR  → push into the impostor batch (single GL_POINTS
        //          sprite drawn after the entity loop).  No
        //          #renderMain call at all — the only per-entity
        //          cost is one buffer write + the eventual one
        //          drawArrays for the whole batch.
        const tier = this._pickLodTier(ent)
        if (tier === LOD_TIER_FULL)      this._cullStats.full += 1
        else if (tier === LOD_TIER_MID)  this._cullStats.mid  += 1
        else                              this._cullStats.far  += 1
        if (tier === LOD_TIER_FAR) {
          this._impostorPush(ent)
          continue
        }
        this._lodHideFlares = (tier !== LOD_TIER_FULL)
        // Lighting LOD — when this entity already lost its shadow
        // (px < SHADOW_LOD_MIN_PX) the user can't tell the difference
        // between Blinn-Phong specular + rim + back-light and a plain
        // Lambertian fill, so the fragment shader uses the cheap path.
        // The flag mirrors the shadow decision: ent._lodShadowOn is
        // set in _castsShadow above; reading it lets the lighting
        // decision stay in lockstep without re-classifying distance.
        this._lightingTierCheap = (ent._lodShadowOn === false)
        this.#renderMain(this.renderMode === 'flat')
        this._lodHideFlares = false
        this._lightingTierCheap = false
        // Inspector hover highlight — when a panel row points at this
        // entity (unit or projectile), trace its silhouette in a bright
        // wireframe so the user can locate it on the field.  Drawn here,
        // while this.model + _modelMatrix already point at the entity, with
        // depth-write off so the outline floats over the hull.
        if (ent.highlight) {
          const g = this.gl
          g.enable(g.BLEND)
          g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA)
          g.disable(g.DEPTH_TEST)
          g.depthMask(false)
          const prevW = this.wireframeWidth
          this.wireframeWidth = 2
          this.#renderWireframe([1.0, 0.85, 0.2, 0.95])
          this.wireframeWidth = prevW
          g.depthMask(true)
          g.enable(g.DEPTH_TEST)
        }
      }
      // Restore globals for subsequent passes (wireframe overlay,
      // particles, etc.) and for any post-frame code that reads
      // unitWorldXZ / buildPercent expecting the "primary" unit.
      // Team colour is restored too so the wireframe overlay /
      // ghost-placement pulse don't inherit the last drawn entity's
      // recoloured palette.
      this.buildPercent = savedBp
      this._unitTransform.x = savedUt.x
      this._unitTransform.y = savedUt.y
      this._unitTransform.z = savedUt.z
      this._unitTransform.headingRad = savedUt.headingRad
      this.teamColor = savedTC
      this.teamColorEnable = savedTCe
      // Selection rings — ground-aligned green hairline squares per
      // entity with `selected: true`.  Drawn AFTER the entity loop so
      // the ring composites on top of the unit when the camera looks
      // down from above (depth still respected so rings clip behind
      // taller foreground geometry).  Only meaningful in multi-entity
      // mode — single-entity mode never sets `selected`.
      this.#renderSelectionRings(this._entities)
      // Phase 3 — render the impostor batch AFTER the full / mid
      // entity loop so far-tier coloured dots composite on top of
      // the ground (their natural visual stack) but under particles
      // + UI overlays.  When the batch is empty (every entity is
      // full or mid this frame, or no entities at all) the method
      // is a no-op.
      this.#renderImpostorBatch()
    } else {
      this.#renderMain(this.renderMode === 'flat')
      if (this.wireframeOverlay) {
        // Polygon offset isn't reliable in WebGL1 across drivers, so
        // we draw the overlay at very-low alpha with depth test still
        // on — line pixels that match the surface depth (LEQUAL)
        // overdraw the surface without z-fight.
        this.#renderWireframe([1.0, 1.0, 1.0, 0.55])
      }
      // Build-progress nano-frame overlay.  When the simulated
      // build percent is below 100, draw a pulsing green wireframe
      // so the unit reads as "still being constructed".  Pulse
      // floor at 0.6 so even at the dimmest point the lines stay
      // readable.  Alpha scales with remaining-build, so a low
      // build% shows a dense bright wireframe while a high build%
      // shows just a faint nano-flicker.  We explicitly turn on
      // BLEND + nudge line width up to 2 px for visibility, and
      // turn depth-write OFF so the bright nano-lines don't
      // pollute the depth buffer for the DoF post-process.
      if (this.buildPercent < 100) {
        const pulse = 0.6 + 0.4 * Math.sin((performance.now() - this._t0) * 0.005)
        const remaining = 1 - this.buildPercent / 100
        const alpha = Math.min(1, 0.45 + 0.55 * remaining) * pulse
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        gl.depthMask(false)
        const prevWidth = this.wireframeWidth
        this.wireframeWidth = 2
        this.#renderWireframe([0.25, 1.0, 0.45, alpha])
        this.wireframeWidth = prevWidth
        gl.depthMask(true)
      }
    }
    // In-flight projectile meshes for the single-unit viewer — drawn after
    // the unit's main pass so missiles / rockets / bombs composite over the
    // hull.  No-op (null) in multi-entity mode, where projectiles are
    // ordinary entities in the loop above.
    if (this._overlayProjectiles) this.#renderOverlayProjectiles()
    if (this._hoveredPieceName || this._hoveredTexture) {
      // Hover highlight: bright red wireframe on the hovered piece
      // (with its descendants) AND/OR every piece whose drawGroups
      // reference the hovered texture.  Drawn AFTER the main scene
      // with depth-test disabled so it always sits on top, even on
      // parts hidden behind other geometry — pinpoints which piece
      // a tree row or texture row refers to even when tucked behind
      // another panel.
      this.#renderHoverHighlight()
    }

    // COB SFX particles — drawn after the unit so smoke + sparks
    // composite over the hull.  Inside the scene FBO when DoF is
    // active so the post-process catches them too.  In multi-entity
    // mode we render each entity's own particle pool in turn (each
    // CobBinding owns its own pool) by swapping the pool ref before
    // each call.
    if (this._entities) {
      const savedPool = this._particlePool
      for (const ent of this._entities) {
        const pool = ent.binding && ent.binding.particles
        // Cull particle pools whose owning entity is well outside the
        // camera frustum.  Padded radius (PARTICLE_CULL_RADIUS_PADDING_WU
        // from ./performance.js) so a smoke trail / missile that's
        // drifted outside the unit's own bounds still draws as long
        // as it's plausibly in-frame.
        const cullable = pool && pool.count > 0 && this.cullEnabled
          && ent && ent.model && ent.model.boundsCentre
          && !ent.ghost && !ent.selected
        let particlesVisible = true
        if (cullable) {
          const t = ent.transform || _IDENTITY_T
          const cx = t.x + ent.model.boundsCentre[0]
          const cy = t.y + ent.model.boundsCentre[1]
          const cz = t.z + ent.model.boundsCentre[2]
          const r = (ent.model.boundsRadius || 0) + PARTICLE_CULL_RADIUS_PADDING_WU
          particlesVisible = this.camera.sphereInFrustum(cx, cy, cz, r)
        }
        if (pool && pool.count > 0 && particlesVisible) {
          this._particlePool = pool
          this.#renderParticles()
          this.#renderSpriteParticles()
        }
      }
      this._particlePool = savedPool
    } else {
      this.#renderParticles()
      this.#renderSpriteParticles()
    }

    // When the scene rendered into our offscreen FBO, run the post
    // chain (DoF + bloom + cinematic grade, then FXAA) to the screen.
    if (useScenePass) this.#runPostChain()

    // Restore single-entity `this.model` after multi-entity rendering
    // so callers reading the renderer's `model` (inspectors, piece
    // tree) don't see the LAST entity in the loop as the active unit.
    // Unconditional restore when entities were present — the prior
    // `_savedModel !== null` guard skipped the restore for the multi-
    // entity path (which legitimately starts with this.model === null),
    // leaving the last entity's model leaked onto this.model.  The next
    // frame's empty-scene fallback then saw `!!this.model` as truthy
    // and went down the unit-bounds-anchored ground path, which shrunk
    // the grid footprint down to a tiny pad around the leaked model's
    // centre — the "grid disappears on Clear Field" symptom.
    if (this._entities) {
      this.model = _savedModel
    }
  }

  #renderHoverHighlight() {
    const gl = this.gl
    gl.useProgram(this.programWire)
    gl.uniformMatrix4fv(this.uWireProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uWireView, false, this.camera.viewMatrix)
    gl.uniform4fv(this.uWireColor, [1.0, 0.25, 0.30, 1.0])
    gl.uniform2f(this.uWirePixelOffset, 0, 0)
    // Disable depth test so the highlight survives even when the
    // piece sits behind other geometry from the camera's POV.
    gl.disable(gl.DEPTH_TEST)
    gl.lineWidth?.(2)
    // Two-pass walk: first locate the hovered piece (matching by
    // lowercased name), then paint that piece AND every descendant
    // in red.  Highlighting the whole sub-tree (not just the leaf)
    // mirrors how TA scripts manipulate piece hierarchies — selecting
    // "wing1" should call attention to the wingtip + flare children
    // too so the user sees the entire animated group.
    const wantPiece   = this._hoveredPieceName
    const wantTexture = this._hoveredTexture
    const paintPiece = (piece) => {
      if (!piece.visible || !piece.wireframe) return
      gl.uniformMatrix4fv(this.uWireWorld, false, piece.worldMatrix)
      gl.bindBuffer(gl.ARRAY_BUFFER, piece.wireframe.vbo)
      gl.enableVertexAttribArray(this.aWirePos)
      gl.vertexAttribPointer(this.aWirePos, 3, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.LINES, 0, piece.wireframe.vertexCount)
    }
    const paintHierarchy = (piece, parent) => {
      if (!piece) return
      piece.computeWorldMatrix(parent, this._worldScratch)
      paintPiece(piece)
      for (const c of piece.children) paintHierarchy(c, piece.worldMatrix)
    }
    // Single recursive walk: refresh every piece's world matrix
    // (so paintHierarchy below sees fresh transforms), then for
    // each piece decide whether to highlight it based on the two
    // hover criteria.
    //   * wantPiece — when the piece's name matches, paint it +
    //     all descendants (existing piece-hover behaviour).
    //   * wantTexture — when ANY of the piece's drawGroups
    //     references the texture, paint just that piece.  No
    //     descendant cascade — the user is asking "which pieces
    //     use this texture", not "which pieces are under this
    //     texture in the hierarchy".
    // Paint only the wireframe edges belonging to primitives that
    // use `wantTexture`.  The piece's per-texture wireframe map
    // (built by the model loader) carries exactly the edges whose
    // tris share a texture name, so a one-face logo decal lights
    // up that face instead of the whole hull (which the combined
    // piece.wireframe would cover).
    const paintPieceTexture = (piece) => {
      if (!piece.visible || !piece.wireframeByTex) return
      const w = piece.wireframeByTex.get(wantTexture)
      if (!w) return
      gl.uniformMatrix4fv(this.uWireWorld, false, piece.worldMatrix)
      gl.bindBuffer(gl.ARRAY_BUFFER, w.vbo)
      gl.enableVertexAttribArray(this.aWirePos)
      gl.vertexAttribPointer(this.aWirePos, 3, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.LINES, 0, w.vertexCount)
    }
    const walk = (piece, parent) => {
      if (!piece) return
      piece.computeWorldMatrix(parent, this._worldScratch)
      if (wantPiece && piece.name?.toLowerCase() === wantPiece) {
        paintHierarchy(piece, parent)
        return  // descendant matches absorbed into the cascade
      }
      if (wantTexture) paintPieceTexture(piece)
      for (const c of piece.children) walk(c, piece.worldMatrix)
    }
    walk(this.model.root, this._modelMatrix)
    gl.enable(gl.DEPTH_TEST)
  }

  dispose() {
    this.stop()
    // Mark disposed BEFORE freeing GL objects so any stray
    // requestRedraw / draw call (e.g. from a still-attached
    // camera-controls wheel handler whose owner forgot to detach)
    // bails out instead of trying to useProgram a deleted handle.
    this._disposed = true
    const gl = this.gl
    if (this.model) this.model.dispose(gl)
    if (this.programMain) gl.deleteProgram(this.programMain)
    if (this.programShadow) gl.deleteProgram(this.programShadow)
    if (this.programSky) gl.deleteProgram(this.programSky)
    if (this.programGround) gl.deleteProgram(this.programGround)
    if (this.programWire) gl.deleteProgram(this.programWire)
    if (this._shadowFBO) gl.deleteFramebuffer(this._shadowFBO)
    if (this._shadowTex) gl.deleteTexture(this._shadowTex)
    if (this._terrainTex) gl.deleteTexture(this._terrainTex)
    if (this._skyVBO) gl.deleteBuffer(this._skyVBO)
    if (this._groundVBO) gl.deleteBuffer(this._groundVBO)
    if (this.textureCache) this.textureCache.dispose()
    // Null the program/buffer references so any internal code that
    // bypasses the requestRedraw/draw guards above (e.g. a sub-pass
    // calling gl.useProgram directly) has a clear "this is gone" sentinel.
    this.programMain = null
    this.programShadow = null
    this.programSky = null
    this.programGround = null
    this.programWire = null
    this._shadowFBO = null
    this._shadowTex = null
    this._terrainTex = null
    this._skyVBO = null
    this._groundVBO = null
  }

  // ── Frame: shadow pass ──────────────────────────────────────────────

  #renderShadowPass(lightIdx = 0) {
    const gl = this.gl
    const fbo = lightIdx === 1 ? this._shadowFBO2 : this._shadowFBO
    const space = lightIdx === 1 ? this._lightSpace2 : this._lightSpace
    if (!fbo) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    gl.clearColor(1, 1, 1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    // Front-face cull during the shadow pass eliminates "peter-pan"
    // (model floating above its shadow) and the worst of self-shadow
    // acne on planar surfaces.
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.FRONT)
    gl.disable(gl.BLEND)

    gl.useProgram(this.programShadow)
    gl.uniformMatrix4fv(this.uShadowLightSpace, false, space)
    // Multi-entity mode — each entity contributes its own
    // shadow at its CURRENT world position, not the first entity's
    // bounds-center.  Without this loop the renderer's per-entity main
    // pass below paints every unit correctly but every shadow stayed
    // glued to wherever the first spawn landed.  We mutate this.model
    // + this._modelMatrix per entity, draw geometry, then restore the
    // outer-scope state so the post-shadow main pass picks up where
    // this loop leaves it.
    if (this._entities && this._entities.length > 0) {
      const savedModel = this.model
      const savedMatrix = new Float32Array(this._modelMatrix)
      for (const ent of this._entities) {
        // Ghost entities (placement preview) have no live unit so
        // no shadow — matches the "this isn't a real spawn yet" read
        // of the wireframe ghost.
        if (ent.ghost || !ent.model) continue
        // Distance-based shadow LOD — entities whose projected size
        // on screen drops below shadowMinPx skip the shadow pass.
        // Near units cast shadows, far units don't.  The shadow pass
        // intentionally does NOT use the camera-frustum cull from
        // Phase 1: a caster off the camera's edge can still project
        // its shadow INTO the visible frame, and dropping it would
        // leave a gap on the ground.  The pixel-radius gate dodges
        // that — at zoom-out distances where the shadow would be
        // sub-pixel anyway, we don't care that we lose it.
        if (!this._castsShadow(ent)) continue
        this._cullStats.shadowed += 1
        this.model = ent.model
        const t = ent.transform || { x: 0, y: 0, z: 0, headingRad: 0 }
        Mat4.identity(this._modelMatrix)
        if (t.x !== 0 || t.y !== 0 || t.z !== 0) {
          Mat4.translate(this._modelMatrix, this._modelMatrix, t.x, t.y, t.z)
        }
        if (t.headingRad !== 0) {
          Mat4.rotateY(this._modelMatrix, this._modelMatrix, t.headingRad)
        }
        this.#drawGeometry(this.model.root, this._modelMatrix, true)
      }
      this.model = savedModel
      this._modelMatrix.set(savedMatrix)
    } else {
      this.#drawGeometry(this.model.root, this._modelMatrix, true)
    }

    gl.disable(gl.CULL_FACE)
  }

  // ── Frame: sky pass ─────────────────────────────────────────────────

  #renderSky() {
    const gl = this.gl
    gl.useProgram(this.programSky)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._skyVBO)
    gl.enableVertexAttribArray(this.aSkyPos)
    gl.vertexAttribPointer(this.aSkyPos, 2, gl.FLOAT, false, 0, 0)
    // Build inv(view*proj) so the fragment shader can recover a
    // world-space ray for each pixel.  The matrix changes only when
    // the camera moves so a per-frame inversion is cheap.
    Mat4.invert(this._invProj, this.camera.projMatrix)
    Mat4.invert(this._invView, this.camera.viewMatrix)
    Mat4.multiply(this._invVP, this._invView, this._invProj)
    gl.uniformMatrix4fv(this.uSkyInvVP, false, this._invVP)
    gl.uniform3fv(this.uSkyEyePos, this.camera.eye)
    const s = this.skyScheme
    gl.uniform3fv(this.uSkyZenith, s.zenith)
    gl.uniform3fv(this.uSkyHorizon, s.horizon)
    // Sun 1 — direction is the main scene light direction, normalised
    // by the renderer's own normalise (lightDir already is).
    gl.uniform3fv(this.uSkySun1Col, s.sun1.color)
    gl.uniform3fv(this.uSkySun1Dir, s.sun1.dir || this.lightDir)
    gl.uniform1f(this.uSkySun1Size, s.sun1.size)
    // Sun 2 — colour [0,0,0] means "off"; pass anyway to avoid
    // uniform-undefined warnings on some drivers.
    gl.uniform3fv(this.uSkySun2Col, s.sun2.color)
    gl.uniform3fv(this.uSkySun2Dir, s.sun2.dir)
    gl.uniform1f(this.uSkySun2Size, s.sun2.size)
    gl.uniform3fv(this.uSkyCloudCol, s.cloudColor)
    gl.uniform3fv(this.uSkyCloudShd, s.cloudShadow)
    gl.uniform1f(this.uSkyCloudCov, s.cloudCoverage)
    gl.uniform1f(this.uSkyCloudDen, s.cloudDensity)
    gl.uniform1f(this.uSkyCloudSpd, s.cloudSpeed)
    gl.uniform1f(this.uSkyTime, (performance.now() - this._t0) / 1000)
    gl.uniform1f(this.uSkyOptGodBeams, this.optGodBeams ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.disableVertexAttribArray(this.aSkyPos)
  }

  // ── Frame: ground plane pass ───────────────────────────────────────

  #renderGround() {
    const gl = this.gl
    gl.useProgram(this.programGround)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._groundVBO)
    gl.enableVertexAttribArray(this.aGroundPos)
    gl.vertexAttribPointer(this.aGroundPos, 3, gl.FLOAT, false, 0, 0)
    gl.uniformMatrix4fv(this.uGroundProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uGroundView, false, this.camera.viewMatrix)
    gl.uniformMatrix4fv(this.uGroundLightSpace, false, this._lightSpace)
    gl.uniformMatrix4fv(this.uGroundLightSpace2, false, this._lightSpace2)
    gl.uniform3fv(this.uGroundColorA, this.groundColorA)
    gl.uniform3fv(this.uGroundColorB, this.groundColorB)
    // Hand the ground program sun2's colour so it can short-circuit
    // the second shadow tap on single-sun environments.
    gl.uniform3fv(this.uGroundLightColor2, this.lightColor2)
    // In non-sea modes the ground plane sits just under the model's
    // lowest vertex so the unit stands ON it.  In Sea mode it gets
    // shifted up by submersionMode so ships ride at boot-stripe
    // level and subs end up under the surface — _getWaterY()
    // bakes that adjustment in.
    const groundY = this.groundMode === 'sea' ? this._getWaterY() : (this.model.bounds.min[1] - 0.05)
    // Multi-entity mode anchors the ground footprint on the
    // camera target with a radius scaled to the current zoom — a
    // single unit-sized pad would feather out a few feet from the
    // model and leave the rest of the canvas a blue void.  Single-
    // entity mode keeps the original behaviour: pad centred on the
    // model, sized to its bounds (so the grid hugs the unit's footprint).
    let cx, cz, radius
    if (this._entities && this._entities.length > 0 && this.camera && this.camera.target) {
      cx = this.camera.target[0]
      cz = this.camera.target[2]
      // Cover roughly twice the camera distance so panning + zooming
      // out still find ground under the cursor.  Clamped to a sane
      // floor for very close zooms.
      radius = Math.max(200, (this.camera.distance || 200) * 2)
    } else {
      cx = (this.model.bounds.min[0] + this.model.bounds.max[0]) * 0.5
      cz = (this.model.bounds.min[2] + this.model.bounds.max[2]) * 0.5
      const span = Math.hypot(this.model.bounds.max[0] - this.model.bounds.min[0], this.model.bounds.max[2] - this.model.bounds.min[2])
      radius = Math.max(span * 0.6, 4)
    }
    gl.uniform3fv(this.uGroundCenter, [cx, groundY, cz])
    gl.uniform1f(this.uGroundRadius, radius)
    gl.uniform1f(this.uGroundY, groundY)
    gl.uniform1f(this.uGroundShadowEnabled, (this._shadowFBO && this.renderMode === 'full' && this.shadowsEnabled) ? 1 : 0)
    // Shadow opacity tracks construction progress — translucent at low
    // build %, solid at 100%.  Cubic ease so the shadow stays subtle
    // until the build is nearly done, then snaps to full presence.
    // Then scaled by the Graphics Options shadow-intensity slider.
    const _bps = (this.buildPercent ?? 100) / 100
    gl.uniform1f(this.uGroundShadowStrength, _bps * _bps * _bps * this.shadowStrength)
    if (this._shadowFBO) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex)
      gl.uniform1i(this.uGroundShadowMap, 1)
      // Twin-sun secondary shadow.  Bound regardless of whether
      // it's actively used - the fragment shader gates the sample
      // on uLightColor2 so single-sun envs spend no extra ALU.
      // Sampler still needs to point at a real texture or some
      // drivers throw INVALID_OPERATION.
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex2 || this._shadowTex)
      gl.uniform1i(this.uGroundShadowMap2, 3)
    }
    // Mode + terrain texture.  TileSize ≈ 16 world units per cell —
    // matches TA's footprint convention (a "1x1" footprint slot in
    // a unit's FBI is ~16 world units), so a small unit covers one
    // grid cell and a Krogoth-class hulk straddles a few.
    const modeId = this.groundMode === 'grid' ? 0
      : this.groundMode === 'terrain' ? 1
      : this.groundMode === 'sea' ? 2
      : 3
    gl.uniform1i(this.uGroundModeId, modeId)
    gl.uniform1f(this.uGroundTileSize, 16)
    gl.uniform1f(this.uGroundTerrainReady, this._terrainReady ? 1 : 0)
    // Sea-surface waves run on the pausable, speed-scaled effect clock — the
    // SAME clock the unit's CPU sea-bob samples — so the hull stays seated on
    // its wave crest at any Runtime Speed and both freeze together on pause.
    gl.uniform1f(this.uGroundTime, this._fxTimeSec())
    gl.uniform1f(this.uGroundExposure, this.exposure ?? 1.0)
    // Normalise the world key-light colour to max-channel 1 so the ground
    // picks up the sun's HUE without changing its overall brightness.
    const _lc = this.lightColor || [1, 1, 1]
    const _lm = Math.max(_lc[0], _lc[1], _lc[2], 1e-4)
    gl.uniform3f(this.uGroundSunTint, _lc[0] / _lm, _lc[1] / _lm, _lc[2] / _lm)
    gl.uniform3fv(this.uGroundLightDir, this.lightDir)
    gl.uniform3fv(this.uGroundEyePos, this.camera.eye)
    gl.uniform3fv(this.uGroundHorizonColor, this.skyScheme.horizon)
    gl.uniform1f(this.uGroundOptWaterReflections, this.optWaterReflections ? 1 : 0)
    gl.uniform1f(this.uGroundOptSpecular, this.optSpecular ? 1 : 0)
    // Waves toggle off → flat sea (intensity 0); otherwise use the
    // slider value so the user can scale waves from glassy to gale.
    gl.uniform1f(this.uGroundWavesIntensity, this.optWaves ? this.wavesIntensity : 0.0)
    // Per-environment water + seabed colours come from the active
    // environment preset.  Default values pull from greenworld so
    // an environment that doesn't override a particular stop still
    // looks like temperate ocean.
    const env = this.activeEnvironment || ENVIRONMENT_PRESETS.greenworld
    gl.uniform3fv(this.uGroundWaterShallow, env.waterShallow || [0.10, 0.40, 0.72])
    gl.uniform3fv(this.uGroundWaterMid,     env.waterMid     || [0.04, 0.18, 0.45])
    gl.uniform3fv(this.uGroundWaterDeep,    env.waterDeep    || [0.01, 0.05, 0.20])
    gl.uniform1f(this.uGroundWaterTranslucency, env.waterTranslucency ?? 1.0)
    gl.uniform3fv(this.uGroundSeabedSand,    env.seabedSand    || [0.25, 0.32, 0.30])
    gl.uniform3fv(this.uGroundSeabedRock,    env.seabedRock    || [0.14, 0.18, 0.18])
    gl.uniform3fv(this.uGroundSeabedCaustic, env.seabedCaustic || [0.35, 0.65, 0.95])
    // Seabed feature knobs — user-controlled multipliers on the
    // GLSL seabedHeight() helper.
    gl.uniform1f(this.uGroundSeabedHeightMul, this.seabedHeightMul)
    gl.uniform1f(this.uGroundSeabedScaleMul, this.seabedScaleMul)
    gl.uniform1f(this.uGroundSeabedRockChance, this.seabedRockChance)
    // Dynamic pulse lights — same source as the main pass (set per frame by
    // setPulseLights from the scene's active light-emitting particles).
    // Terrain modes use these to spill a coloured wash from weapon SFX onto
    // the ground beneath the firing units; unused slots upload range 0 so the
    // shader's per-light gate skips them.
    this.#uploadPulseLights(gl, this.uGroundPulseLightPos, this.uGroundPulseLightColor, this.uGroundPulseLightRange, this.uGroundPulseLightCount)
    // Background mountain ring.  Active only on non-sea ground
    // modes; sea pass already paints water + seabed and shouldn't
    // be displaced.  Inner clearing scales with the unit's bounding
    // span so a Krogoth doesn't get hemmed in.
    const bgActive = this.optBgTerrain && this.groundMode !== 'sea' && this.groundMode !== 'off'
    gl.uniform1f(this.uGroundMountainActive, bgActive ? 1 : 0)
    if (bgActive) {
      // Mountain-ring clearing scales with whatever sits at the
      // ground centre: a single unit's bounding span in single-entity
      // mode, or a generous battlefield-sized constant in multi-entity
      // mode (where `span` from a synthesised bounds would be tiny).
      const bgSpan = (this._entities && this._entities.length > 0)
        ? Math.max(200, (this.camera?.distance || 200) * 0.6)
        : Math.hypot(
            this.model.bounds.max[0] - this.model.bounds.min[0],
            this.model.bounds.max[2] - this.model.bounds.min[2],
          )
      const clearR = Math.max(bgSpan * 3.5, 120)
      gl.uniform3fv(this.uGroundClearCenter, [cx, groundY, cz])
      gl.uniform1f(this.uGroundClearRadius, clearR)
      gl.uniform1f(this.uGroundClearFalloff, Math.max(bgSpan * 2.5, 80))
      gl.uniform1f(this.uGroundMountainHeight, (env.mountainHeight || 62) * this.bgTerrainHeightMul)
      gl.uniform1f(this.uGroundMountainScale, (env.mountainScale || 1) * this.bgTerrainScaleMul)
      gl.uniform1i(this.uGroundMountainStyle, env.mountainStyle ?? this.bgTerrainStyle)
      gl.uniform3fv(this.uGroundMountainBase, env.mountainBase || this.bgTerrainBase)
      gl.uniform3fv(this.uGroundMountainPeak, env.mountainPeak || this.bgTerrainPeak)
      gl.uniform1f(this.uGroundMountainGloss, env.mountainGloss ?? this.bgTerrainGloss)
    }
    if (this._terrainTex) {
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this._terrainTex)
      gl.uniform1i(this.uGroundTerrainTex, 2)
    }
    // In Sea mode, render the rocky seabed first (depressed Y, fully
    // opaque) and the translucent water surface on top.  The water
    // shader's per-fragment alpha drops where the bed sits close to
    // the surface so the rocks visibly poke through.  Other ground
    // modes skip the seabed pass entirely.
    // Seabed sits ~45 wu below the water plane — deep enough that
    // the new taller rock outcrops (~6 wu peaks + ~5 wu dune crests)
    // never reach the wave troughs above (~2.6 wu deep), and the
    // water column reads as a real ocean depth.
    const seabedY = groundY - 45.0
    gl.uniform1f(this.uGroundSeabedY, seabedY)
    if (this.groundMode === 'sea') {
      if (!this._groundPass || this._groundPass === 'seabed') {
        // Pass 1: seabed (opaque).  Write depth normally so the
        // reflection + water passes can depth-test against it —
        // anything geometrically below the bed gets clipped.
        gl.uniform1f(this.uGroundSeabedActive, 1)
        gl.disable(gl.BLEND)
        gl.drawArrays(gl.TRIANGLES, 0, this._groundVertexCount || 6)
        gl.enable(gl.BLEND)
        gl.uniform1f(this.uGroundSeabedActive, 0)
      }
      if (!this._groundPass || this._groundPass === 'water') {
        gl.drawArrays(gl.TRIANGLES, 0, this._groundVertexCount || 6)
      }
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, this._groundVertexCount || 6)
    }
    gl.disableVertexAttribArray(this.aGroundPos)
  }

  // ── Frame: reflection pass for Studio Mode on Sea ───────────
  //
  // Renders the model a second time mirrored across the water
  // plane.  Result is the upside-down unit sitting just under the
  // water surface — when the ground (water) pass paints over it
  // with the translucent blue tint, what reads on screen is a
  // proper aquatic reflection (dimmer + bluer toward the deeper
  // troughs, brighter at the crests).  The main shader's
  // uReflectionTint uniform pushes the colour palette + alpha so
  // this pass doesn't look like a full duplicate of the unit.
  #renderReflection() {
    const gl = this.gl
    gl.useProgram(this.programMain)
    gl.uniformMatrix4fv(this.uProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uView, false, this.camera.viewMatrix)
    gl.uniformMatrix4fv(this.uLightSpace, false, this._lightSpace)
    gl.uniformMatrix4fv(this.uLightSpace2, false, this._lightSpace2)
    gl.uniform3fv(this.uLightDir, this.lightDir)
    gl.uniform3fv(this.uLightColor, this.lightColor)
    gl.uniform3fv(this.uLightDir2, this.lightDir2)
    gl.uniform3fv(this.uLightColor2, this.lightColor2)
    gl.uniform3fv(this.uSkyColorMain, this.skyColor)
    gl.uniform3fv(this.uGroundColor, this.groundColor)
    gl.uniform3fv(this.uMainEyePos, this.camera.eye)
    gl.uniform3fv(this.uMainFillColor, this._fillColor())
    gl.uniform3fv(this.uMainBackColor, this._backColor())
    gl.uniform1f(this.uFlatLighting, 0)
    gl.uniform1f(this.uExposure, this.exposure)
    gl.uniform1f(this.uSpecularEnabled, this.optSpecular ? 1 : 0)
    gl.uniform1f(this.uSpecularStrength, this.specularStrength)
    gl.uniform1f(this.uRLStrength, this.rlStrength)
    gl.uniform1f(this.uRLPhaseBuckets, RUNNING_LIGHT_TIMING_BUCKETS)
    gl.uniform1f(this.uBumpStrength, this.bumpStrength)
    gl.uniform1f(this.uRLFadeOut, 0.2)
    gl.uniform1f(this.uBumpSmooth, 1.5)
    gl.uniform1f(this.uBumpThreshold, 0.12)
    gl.uniform1f(this.uBumpScale, 1.0)
    gl.uniform2f(this.uTexel, 1 / 256, 1 / 256)
    // Surface-hint effects off in the reflection pass (the per-group loop
    // re-enables them for opted-in tiles); keeps the uniforms defined so a
    // reflection draw never inherits stale values.
    gl.uniform1f(this.uRunningLights, 0)
    gl.uniform1f(this.uLampMapValid, 0)
    gl.uniform1f(this.uRLEmit, 0)
    gl.uniform1f(this.uBump, 0)
    gl.uniform1f(this.uBumpIntensity, 0)
    gl.uniform1f(this.uShadowEnabled, 0) // reflection doesn't read the depth map
    gl.uniform1f(this.uReflectionTint, 1)
    // Reflections always run the full lighting path — the mirrored
    // unit is the visible feature in sea mode and skipping its
    // rim/specular would make the reflection look painted on.
    gl.uniform1f(this.uLightingTier, 0)
    // Reflection pass paints the mirrored unit dim+blue.  Sea bounce
    // on top of that would double-glow the reflection, so leave it
    // off for this pass.
    gl.uniform1f(this.uSeaActive, 0)
    gl.uniform1f(this.uMainTime, this._fxTimeSec())
    gl.uniform1f(this.uMainWaterY, this._getWaterY())
    gl.uniform1f(this.uMainWaterOnHull, 0)
    gl.uniform1f(this.uMainWavesIntensity, this.optWaves ? this.wavesIntensity : 0.0)
    gl.uniform3fv(this.uMainTeamColor, this.teamColor || [0, 0, 1])
    gl.uniform1f(this.uMainTeamColorEnable, this.teamColorEnable ? 1 : 0)
    // Dynamic pulse lights — fed by setPulseLights() from the controller each
    // frame.  Unused slots upload range 0 so the shader skips them when no
    // weapon is firing.  Same uniforms in main + reflection passes so the
    // weapon glow reflects off water too.
    this.#uploadPulseLights(gl, this.uPulseLightPos, this.uPulseLightColor, this.uPulseLightRange, this.uPulseLightCount)
    // Unit centre + radius for the pulse-light self-occlusion test.
    // Centre = model bbox centroid translated by the unit transform
    // (so it follows a walking unit).  Radius = bbox diagonal/2 with
    // a small floor so vanishingly small units don't divide by zero.
    if (this.model && this.model.bounds) {
      const _b = this.model.bounds
      const _ut = this._unitTransform
      const _cx = (_b.min[0] + _b.max[0]) * 0.5 + (_ut ? _ut.x : 0)
      const _cy = (_b.min[1] + _b.max[1]) * 0.5 + (_ut ? _ut.y : 0)
      const _cz = (_b.min[2] + _b.max[2]) * 0.5 + (_ut ? _ut.z : 0)
      const _dx = _b.max[0] - _b.min[0], _dy = _b.max[1] - _b.min[1], _dz = _b.max[2] - _b.min[2]
      const _radius = Math.max(2, 0.5 * Math.hypot(_dx, _dy, _dz))
      gl.uniform3fv(this.uUnitCenter, [_cx, _cy, _cz])
      gl.uniform1f(this.uUnitRadius, _radius)
    } else {
      gl.uniform3fv(this.uUnitCenter, [0, 0, 0])
      gl.uniform1f(this.uUnitRadius, 10)
    }
    // Build-progress fade.  When buildPercent < 100, the textured
    // model renders at reduced alpha so the green nano-wireframe
    // overlay drawn afterwards reads cleanly; at 100 the texture
    // is fully opaque.  Cubic ease so the fade-in feels weighty
    // toward the end of construction rather than linearly bright.
    const _bp = (this.buildPercent ?? 100) / 100
    gl.uniform1f(this.uMainOutputAlpha, _bp * _bp * _bp)

    // Mirror across the water plane.  _getWaterY() handles the
    // submersion-mode offset so a sub's reflection mirrors across
    // the shifted-up water level, not the unit's bounding-box floor.
    const waterY = this._getWaterY()
    const mirror = this._scratch
    Mat4.identity(mirror)
    mirror[5] = -1                     // scale Y by -1
    mirror[13] = 2 * waterY            // translate Y by 2 * waterY
    const refl = this._scratch2 || (this._scratch2 = Mat4.create())
    if (this.groundMode === 'sea' && this.model) {
      const t = this._fxTimeSec()
      const cx = (this.model.bounds.min[0] + this.model.bounds.max[0]) * 0.5
      const cz = (this.model.bounds.min[2] + this.model.bounds.max[2]) * 0.5
      const bob = this._bobScratch || (this._bobScratch = Mat4.create())
      Mat4.identity(bob)
      // Mirror the SAME unit translate + heading rotation the main
      // pass applies, otherwise a moving unit's reflection stays
      // anchored at world origin while the actual unit walks away.
      // Y-mirror commutes with Y-axis rotation so the rotateY here
      // produces the correct mirrored orientation when multiplied
      // by `mirror` below.
      const ut = this._unitTransform
      if (ut.x !== 0 || ut.z !== 0) Mat4.translate(bob, bob, ut.x, 0, ut.z)
      if (ut.headingRad !== 0) Mat4.rotateY(bob, bob, ut.headingRad)
      // Same submersion lift the main model gets — without it the
      // mirrored unit reflects from y=0 instead of from the unit's
      // actually-displayed position.
      const yOff = this.getUnitYOffset()
      if (yOff !== 0) Mat4.translate(bob, bob, 0, yOff, 0)
      // Only heave/pitch/roll the reflection when the unit itself is
      // bobbing — matches the main pass's `if (this.optBob)` gate so a
      // still ship doesn't get a swaying mirror image.
      if (this.optBob) this._applySeaBob(bob, cx, cz, t)
      Mat4.multiply(refl, mirror, bob)
    } else {
      Mat4.copy(refl, mirror)
    }
    // Pipeline (in the caller) is: seabed → reflection → water.  The
    // reflection now WRITES depth so the water surface above can
    // depth-test against it (LEQUAL → water at the water plane is
    // <= reflection at top of mirrored hull, so water still wins).
    // Polygon offset pushes the reflection's depth slightly away
    // from the camera so it can't z-fight against the water surface
    // at the boundary where they touch.
    gl.enable(gl.POLYGON_OFFSET_FILL)
    gl.polygonOffset(1.0, 1.0)
    this.#drawGeometry(this.model.root, refl, false)
    gl.polygonOffset(0.0, 0.0)
    gl.disable(gl.POLYGON_OFFSET_FILL)

    gl.uniform1f(this.uReflectionTint, 0)
  }

  // #renderOverlayProjectiles draws the single-unit viewer's in-flight
  // projectile meshes by swapping `this.model` + `_modelMatrix` to each
  // projectile in turn and running the standard main pass — the same trick
  // the multi-entity loop uses, minus culling/LOD (a handful of close-range
  // shots).  Saves + restores the unit's model / transform / build% so any
  // post-frame reader (inspectors, jump-to-piece) still sees the unit.
  #renderOverlayProjectiles() {
    const savedModel = this.model
    const savedBp = this.buildPercent
    const savedHide = this._lodHideFlares
    const ut = this._unitTransform
    const savedUt = { x: ut.x, y: ut.y, z: ut.z, headingRad: ut.headingRad }
    // Projectiles are always fully built; the unit's build% would otherwise
    // paint a nano-frame wireframe over the missile mid-flight.
    this.buildPercent = 100
    this._lodHideFlares = false
    for (const proj of this._overlayProjectiles) {
      if (!proj || !proj.model) continue
      this.model = proj.model
      const t = proj.transform || _IDENTITY_T
      ut.x = +t.x || 0
      ut.y = +t.y || 0
      ut.z = +t.z || 0
      ut.headingRad = +t.headingRad || 0
      Mat4.identity(this._modelMatrix)
      Mat4.translate(this._modelMatrix, this._modelMatrix, ut.x, ut.y, ut.z)
      if (ut.headingRad !== 0) Mat4.rotateY(this._modelMatrix, this._modelMatrix, ut.headingRad)
      // Pitch tilts the nose along the climb/dive — applied after the yaw,
      // matching the sandbox projectile-entity convention.
      if (t.pitchRad) Mat4.rotateX(this._modelMatrix, this._modelMatrix, t.pitchRad)
      this.#renderMain(this.renderMode === 'flat')
    }
    this.model = savedModel
    this.buildPercent = savedBp
    this._lodHideFlares = savedHide
    ut.x = savedUt.x
    ut.y = savedUt.y
    ut.z = savedUt.z
    ut.headingRad = savedUt.headingRad
  }

  // ── Frame: main scene pass ─────────────────────────────────────────

  #renderMain(flat) {
    const gl = this.gl
    gl.useProgram(this.programMain)
    gl.uniformMatrix4fv(this.uProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uView, false, this.camera.viewMatrix)
    gl.uniformMatrix4fv(this.uLightSpace, false, this._lightSpace)
    gl.uniformMatrix4fv(this.uLightSpace2, false, this._lightSpace2)
    gl.uniform3fv(this.uLightDir, this.lightDir)
    gl.uniform3fv(this.uLightColor, this.lightColor)
    gl.uniform3fv(this.uLightDir2, this.lightDir2)
    gl.uniform3fv(this.uLightColor2, this.lightColor2)
    gl.uniform3fv(this.uSkyColorMain, this.skyColor)
    gl.uniform3fv(this.uGroundColor, this.groundColor)
    gl.uniform3fv(this.uMainEyePos, this.camera.eye)
    gl.uniform3fv(this.uMainFillColor, this._fillColor())
    gl.uniform3fv(this.uMainBackColor, this._backColor())
    // Flat mode bypasses the directional + ambient + shadow path so
    // the renderer prints the raw texture / palette colour.
    gl.uniform1f(this.uFlatLighting, flat ? 1 : 0)
    gl.uniform1f(this.uExposure, this.exposure)
    gl.uniform1f(this.uSpecularEnabled, this.optSpecular ? 1 : 0)
    gl.uniform1f(this.uSpecularStrength, this.specularStrength)
    gl.uniform1f(this.uRLStrength, this.rlStrength)
    gl.uniform1f(this.uRLPhaseBuckets, RUNNING_LIGHT_TIMING_BUCKETS)
    gl.uniform1f(this.uBumpStrength, this.bumpStrength)
    gl.uniform1f(this.uRLFadeOut, 0.2)
    gl.uniform1f(this.uBumpSmooth, 1.5)
    gl.uniform1f(this.uBumpThreshold, 0.12)
    gl.uniform1f(this.uBumpScale, 1.0)
    gl.uniform2f(this.uTexel, 1 / 256, 1 / 256)
    gl.uniform1f(this.uReflectionTint, 0)
    gl.uniform1f(this.uShadowEnabled, (this._shadowFBO && !flat && this.shadowsEnabled) ? 1 : 0)
    // Graphics Options shadow controls — uShadowStrength scales the
    // self-shadow darkness, uSelfShadow gates it off entirely.  Both
    // multiply into the unit's shadow term in main.frag.
    gl.uniform1f(this.uShadowStrength, this.shadowStrength)
    gl.uniform1f(this.uSelfShadow, this.selfShadow ? 1 : 0)
    // Baseline specular scale — the per-batch draw loop overrides this
    // with each group's specScale (from hints-textures.js) for metal-
    // tagged groups when Surface Hints is on.  Set here so any main-
    // program draw that doesn't hit the per-group path still has a sane
    // (non-zero) value.
    gl.uniform1f(this.uSpecScale, 1.0)
    // Baseline the per-batch surface-hint effects off; the per-group draw
    // loop turns them on for the tiles that opt in (hints-textures.js).
    gl.uniform1f(this.uRunningLights, 0)
    gl.uniform1f(this.uLampMapValid, 0)
    gl.uniform1f(this.uRLEmit, 0)
    gl.uniform1f(this.uBump, 0)
    gl.uniform1f(this.uBumpIntensity, 0)
    // Phase 2 lighting LOD — when the per-entity flag is set the
    // shader skips rim / back-light / Blinn-Phong specular.  Set by
    // the entity loop in lockstep with the shadow LOD: any entity
    // small enough to skip the shadow pass also gets the cheap
    // lighting path (the visible difference is negligible at that
    // screen size).
    gl.uniform1f(this.uLightingTier, this._lightingTierCheap ? 1 : 0)
    gl.uniform1f(this.uShadowBias, 0.0025)
    // Sea bounce/shimmer: only paint onto the hull when the unit is
    // actually sitting on water AND we're in full studio mode.  Flat
    // and wireframe modes bypass it.
    gl.uniform1f(this.uSeaActive, (!flat && this.groundMode === 'sea') ? 1 : 0)
    gl.uniform1f(this.uMainTime, this._fxTimeSec())
    gl.uniform1f(this.uMainWaterY, this._getWaterY())
    gl.uniform1f(this.uMainWaterOnHull, this.optWaterReflections ? 1 : 0)
    gl.uniform1f(this.uMainWavesIntensity, this.optWaves ? this.wavesIntensity : 0.0)
    gl.uniform3fv(this.uMainTeamColor, this.teamColor || [0, 0, 1])
    gl.uniform1f(this.uMainTeamColorEnable, this.teamColorEnable ? 1 : 0)
    // Dynamic pulse lights — fed by setPulseLights() from the controller each
    // frame.  Unused slots upload range 0 so the shader skips them when no
    // weapon is firing.  Same uniforms in main + reflection passes so the
    // weapon glow reflects off water too.
    this.#uploadPulseLights(gl, this.uPulseLightPos, this.uPulseLightColor, this.uPulseLightRange, this.uPulseLightCount)
    // Unit centre + radius for the pulse-light self-occlusion test.
    // Centre = model bbox centroid translated by the unit transform
    // (so it follows a walking unit).  Radius = bbox diagonal/2 with
    // a small floor so vanishingly small units don't divide by zero.
    if (this.model && this.model.bounds) {
      const _b = this.model.bounds
      const _ut = this._unitTransform
      const _cx = (_b.min[0] + _b.max[0]) * 0.5 + (_ut ? _ut.x : 0)
      const _cy = (_b.min[1] + _b.max[1]) * 0.5 + (_ut ? _ut.y : 0)
      const _cz = (_b.min[2] + _b.max[2]) * 0.5 + (_ut ? _ut.z : 0)
      const _dx = _b.max[0] - _b.min[0], _dy = _b.max[1] - _b.min[1], _dz = _b.max[2] - _b.min[2]
      const _radius = Math.max(2, 0.5 * Math.hypot(_dx, _dy, _dz))
      gl.uniform3fv(this.uUnitCenter, [_cx, _cy, _cz])
      gl.uniform1f(this.uUnitRadius, _radius)
    } else {
      gl.uniform3fv(this.uUnitCenter, [0, 0, 0])
      gl.uniform1f(this.uUnitRadius, 10)
    }
    // Build-progress fade.  When buildPercent < 100, the textured
    // model renders at reduced alpha so the green nano-wireframe
    // overlay drawn afterwards reads cleanly; at 100 the texture
    // is fully opaque.  Cubic ease so the fade-in feels weighty
    // toward the end of construction rather than linearly bright.
    const _bp = (this.buildPercent ?? 100) / 100
    gl.uniform1f(this.uMainOutputAlpha, _bp * _bp * _bp)
    if (this._shadowFBO && !flat) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex)
      gl.uniform1i(this.uShadowMap, 1)
      // Bind the second light's shadow map regardless of whether
      // it's actively in use — the shader's branch on uLightColor2
      // determines whether the sample contributes.  Pointing the
      // sampler at a real texture (even if it's a stale frame's
      // content) keeps WebGL happy.
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex2 || this._shadowTex)
      gl.uniform1i(this.uShadowMap2, 3)
    }
    this.#drawGeometry(this.model.root, this._modelMatrix, false)
  }

  // #renderWireframe walks the piece tree and emits each piece's
  // wireframe VBO as GL_LINES.  WebGL's gl.lineWidth is widely
  // ignored by modern drivers (max width 1), so for any width > 1
  // we draw multiple passes with the line program's `uPixelOffset`
  // shoving each pass by ±1 pixel in screen space — a poor man's
  // "thick lines" that actually shows up cross-platform.
  #renderWireframe(color) {
    const gl = this.gl
    const width = Math.max(1, this.wireframeWidth | 0)
    gl.useProgram(this.programWire)
    gl.uniformMatrix4fv(this.uWireProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uWireView, false, this.camera.viewMatrix)
    gl.uniform4fv(this.uWireColor, color)
    try { gl.lineWidth(width) } catch { /* spec says only width 1 is required */ }
    const vw = gl.drawingBufferWidth || 1
    const vh = gl.drawingBufferHeight || 1
    const offsets = width <= 1 ? [[0, 0]] : this.#thickLineOffsets(width, vw, vh)
    const drawOnce = (piece, parent) => {
      if (!piece) return
      piece.computeWorldMatrix(parent, this._worldScratch)
      if (piece.visible && piece.wireframe) {
        gl.uniformMatrix4fv(this.uWireWorld, false, piece.worldMatrix)
        gl.bindBuffer(gl.ARRAY_BUFFER, piece.wireframe.vbo)
        gl.enableVertexAttribArray(this.aWirePos)
        gl.vertexAttribPointer(this.aWirePos, 3, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.LINES, 0, piece.wireframe.vertexCount)
      }
      for (const c of piece.children) drawOnce(c, piece.worldMatrix)
    }
    for (const [dx, dy] of offsets) {
      gl.uniform2f(this.uWirePixelOffset, dx, dy)
      drawOnce(this.model.root, this._modelMatrix)
    }
    gl.uniform2f(this.uWirePixelOffset, 0, 0)
  }

  // #thickLineOffsets returns a ring of NDC-space pixel offsets for
  // a given thickness.  Sample around the centre so 2 px → 5 passes
  // (centre + N/E/S/W), 3 px → 9, etc.  Each (dx, dy) is in NDC
  // (range -1..+1), so we divide pixel deltas by half the viewport.
  #thickLineOffsets(width, vw, vh) {
    const out = []
    const r = (width - 1) / 2
    const step = 1.0
    for (let dy = -r; dy <= r; dy += step) {
      for (let dx = -r; dx <= r; dx += step) {
        out.push([(dx * 2) / vw, (dy * 2) / vh])
      }
    }
    return out
  }

  // #drawGeometry walks the piece tree and issues one drawArrays per
  // draw group.  `shadowPass` toggles between the texture-aware main
  // shader and the depth-only shadow shader; both share the same VBO
  // layout (pos, normal, uv) so we only need to flip which attribute
  // pointers and uniforms get updated.
  #drawGeometry(rootPiece, parentWorld, shadowPass) {
    const gl = this.gl
    // Phase 2 LOD — when the renderer's `_lodHideFlares` flag is set
    // (by the entity loop for mid/far tier units), skip any piece
    // tagged `lodHide` at load time.  Cosmetic-only pieces (flares,
    // muzzles, exhausts) read as sub-pixel on a mid-distance unit
    // anyway, so we save the drawArrays per piece without a visible
    // change.  The hovered piece is exempt — the user explicitly
    // pointed at it, the highlight should still draw even at low LOD.
    const hideFlares = this._lodHideFlares
    const hoveredName = this._hoveredPieceName
    // Effect distance LOD — fade the per-fragment surface hints out as the
    // unit recedes (no point paying for bump's texture-space Sobel or the
    // running-lights neighbourhood scan on a tiny far unit).  Distance is
    // camera → this draw's world origin (parentWorld translation), which is
    // the unit position in both the single-unit viewer and per-entity
    // sandbox draws.  `fxSurf` (bump + specular) cuts first, `fxRL`
    // (running lights) a bit further; each ramps 1→0 across a short band.
    let fxSurf = 1, fxRL = 1
    if (!shadowPass) {
      const eye = this.camera ? this.camera.eye : [0, 0, 0]
      const dx = eye[0] - parentWorld[12]
      const dy = eye[1] - parentWorld[13]
      const dz = eye[2] - parentWorld[14]
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const fade = Math.max(1, EFFECT_LOD_FADE_WU)
      fxSurf = Math.max(0, Math.min(1, (EFFECT_LOD_SURFACE_MAX_WU - dist) / fade))
      fxRL = Math.max(0, Math.min(1, (EFFECT_LOD_RUNNINGLIGHTS_MAX_WU - dist) / fade))
    }
    // Piece-light override pre-check — most units have no overrides
    // at all, so a single Map.has() up front saves a per-piece lookup
    // on the entire tree.  The pulse phase reads off the renderer's
    // monotonically-advancing fx clock (same source the sea / sun-
    // motion uniforms use) so all entities pulse in lockstep without
    // needing per-entity state.
    const unitName = this.model && this.model.name
    const hasGlowOverrides = !shadowPass && hasOverridesFor(unitName)
    const glowTimeSec = hasGlowOverrides ? this._fxTimeSec() : 0
    const draw = (piece, parent) => {
      if (!piece) return
      piece.computeWorldMatrix(parent, this._worldScratch)
      const lodSkip = hideFlares && piece.lodHide
        && (!hoveredName || piece.name.toLowerCase() !== hoveredName)
      if (piece.visible && !lodSkip) {
        if (shadowPass) {
          gl.uniformMatrix4fv(this.uShadowWorld, false, piece.worldMatrix)
        } else {
          gl.uniformMatrix4fv(this.uWorld, false, piece.worldMatrix)
          // Per-piece glow override.  Most pieces have none → set to
          // zero alpha and the shader add-line is a no-op.  When an
          // override applies, bake the pulse intensity into the alpha
          // channel here so the shader stays branchless.
          if (hasGlowOverrides) {
            const ov = pieceLightFor(unitName, piece.name)
            if (ov) {
              const a = pulseAlpha(ov, glowTimeSec)
              gl.uniform4f(this.uPieceGlow, ov.color[0], ov.color[1], ov.color[2], a)
            } else {
              gl.uniform4f(this.uPieceGlow, 0, 0, 0, 0)
            }
          } else {
            gl.uniform4f(this.uPieceGlow, 0, 0, 0, 0)
          }
        }
        for (const group of piece.drawGroups) {
          gl.bindBuffer(gl.ARRAY_BUFFER, group.vbo)
          // Coplanar layers: apply a polygon offset proportional to
          // the group's tier so they win the depth test cleanly
          // instead of z-fighting against the base.  Tier 0 means
          // "first / base" — no offset.  Higher tiers nudge toward
          // the camera (negative factor & units).
          if (group.depthTier > 0) {
            gl.enable(gl.POLYGON_OFFSET_FILL)
            gl.polygonOffset(-group.depthTier, -group.depthTier)
          } else if (group.synthetic) {
            // FillModel reconstructed this face; it sits coplanar with the
            // artist's original geometry (e.g. the ARM Swatter nose cap on
            // the team-colour deck plane).  Push it away from the camera so
            // the real face always wins the depth test — no shimmer/z-fight.
            gl.enable(gl.POLYGON_OFFSET_FILL)
            gl.polygonOffset(1, 1)
          } else {
            gl.disable(gl.POLYGON_OFFSET_FILL)
          }
          if (shadowPass) {
            gl.enableVertexAttribArray(this.aShadowPos)
            gl.enableVertexAttribArray(this.aShadowUV)
            gl.vertexAttribPointer(this.aShadowPos, 3, gl.FLOAT, false, VERTEX_STRIDE, POS_OFFSET)
            gl.vertexAttribPointer(this.aShadowUV, 2, gl.FLOAT, false, VERTEX_STRIDE, UV_OFFSET)
            if (group.textureName && this.textureCache) {
              const entry = this.textureCache.get(group.textureName)
              gl.activeTexture(gl.TEXTURE0)
              gl.bindTexture(gl.TEXTURE_2D, entry.tex)
              gl.uniform1i(this.uShadowTex, 0)
              gl.uniform1i(this.uShadowMode, 0)
            } else {
              gl.uniform1i(this.uShadowMode, 1)
            }
          } else {
            gl.enableVertexAttribArray(this.aPos)
            gl.enableVertexAttribArray(this.aNormal)
            gl.enableVertexAttribArray(this.aUV)
            gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, VERTEX_STRIDE, POS_OFFSET)
            gl.vertexAttribPointer(this.aNormal, 3, gl.FLOAT, false, VERTEX_STRIDE, NRM_OFFSET)
            gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, VERTEX_STRIDE, UV_OFFSET)
            // aAO may bind to -1 if the driver optimised the attribute
            // away (e.g. when the AO term is dead-code-eliminated in
            // future shader changes) — guard the enable to stay safe.
            if (this.aAO >= 0) {
              gl.enableVertexAttribArray(this.aAO)
              gl.vertexAttribPointer(this.aAO, 1, gl.FLOAT, false, VERTEX_STRIDE, AO_OFFSET)
            }
            if (group.textureName && this.textureCache) {
              const entry = this.textureCache.get(group.textureName)
              gl.activeTexture(gl.TEXTURE0)
              gl.bindTexture(gl.TEXTURE_2D, entry.tex)
              gl.uniform1i(this.uTex, 0)
              gl.uniform1i(this.uMode, 0)
              // Texel step for texture-space bump sampling — from the real
              // tile dimensions so the relief tracks one texel exactly.
              gl.uniform2f(this.uTexel, 1 / (entry.width || 64), 1 / (entry.height || 64))
            } else if (group.color) {
              gl.uniform4fv(this.uTint, group.color)
              gl.uniform1i(this.uMode, 1)
            } else {
              gl.uniform4fv(this.uTint, [0.45, 0.45, 0.5, 1])
              gl.uniform1i(this.uMode, 1)
            }
            // Per-batch material hints (hints-textures.js), each behind its
            // own Graphics Options toggle so they're independently switchable:
            //   specScale     — metal sheen boost (>1 on metal tiles)   — Surface Hints
            //   runningLights — colour-keyed blinking emissive lamps    — Running Lights
            //   bump          — derivative auto-bump (needs deriv ext)  — Bump Mapping
            // Distance LOD (fxSurf / fxRL, computed once above): fade the
            // specular hint to 0 and skip the bump branch past the surface
            // cutoff, and skip the running-lights branch past its further
            // cutoff — so a far unit pays nothing for these per-fragment
            // effects.  Setting uBump / uRunningLights to 0 lets the shader
            // short-circuit the whole block, not just dim its output.
            const specBase = (this.optMetalSpec && group.metallic) ? (group.specScale || 1.0) : 1.0
            gl.uniform1f(this.uSpecScale, specBase * fxSurf)
            const rlOn = (this.optRunningLights && group.runningLights && fxRL > 0.01) ? 1 : 0
            gl.uniform1f(this.uRunningLights, rlOn)
            gl.uniform1f(this.uRLEmit, rlOn ? (group.rlEmit || 0) * fxRL : 0)
            gl.uniform1f(this.uRLFadeOut, (group.rlFadeOut != null) ? group.rlFadeOut : 0.2)
            // Running lights now read a CPU-built lamp atlas (texture-cache +
            // lamp-map.js): proximal/touching texels are grouped into one
            // component carrying a single dominant colour, so the whole lamp
            // shares one colour / phase / intensity.  The detection thresholds
            // (keyBright/keySat) + group radius (gap) are baked into the atlas
            // at build time; changing a slider mints a fresh atlas.  Bound to
            // TEXTURE4 (TEXTURE0=tex, 1/3=shadow maps) so it never clobbers
            // the unit texture or the shadow samplers.
            let lampValid = 0
            if (rlOn && this.textureCache && group.textureName) {
              const lm = this.textureCache.getLampMap(group.textureName, {
                keyBright: (group.rlKeyBright != null) ? group.rlKeyBright : 0.20,
                keySat: (group.rlKeySat != null) ? group.rlKeySat : 0.50,
                keyBrightHi: (group.rlKeyBrightHi != null) ? group.rlKeyBrightHi : 0.80,
                minRise: (group.rlMinRise != null) ? group.rlMinRise : 0.12,
                gapPx: (group.rlGap != null) ? group.rlGap : 0,
                colorMergePx: RUNNING_LIGHT_COLOR_MERGE_PX,
              })
              if (lm && lm.ready) {
                gl.activeTexture(gl.TEXTURE4)
                gl.bindTexture(gl.TEXTURE_2D, lm.tex)
                gl.uniform1i(this.uLampMap, 4)
                lampValid = 1
              }
            }
            gl.uniform1f(this.uLampMapValid, lampValid)
            const bumpOn = (this.optBump && group.bump && this._derivExt && fxSurf > 0.01) ? 1 : 0
            gl.uniform1f(this.uBump, bumpOn)
            gl.uniform1f(this.uBumpIntensity, bumpOn ? (group.bumpIntensity || 0) * fxSurf : 0)
            gl.uniform1f(this.uBumpSmooth, (group.bumpSmooth != null) ? group.bumpSmooth : 1.5)
            gl.uniform1f(this.uBumpThreshold, (group.bumpThreshold != null) ? group.bumpThreshold : 0.12)
            gl.uniform1f(this.uBumpScale, (group.bumpScale != null) ? group.bumpScale : 1.0)
          }
          gl.drawArrays(group.mode, 0, group.vertexCount)
        }
        // Reset polygon offset after each piece so it doesn't bleed
        // into subsequent unrelated draws (ground plane, etc.).
        gl.disable(gl.POLYGON_OFFSET_FILL)
      }
      for (const c of piece.children) draw(c, piece.worldMatrix)
    }
    draw(rootPiece, parentWorld)
  }

  // seaWaveSample mirrors GROUND_VS/FS's seaWaveHS() in plain JS so
  // the CPU can position the unit on the same surface the GPU draws.
  // Returns { h, dhx, dhz } — vertical offset plus partials.  Stay in
  // sync with SEA_WAVES_GLSL above; the boat's bobbing is built on
  // top of this and any drift between the two would float the unit
  // off the water.  Sampling the JS copy at the same (x, z, t) the
  // GPU does keeps the silhouette and the unit's heave consistent.
  seaWaveSample(x, z, t) {
    const p1x = x * 0.085, p1z = z * 0.085
    const p2x = x * 0.21, p2z = z * 0.21
    const p3x = x * 0.46, p3z = z * 0.46
    const p4x = x * 1.05, p4z = z * 1.05
    const p5x = x * 2.40, p5z = z * 2.40
    const ph1a = p1x * 0.97 + p1z * 0.21 + t * 0.42
    const ph1b = p1z * 1.05 - p1x * 0.18 - t * 0.36
    const ph2a = p2x * 0.78 - p2z * 0.62 + t * 0.80
    const ph2b = p2x * 0.21 + p2z * 0.93 - t * 0.72
    const ph3a = p3x * 1.13 + p3z * 0.71 + t * 1.55
    const ph3b = p3x * 0.42 - p3z * 1.07 + t * 1.30
    const ph4a = p4x * 1.31 + p4z * 0.87 + t * 2.30
    const ph4b = p4x * 0.55 - p4z * 1.21 + t * 2.65
    const ph5a = p5x * 0.93 + p5z * 0.47 + t * 3.85
    const ph5b = p5x * 0.27 - p5z * 1.11 + t * 4.20
    // Same gust envelope as GLSL — keeps the JS-sampled bob in sync
    // with the visible surface during the rougher patches.
    let gust = 1.0
             + 0.35 * Math.sin(x * 0.018 + t * 0.13) * Math.cos(z * 0.020 - t * 0.10)
             + 0.25 * Math.sin((x + z) * 0.013 + t * 0.07)
             + 0.15 * Math.cos(x * 0.031 - z * 0.024 + t * 0.19)
    if (gust < 0.55) gust = 0.55
    if (gust > 1.75) gust = 1.75
    const hRaw = Math.sin(ph1a) * 0.55 + Math.sin(ph1b) * 0.55
               + Math.sin(ph2a) * 0.42 + Math.sin(ph2b) * 0.32
               + Math.sin(ph3a) * 0.22 + Math.sin(ph3b) * 0.18
               + Math.sin(ph4a) * 0.10 + Math.sin(ph4b) * 0.10
               + Math.sin(ph5a) * 0.03 + Math.sin(ph5b) * 0.03
    const h = hRaw * gust
    const dhx = Math.cos(ph1a) * 0.97 * 0.085 * 0.55
              + Math.cos(ph1b) * (-0.18) * 0.085 * 0.55
              + Math.cos(ph2a) * 0.78 * 0.21 * 0.42
              + Math.cos(ph2b) * 0.21 * 0.21 * 0.32
              + Math.cos(ph3a) * 1.13 * 0.46 * 0.22
              + Math.cos(ph3b) * 0.42 * 0.46 * 0.18
              + Math.cos(ph4a) * 1.31 * 1.05 * 0.10
              + Math.cos(ph4b) * 0.55 * 1.05 * 0.10
              + Math.cos(ph5a) * 0.93 * 2.40 * 0.03
              + Math.cos(ph5b) * 0.27 * 2.40 * 0.03
    const dhz = Math.cos(ph1a) * 0.21 * 0.085 * 0.55
              + Math.cos(ph1b) * 1.05 * 0.085 * 0.55
              + Math.cos(ph2a) * (-0.62) * 0.21 * 0.42
              + Math.cos(ph2b) * 0.93 * 0.21 * 0.32
              + Math.cos(ph3a) * 0.71 * 0.46 * 0.22
              + Math.cos(ph3b) * (-1.07) * 0.46 * 0.18
              + Math.cos(ph4a) * 0.87 * 1.05 * 0.10
              + Math.cos(ph4b) * (-1.21) * 1.05 * 0.10
              + Math.cos(ph5a) * 0.47 * 2.40 * 0.03
              + Math.cos(ph5b) * (-1.11) * 2.40 * 0.03
    return { h, dhx: dhx * gust, dhz: dhz * gust }
  }

  // _applySeaBob composes T(0, h, 0) * Rx(pitch) * Rz(roll) onto a
  // matrix in place.  pitch comes from the surface slope along Z
  // (boat's nose dips into the trough), roll from the slope along X
  // (boat rolls toward the down-slope side).
  //
  // The bob is decoupled from the surface animation:
  //   * `tSlow = t * 0.75` — the boat rocks 25% slower than the
  //     visible wave train, so a battleship doesn't dart up and
  //     down like a buoy.
  //   * `BOB_SCALE = 0.30` — vertical heave and tilt are scaled to
  //     30% of the raw slope/height so even tall waves only nudge
  //     the unit.  A real ship's inertia damps high-frequency
  //     surface motion; this is the visual analogue.
  _applySeaBob(out, x, z, t) {
    // Speed multiplier scales the bob's time progression; default
    // 1.0 means the same 0.75× slowdown as before (the "0.75" inside
    // tSlow is the inherent damping for tall ships).
    const tSlow = t * 0.75 * this.bobSpeed
    const s = this.seaWaveSample(x, z, tSlow)
    // Amount multiplier scales the heave + tilt linearly.  When the
    // Waves toggle is off the boat still bobs from the static
    // sample at the same XZ — it would otherwise lurch when the
    // user flips waves back on with the unit at a wave crest.
    const BOB_SCALE = 0.30 * this.bobAmount
    const tilt = 0.55 * BOB_SCALE
    const pitch = Math.atan2(s.dhz, 1) * tilt
    const roll  = -Math.atan2(s.dhx, 1) * tilt
    Mat4.translate(out, out, 0, s.h * BOB_SCALE, 0)
    Mat4.rotateX(out, out, pitch)
    Mat4.rotateZ(out, out, roll)
  }

  // #updateLightMatrices builds the light's view + ortho projection
  // so the shadow map covers the entire model footprint plus a chunk
  // of the ground plane.  Light position is the model centroid pushed
  // back along the light direction; ortho extents follow the model's
  // bounding sphere.
  #updateLightMatrices() {
    let cx, cy, cz, r
    if (this._entities && this._entities.length > 0) {
      // Multi-entity (sandbox) mode — anchor the shadow frustum on the
      // camera target and clamp its half-extent (see SHADOW_FRUSTUM_*).
      // Enclosing every spawned unit, as an earlier revision did, let the
      // ortho box balloon with the spread of the field: each unit then
      // occupied only a few shadow-map texels (square shadows) and the
      // widened depth range outran the bias (peter-panning that reads as
      // the shadow sinking through the ground).  Following the camera with
      // a bounded window keeps the resolution high under the units the
      // user is actually looking at; faraway casters drop their shadow,
      // which the shadow-distance LOD already does anyway.
      const tgt = (this.camera && this.camera.target) || [0, 0, 0]
      cx = tgt[0]
      cy = tgt[1]
      cz = tgt[2]
      const camDist = (this.camera && this.camera.distance) || 200
      r = Math.min(SHADOW_FRUSTUM_MAX_WU, Math.max(SHADOW_FRUSTUM_MIN_WU, camDist * 0.45))
    } else {
      const min = this.model.bounds.min
      const max = this.model.bounds.max
      // Centre the shadow frustum on the unit's CURRENT world
      // position, not its model-local bounding box.  When the unit
      // walks via _unitTransform, the model vertices are translated
      // into world space at draw time but the shadow frustum has to
      // follow — otherwise a unit that walks ~50 wu from spawn ends
      // up outside the light's ortho frame and its shadow vanishes
      // (or, worse, gets pinned to the spawn point).  Adding
      // _unitTransform.{x,y,z} to the model-local centroid lands the
      // frustum on the unit no matter where it's walked to.
      const ut = this._unitTransform
      cx = (min[0] + max[0]) * 0.5 + (ut ? ut.x : 0)
      cy = (min[1] + max[1]) * 0.5 + (ut ? ut.y : 0)
      cz = (min[2] + max[2]) * 0.5 + (ut ? ut.z : 0)
      const dx = max[0] - min[0], dy = max[1] - min[1], dz = max[2] - min[2]
      const radius = 0.5 * Math.hypot(dx, dy, dz)
      // Pad so corners of the bounding box (rotated by auto-rotate yaw)
      // never fall outside the light's frustum.
      r = Math.max(2, radius * 1.6)
    }
    const dist = Math.max(r * 3, r + 5)
    const eye = [cx + this.lightDir[0] * dist, cy + this.lightDir[1] * dist, cz + this.lightDir[2] * dist]
    Mat4.lookAt(this._lightView, eye, [cx, cy, cz], [0, 1, 0])
    Mat4.ortho(this._lightProj, -r, r, -r, r, 0.1, dist + r * 2)
    Mat4.multiply(this._lightSpace, this._lightProj, this._lightView)
    // Same shadow-frustum math for the second light when it's
    // active.  Skipping it for single-sun worlds (lightColor2 zero)
    // saves the per-frame matrix work AND keeps the shadow pass
    // skip below cheap.
    const sun2Mag = this.lightColor2[0] + this.lightColor2[1] + this.lightColor2[2]
    if (sun2Mag > 0.001) {
      const eye2 = [cx + this.lightDir2[0] * dist, cy + this.lightDir2[1] * dist, cz + this.lightDir2[2] * dist]
      Mat4.lookAt(this._lightView2, eye2, [cx, cy, cz], [0, 1, 0])
      Mat4.ortho(this._lightProj2, -r, r, -r, r, 0.1, dist + r * 2)
      Mat4.multiply(this._lightSpace2, this._lightProj2, this._lightView2)
    }
  }

  // ── Shader/program setup ───────────────────────────────────────────

  #initMainProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programMain = prog
    const gl = this.gl
    this.aPos = gl.getAttribLocation(prog, 'aPos')
    this.aNormal = gl.getAttribLocation(prog, 'aNormal')
    this.aUV = gl.getAttribLocation(prog, 'aUV')
    this.aAO = gl.getAttribLocation(prog, 'aAO')
    this.uProj = gl.getUniformLocation(prog, 'uProj')
    this.uView = gl.getUniformLocation(prog, 'uView')
    this.uWorld = gl.getUniformLocation(prog, 'uWorld')
    this.uLightSpace = gl.getUniformLocation(prog, 'uLightSpace')
    this.uLightSpace2 = gl.getUniformLocation(prog, 'uLightSpace2')
    this.uTex = gl.getUniformLocation(prog, 'uTex')
    this.uShadowMap = gl.getUniformLocation(prog, 'uShadowMap')
    this.uShadowMap2 = gl.getUniformLocation(prog, 'uShadowMap2')
    this.uMode = gl.getUniformLocation(prog, 'uMode')
    this.uTint = gl.getUniformLocation(prog, 'uTint')
    this.uLightDir = gl.getUniformLocation(prog, 'uLightDir')
    this.uLightColor = gl.getUniformLocation(prog, 'uLightColor')
    this.uLightDir2 = gl.getUniformLocation(prog, 'uLightDir2')
    this.uLightColor2 = gl.getUniformLocation(prog, 'uLightColor2')
    this.uSkyColorMain = gl.getUniformLocation(prog, 'uSkyColor')
    this.uGroundColor = gl.getUniformLocation(prog, 'uGroundColor')
    this.uMainEyePos = gl.getUniformLocation(prog, 'uEyePos')
    this.uMainFillColor = gl.getUniformLocation(prog, 'uFillColor')
    this.uMainBackColor = gl.getUniformLocation(prog, 'uBackColor')
    this.uShadowEnabled = gl.getUniformLocation(prog, 'uShadowEnabled')
    this.uShadowBias = gl.getUniformLocation(prog, 'uShadowBias')
    this.uShadowStrength = gl.getUniformLocation(prog, 'uShadowStrength')
    this.uSelfShadow = gl.getUniformLocation(prog, 'uSelfShadow')
    this.uSpecScale = gl.getUniformLocation(prog, 'uSpecScale')
    this.uSpecularEnabled = gl.getUniformLocation(prog, 'uSpecularEnabled')
    this.uSpecularStrength = gl.getUniformLocation(prog, 'uSpecularStrength')
    // Surface-hint uniforms — running-lights + auto-bump.  These were
    // being SET every draw (uniform1f) but never LOOKED UP here, so the
    // location was undefined and every set was a silent no-op — the shader
    // kept uRunningLights/uBump at 0 and neither effect ever ran.
    this.uRunningLights = gl.getUniformLocation(prog, 'uRunningLights')
    this.uRLEmit = gl.getUniformLocation(prog, 'uRLEmit')
    this.uRLStrength = gl.getUniformLocation(prog, 'uRLStrength')
    this.uRLFadeOut = gl.getUniformLocation(prog, 'uRLFadeOut')
    this.uRLPhaseBuckets = gl.getUniformLocation(prog, 'uRLPhaseBuckets')
    this.uLampMap = gl.getUniformLocation(prog, 'uLampMap')
    this.uLampMapValid = gl.getUniformLocation(prog, 'uLampMapValid')
    this.uBump = gl.getUniformLocation(prog, 'uBump')
    this.uBumpIntensity = gl.getUniformLocation(prog, 'uBumpIntensity')
    this.uBumpStrength = gl.getUniformLocation(prog, 'uBumpStrength')
    this.uBumpSmooth = gl.getUniformLocation(prog, 'uBumpSmooth')
    this.uBumpThreshold = gl.getUniformLocation(prog, 'uBumpThreshold')
    this.uBumpScale = gl.getUniformLocation(prog, 'uBumpScale')
    this.uTexel = gl.getUniformLocation(prog, 'uTexel')
    this.uFlatLighting = gl.getUniformLocation(prog, 'uFlatLighting')
    this.uExposure = gl.getUniformLocation(prog, 'uExposure')
    this.uReflectionTint = gl.getUniformLocation(prog, 'uReflectionTint')
    this.uSeaActive = gl.getUniformLocation(prog, 'uSeaActive')
    this.uMainTime = gl.getUniformLocation(prog, 'uTime')
    this.uMainWaterY = gl.getUniformLocation(prog, 'uWaterY')
    this.uMainWavesIntensity = gl.getUniformLocation(prog, 'uWavesIntensity')
    this.uMainWaterOnHull = gl.getUniformLocation(prog, 'uWaterOnHull')
    this.uMainTeamColor = gl.getUniformLocation(prog, 'uTeamColor')
    this.uMainTeamColorEnable = gl.getUniformLocation(prog, 'uTeamColorEnable')
    // Dynamic pulse-lights (weapon SFX) — set each frame by the controller via
    // setPulseLights().  The bare-name location addresses element 0 of each
    // uniform array; uniform3fv/uniform1fv then fill all MAX_PULSE_LIGHTS
    // slots.  Empty slots upload range 0 so the shader's gate skips them.
    this.uPulseLightPos = gl.getUniformLocation(prog, 'uPulseLightPos[0]')
    this.uPulseLightColor = gl.getUniformLocation(prog, 'uPulseLightColor[0]')
    this.uPulseLightRange = gl.getUniformLocation(prog, 'uPulseLightRange[0]')
    this.uPulseLightCount = gl.getUniformLocation(prog, 'uPulseLightCount')
    // Unit centre + radius — pulse light uses them for self-shadowing
    // so the projectile light doesn't bleed through to the unit's
    // opposite side.
    this.uUnitCenter = gl.getUniformLocation(prog, 'uUnitCenter')
    this.uUnitRadius = gl.getUniformLocation(prog, 'uUnitRadius')
    // Per-piece glow override — see piece-light-overrides.js.  Default
    // zero alpha at the start of each entity's draw so any piece that
    // doesn't carry an override emits no glow.
    this.uPieceGlow = gl.getUniformLocation(prog, 'uPieceGlow')
    this.uMainOutputAlpha = gl.getUniformLocation(prog, 'uOutputAlpha')
    // Phase 2 lighting LOD — 0 = full (rim + back/fill + Blinn-Phong
    // specular), 1 = cheap (Lambertian + ambient only).  Set by the
    // entity loop per-entity based on the shadow LOD decision.
    this.uLightingTier = gl.getUniformLocation(prog, 'uLightingTier')
  }

  #initShadowProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programShadow = prog
    const gl = this.gl
    this.aShadowPos = gl.getAttribLocation(prog, 'aPos')
    this.aShadowUV = gl.getAttribLocation(prog, 'aUV')
    this.uShadowLightSpace = gl.getUniformLocation(prog, 'uLightSpace')
    this.uShadowWorld = gl.getUniformLocation(prog, 'uWorld')
    this.uShadowTex = gl.getUniformLocation(prog, 'uTex')
    this.uShadowMode = gl.getUniformLocation(prog, 'uMode')
  }

  #initSkyProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programSky = prog
    const gl = this.gl
    this.aSkyPos = gl.getAttribLocation(prog, 'aPos')
    this.uSkyInvVP    = gl.getUniformLocation(prog, 'uInvViewProj')
    this.uSkyEyePos   = gl.getUniformLocation(prog, 'uEyePos')
    this.uSkyZenith   = gl.getUniformLocation(prog, 'uZenith')
    this.uSkyHorizon  = gl.getUniformLocation(prog, 'uHorizon')
    this.uSkySun1Col  = gl.getUniformLocation(prog, 'uSun1Color')
    this.uSkySun1Dir  = gl.getUniformLocation(prog, 'uSun1Dir')
    this.uSkySun1Size = gl.getUniformLocation(prog, 'uSun1Size')
    this.uSkySun2Col  = gl.getUniformLocation(prog, 'uSun2Color')
    this.uSkySun2Dir  = gl.getUniformLocation(prog, 'uSun2Dir')
    this.uSkySun2Size = gl.getUniformLocation(prog, 'uSun2Size')
    this.uSkyCloudCol = gl.getUniformLocation(prog, 'uCloudColor')
    this.uSkyCloudShd = gl.getUniformLocation(prog, 'uCloudShadow')
    this.uSkyCloudCov = gl.getUniformLocation(prog, 'uCloudCoverage')
    this.uSkyCloudDen = gl.getUniformLocation(prog, 'uCloudDensity')
    this.uSkyCloudSpd = gl.getUniformLocation(prog, 'uCloudSpeed')
    this.uSkyTime     = gl.getUniformLocation(prog, 'uTime')
    this.uSkyOptGodBeams = gl.getUniformLocation(prog, 'uOptGodBeams')
    // Full-screen triangle pair in NDC.
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, 1, 1,
      -1, -1, 1, 1, -1, 1,
    ]), gl.STATIC_DRAW)
    this._skyVBO = buf
    // Scratch matrices for inv(view-proj) computation each frame.
    this._invProj = Mat4.create()
    this._invView = Mat4.create()
    this._invVP   = Mat4.create()
  }

  #initGroundProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programGround = prog
    const gl = this.gl
    this.aGroundPos = gl.getAttribLocation(prog, 'aPos')
    this.uGroundProj = gl.getUniformLocation(prog, 'uProj')
    this.uGroundView = gl.getUniformLocation(prog, 'uView')
    this.uGroundLightSpace = gl.getUniformLocation(prog, 'uLightSpace')
    this.uGroundLightSpace2 = gl.getUniformLocation(prog, 'uLightSpace2')
    this.uGroundShadowMap = gl.getUniformLocation(prog, 'uShadowMap')
    this.uGroundShadowMap2 = gl.getUniformLocation(prog, 'uShadowMap2')
    this.uGroundShadowEnabled = gl.getUniformLocation(prog, 'uShadowEnabled')
    this.uGroundShadowStrength = gl.getUniformLocation(prog, 'uShadowStrength')
    this.uGroundLightColor2 = gl.getUniformLocation(prog, 'uLightColor2')
    this.uGroundColorA = gl.getUniformLocation(prog, 'uColorA')
    this.uGroundColorB = gl.getUniformLocation(prog, 'uColorB')
    this.uGroundCenter = gl.getUniformLocation(prog, 'uCenter')
    this.uGroundRadius = gl.getUniformLocation(prog, 'uRadius')
    this.uGroundY = gl.getUniformLocation(prog, 'uGroundY')
    this.uGroundModeId = gl.getUniformLocation(prog, 'uGroundMode')
    this.uGroundTileSize = gl.getUniformLocation(prog, 'uTileSize')
    this.uGroundTerrainReady = gl.getUniformLocation(prog, 'uTerrainReady')
    this.uGroundTerrainTex = gl.getUniformLocation(prog, 'uTerrainTex')
    this.uGroundTime = gl.getUniformLocation(prog, 'uTime')
    this.uGroundExposure = gl.getUniformLocation(prog, 'uExposure')
    this.uGroundSunTint = gl.getUniformLocation(prog, 'uSunTint')
    this.uGroundLightDir = gl.getUniformLocation(prog, 'uLightDir')
    this.uGroundEyePos = gl.getUniformLocation(prog, 'uEyePos')
    this.uGroundSeabedY = gl.getUniformLocation(prog, 'uSeabedY')
    this.uGroundSeabedActive = gl.getUniformLocation(prog, 'uSeabedActive')
    this.uGroundHorizonColor = gl.getUniformLocation(prog, 'uHorizonColor')
    this.uGroundOptWaterReflections = gl.getUniformLocation(prog, 'uOptWaterReflections')
    this.uGroundOptSpecular = gl.getUniformLocation(prog, 'uOptSpecular')
    this.uGroundWavesIntensity = gl.getUniformLocation(prog, 'uWavesIntensity')
    this.uGroundWaterShallow = gl.getUniformLocation(prog, 'uWaterShallow')
    this.uGroundWaterMid = gl.getUniformLocation(prog, 'uWaterMid')
    this.uGroundWaterDeep = gl.getUniformLocation(prog, 'uWaterDeep')
    this.uGroundWaterTranslucency = gl.getUniformLocation(prog, 'uWaterTranslucency')
    this.uGroundSeabedSand = gl.getUniformLocation(prog, 'uSeabedSand')
    this.uGroundSeabedRock = gl.getUniformLocation(prog, 'uSeabedRock')
    this.uGroundSeabedCaustic = gl.getUniformLocation(prog, 'uSeabedCaustic')
    // Background mountain uniforms — paired with state on the renderer
    // instance.  When optBgTerrain is false, uMountainActive is sent
    // as 0 and the vertex shader short-circuits the displacement.
    this.uGroundClearCenter = gl.getUniformLocation(prog, 'uClearCenter')
    this.uGroundClearRadius = gl.getUniformLocation(prog, 'uClearRadius')
    this.uGroundClearFalloff = gl.getUniformLocation(prog, 'uClearFalloff')
    this.uGroundMountainHeight = gl.getUniformLocation(prog, 'uMountainHeight')
    this.uGroundMountainScale = gl.getUniformLocation(prog, 'uMountainScale')
    this.uGroundMountainActive = gl.getUniformLocation(prog, 'uMountainActive')
    this.uGroundMountainStyle = gl.getUniformLocation(prog, 'uMountainStyle')
    this.uGroundMountainBase = gl.getUniformLocation(prog, 'uMountainBase')
    this.uGroundMountainPeak = gl.getUniformLocation(prog, 'uMountainPeak')
    this.uGroundMountainGloss = gl.getUniformLocation(prog, 'uMountainGloss')
    this.uGroundSeabedHeightMul = gl.getUniformLocation(prog, 'uSeabedHeightMul')
    this.uGroundSeabedScaleMul = gl.getUniformLocation(prog, 'uSeabedScaleMul')
    this.uGroundSeabedRockChance = gl.getUniformLocation(prog, 'uSeabedRockChance')
    // Dynamic pulse-lights — same set as the main shader, lets weapon SFX
    // (tracer shells, d-gun, lasers) tint the terrain beneath them.  Set in
    // #renderGround from this._pulseLights which the controller updates per
    // frame via setPulseLights().  Bare-name location addresses array element
    // 0 so the *fv upload fills every slot.
    this.uGroundPulseLightPos = gl.getUniformLocation(prog, 'uPulseLightPos[0]')
    this.uGroundPulseLightColor = gl.getUniformLocation(prog, 'uPulseLightColor[0]')
    this.uGroundPulseLightRange = gl.getUniformLocation(prog, 'uPulseLightRange[0]')
    this.uGroundPulseLightCount = gl.getUniformLocation(prog, 'uPulseLightCount')
    // Lazy-allocate; #renderGround sizes the quad on each draw to keep
    // it large enough for the current model.  For now, a 400×400 plane
    // at y=0 works for every TA unit (largest mass is the Krogoth at
    // ~60 world units across).
    // Tessellated sea-plane.  The grid extends to ~2.5 km on a side
    // so the water + seabed reach the horizon; tessellation is dense
    // near the centre and exponentially coarser at the edge so the
    // GPU only pays for waves where the camera can actually see them.
    //   * Inner ring (~600 wu radius) — fine vertices, sharp swells.
    //   * Outer rings — coarse vertices, faked flat at distance.
    // Non-uniform mapping: cube the parameter t∈[-1,1] so spacing
    // near 0 is tight and spacing near ±1 is loose.  Total ~96² ≈
    // 9k quads, well within mobile budgets.
    const half = 2500
    const N = 96
    const verts = []
    // Build a 1-D ramp of x coordinates with cubic spacing.
    const xs = new Array(N + 1)
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * 2 - 1               // -1..1
      xs[i] = Math.sign(t) * Math.pow(Math.abs(t), 2.4) * half
    }
    for (let j = 0; j < N; j++) {
      const z0 = xs[j], z1 = xs[j + 1]
      for (let i = 0; i < N; i++) {
        const x0 = xs[i], x1 = xs[i + 1]
        verts.push(x0, 0, z0,  x1, 0, z0,  x1, 0, z1)
        verts.push(x0, 0, z0,  x1, 0, z1,  x0, 0, z1)
      }
    }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW)
    this._groundVBO = buf
    this._groundVertexCount = verts.length / 3
  }

  #initWireProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programWire = prog
    const gl = this.gl
    this.aWirePos = gl.getAttribLocation(prog, 'aPos')
    this.uWireProj = gl.getUniformLocation(prog, 'uProj')
    this.uWireView = gl.getUniformLocation(prog, 'uView')
    this.uWireWorld = gl.getUniformLocation(prog, 'uWorld')
    this.uWireColor = gl.getUniformLocation(prog, 'uColor')
    this.uWirePixelOffset = gl.getUniformLocation(prog, 'uPixelOffset')
  }

  // #initParticlesProgram links the COB-SFX particle program and
  // allocates the interleaved-attribute VBO the per-frame upload
  // streams into.  Layout: pos(3) + color(4) + size(1) = 8 floats
  // per particle.  Sized for an initial capacity of 1024 particles
  // — the upload path grows the buffer if a frame ever wants more.
  #initParticlesProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programParticles = prog
    const gl = this.gl
    this.aPartPos = gl.getAttribLocation(prog, 'aPos')
    this.aPartColor = gl.getAttribLocation(prog, 'aColor')
    this.aPartSize = gl.getAttribLocation(prog, 'aSize')
    this.uPartProj = gl.getUniformLocation(prog, 'uProj')
    this.uPartView = gl.getUniformLocation(prog, 'uView')
    this.uPartViewport = gl.getUniformLocation(prog, 'uViewport')
    this._partCapacity = 1024
    this._partInterleaved = new Float32Array(this._partCapacity * 8)
    this._partVBO = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this._partVBO)
    gl.bufferData(gl.ARRAY_BUFFER, this._partInterleaved.byteLength, gl.DYNAMIC_DRAW)
  }

  // setParticlePool attaches a CobBinding's ParticlePool to the
  // renderer.  Per-frame the renderer ticks the pool against the
  // frame dt + uploads the alive prefix to the GPU and draws.
  // Detach by passing null when the unit changes.
  setParticlePool(pool) { this._particlePool = pool || null }

  // #initImpostorProgram — Phase 3 far-tier batch.  Each entity below
  // TIER_MID_MIN_PX (≈ 12 px on screen) collapses to a single
  // GL_POINTS sprite of its team / fallback colour.  All impostors
  // share one buffer + one drawArrays per frame, so the cost of 100
  // far-away units is one upload + one draw call rather than 100×
  // geometry walks.
  //
  // Layout per impostor: pos(3) + color(3) + size(1) = 7 floats.
  // Initial capacity 256 (a typical sandbox spawns 10-50 units; growth
  // doubles on overflow).  DYNAMIC_DRAW because the batch is rebuilt
  // every frame from the entity loop.
  #initImpostorProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programImpostor = prog
    const gl = this.gl
    this.aImpPos = gl.getAttribLocation(prog, 'aPos')
    this.aImpColor = gl.getAttribLocation(prog, 'aColor')
    this.aImpSize = gl.getAttribLocation(prog, 'aSize')
    this.uImpProj = gl.getUniformLocation(prog, 'uProj')
    this.uImpView = gl.getUniformLocation(prog, 'uView')
    this._impCapacity = 256
    this._impInterleaved = new Float32Array(this._impCapacity * 7)
    this._impCount = 0
    this._impVBO = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this._impVBO)
    gl.bufferData(gl.ARRAY_BUFFER, this._impInterleaved.byteLength, gl.DYNAMIC_DRAW)
  }

  // _impostorPush — append one entity into the impostor batch.
  // Called from the main entity loop when the LOD classifier put
  // this entity in Far tier.  Grows the backing buffer if needed
  // (doubling) — pretty cheap since these are 7-float-wide records.
  //
  // Selected far-tier entities flicker: on half the cycle they're
  // pushed normally, off the other half they're skipped entirely.
  // The blink rate is SELECTED_IMPOSTOR_FLICKER_MS from
  // performance.js (default ~0.8 s full cycle).  Wall-clock so the
  // flicker stays visible regardless of sim speed.
  _impostorPush(ent) {
    const m = ent.model
    if (!m || !m.boundsCentre || !(m.boundsRadius > 0)) return
    // Selection flicker.  Selected far units want to read as
    // "selected at a glance" without their geometry or ring — we
    // toggle the impostor every half-cycle.  Unselected entities
    // skip the time check entirely.
    if (ent.selected) {
      const now = performance.now()
      const phase = (now % SELECTED_IMPOSTOR_FLICKER_MS) < (SELECTED_IMPOSTOR_FLICKER_MS * 0.5)
      if (!phase) return
    }
    if (this._impCount >= this._impCapacity) {
      const next = this._impCapacity * 2
      const grown = new Float32Array(next * 7)
      grown.set(this._impInterleaved.subarray(0, this._impCount * 7))
      this._impInterleaved = grown
      this._impCapacity = next
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this._impVBO)
      this.gl.bufferData(this.gl.ARRAY_BUFFER, grown.byteLength, this.gl.DYNAMIC_DRAW)
    }
    const t = ent.transform || _IDENTITY_T
    const cx = t.x + m.boundsCentre[0]
    const cy = t.y + m.boundsCentre[1]
    const cz = t.z + m.boundsCentre[2]
    // Pixel size for the sprite — clamped to the [4, 16] band so even
    // the smallest units stay visible and the biggest don't dominate.
    // The classifier already decided this entity is sub-12 px; we
    // pick a fixed visible size proportional to bounding-sphere
    // radius so a Krogoth's dot reads larger than a flea's.
    const r = m.boundsRadius
    const px = Math.max(4, Math.min(16, r * 0.35))
    // Colour: prefer the entity's side colour resolved through
    // displayRgbForSide so the user can tell teams apart at a
    // glance.  Falls back to ent.teamColor (legacy callers that
    // still set the hue-shift tuple directly) and finally to a
    // neutral grey for entities that carry neither side nor
    // teamColor.
    let rgb
    if (ent.side != null) rgb = displayRgbForSide(ent.side)
    else if (ent.teamColor) rgb = ent.teamColor
    else rgb = [0.80, 0.80, 0.85]
    const off = this._impCount * 7
    const buf = this._impInterleaved
    buf[off]     = cx
    buf[off + 1] = cy
    buf[off + 2] = cz
    buf[off + 3] = rgb[0]
    buf[off + 4] = rgb[1]
    buf[off + 5] = rgb[2]
    buf[off + 6] = px
    this._impCount += 1
  }

  // #renderImpostorBatch — one drawArrays(POINTS) per frame for every
  // far-tier entity pushed by the main entity loop.  Runs AFTER the
  // entity loop + selection-ring pass so impostors composite over
  // the ground but under particles + UI.
  #renderImpostorBatch() {
    const gl = this.gl
    if (this._impCount === 0 || !this.programImpostor) return
    gl.useProgram(this.programImpostor)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._impVBO)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this._impInterleaved.subarray(0, this._impCount * 7))
    const stride = 7 * 4
    gl.enableVertexAttribArray(this.aImpPos)
    gl.vertexAttribPointer(this.aImpPos, 3, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(this.aImpColor)
    gl.vertexAttribPointer(this.aImpColor, 3, gl.FLOAT, false, stride, 3 * 4)
    gl.enableVertexAttribArray(this.aImpSize)
    gl.vertexAttribPointer(this.aImpSize, 1, gl.FLOAT, false, stride, 6 * 4)
    gl.uniformMatrix4fv(this.uImpProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uImpView, false, this.camera.viewMatrix)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(false) // sprites don't write depth — keeps overlapping ones from popping each other
    gl.drawArrays(gl.POINTS, 0, this._impCount)
    gl.depthMask(true)
    gl.disableVertexAttribArray(this.aImpPos)
    gl.disableVertexAttribArray(this.aImpColor)
    gl.disableVertexAttribArray(this.aImpSize)
  }

  // #renderSelectionRings draws a unit-square line-loop on the ground
  // plane per entity flagged `selected: true`.  Square scales with the
  // unit's XZ bounding-box radius + a small pad so the outline reads
  // as "this is the unit you've clicked".  The square ROTATES with
  // the unit (entity.transform.headingRad) so its near edge always
  // faces the unit's forward — a directional cue that the user has
  // selected a unit pointing this way.  GL_LINE_LOOP, single uWireWorld
  // per entity, no pixel-thickening pass (hairline by design).
  //
  // Cheap: 4 vertices × N selected units × one uniform write each.
  // For 50 units that's 200 verts, well under the cost of one main
  // pass on a single unit.
  #renderSelectionRings(entities) {
    if (!entities || !entities.length) return
    if (!this.programWire) return
    const gl = this.gl
    // Lazy-build the unit-square VBO (4 corners on the ground plane,
    // ±0.5 wu — actual unit footprint comes from per-entity scale in
    // the uWireWorld matrix).  Re-used every frame; cheap to keep
    // resident.
    if (!this._selRingVBO) {
      const v = new Float32Array([
        -0.5, 0, -0.5,
         0.5, 0, -0.5,
         0.5, 0,  0.5,
        -0.5, 0,  0.5,
      ])
      this._selRingVBO = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, this._selRingVBO)
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW)
    }
    // Identify selected, non-ghost entries.  Skip the work entirely
    // when none match — avoids program switch + buffer bind for the
    // common "no selection" case.
    let count = 0
    for (const ent of entities) {
      if (ent.selected && !ent.ghost && ent._lodTier !== LOD_TIER_FAR) count++
    }
    if (count === 0) return
    gl.useProgram(this.programWire)
    gl.uniformMatrix4fv(this.uWireProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uWireView, false, this.camera.viewMatrix)
    gl.uniform2f(this.uWirePixelOffset, 0, 0)
    // ARM-green hairline.  Slight transparency keeps the ring from
    // drowning out the unit underneath; depth still on so taller
    // foreground geometry (cliffs, other units) properly occludes.
    gl.uniform4f(this.uWireColor, 0.25, 1.0, 0.40, 0.95)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._selRingVBO)
    gl.enableVertexAttribArray(this.aWirePos)
    gl.vertexAttribPointer(this.aWirePos, 3, gl.FLOAT, false, 0, 0)
    // Reusable scratch matrix — populated per-entity by ring math.
    if (!this._selRingMat) this._selRingMat = Mat4.identity(Mat4.create())
    const mat = this._selRingMat
    for (const ent of entities) {
      if (!ent.selected || ent.ghost) continue
      // Skip the ring on far-tier selected units — the flickering
      // impostor dot is the selection indicator at that zoom level.
      if (ent._lodTier === LOD_TIER_FAR) continue
      const t = ent.transform || { x: 0, y: 0, z: 0, headingRad: 0 }
      // Ring radius — derived from the model's XZ bounding box plus
      // a small absolute pad so even tiny units (PeeWees) get a
      // visible ring instead of a single pixel.  Falls back to a
      // sensible default when the model has no bounds yet.
      const b = ent.model && ent.model.bounds
      let radius = 12
      if (b && b.min && b.max) {
        const dx = b.max[0] - b.min[0]
        const dz = b.max[2] - b.min[2]
        radius = 0.5 * Math.max(dx, dz) + 4
      }
      // World matrix built inline as translate × rotateY × scale.
      // Column-major layout (glMatrix convention): the upper-left 3×3
      // holds rotateY composed with non-uniform scale (2r on X/Z, 1
      // on Y so the ground square keeps height 0); the last column
      // holds the world-space translation.  Y nudged slightly above
      // the ground plane so the line clears the grid texture without
      // z-fighting.  Mat4 doesn't ship a scale() helper, and chaining
      // identity → translate → rotateY → manual-scale would duplicate
      // matrix multiplies for what amounts to four scalar writes —
      // worth inlining at the cost of one comment block.
      const heading = +t.headingRad || 0
      const s = Math.sin(heading), c = Math.cos(heading)
      const r2 = radius * 2
      mat[0] =  c * r2; mat[1] = 0;  mat[2]  = -s * r2; mat[3]  = 0
      mat[4] =  0;      mat[5] = 1;  mat[6]  =  0;      mat[7]  = 0
      mat[8] =  s * r2; mat[9] = 0;  mat[10] =  c * r2; mat[11] = 0
      mat[12] = +t.x || 0; mat[13] = 0.25; mat[14] = +t.z || 0; mat[15] = 1
      gl.uniformMatrix4fv(this.uWireWorld, false, mat)
      gl.drawArrays(gl.LINE_LOOP, 0, 4)
    }
  }

  // #renderParticles emits the alive prefix of the pool as a single
  // additive-blended GL_POINTS draw.  Called after the main scene
  // pass so particles composite over the unit/ground.  Skipped when
  // no pool is bound or it's empty.
  #renderParticles() {
    const pool = this._particlePool
    if (!pool || pool.count === 0 || !this.programParticles) return
    const gl = this.gl
    // Grow the interleaved buffer if the pool overflowed our capacity.
    if (pool.count > this._partCapacity) {
      while (this._partCapacity < pool.count) this._partCapacity *= 2
      this._partInterleaved = new Float32Array(this._partCapacity * 8)
      gl.bindBuffer(gl.ARRAY_BUFFER, this._partVBO)
      gl.bufferData(gl.ARRAY_BUFFER, this._partInterleaved.byteLength, gl.DYNAMIC_DRAW)
    }
    // Pack alive particles into the interleaved layout the shader
    // attributes expect: [px, py, pz, r, g, b, a, size] × N.
    const data = this._partInterleaved
    for (let i = 0; i < pool.count; i++) {
      const o = i * 8
      data[o + 0] = pool.x[i]
      data[o + 1] = pool.y[i]
      data[o + 2] = pool.z[i]
      data[o + 3] = pool.r[i]
      data[o + 4] = pool.g[i]
      data[o + 5] = pool.b[i]
      data[o + 6] = pool.a[i]
      data[o + 7] = pool.size[i]
    }
    gl.useProgram(this.programParticles)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._partVBO)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, pool.count * 8))
    const STRIDE = 8 * 4
    gl.enableVertexAttribArray(this.aPartPos)
    gl.vertexAttribPointer(this.aPartPos, 3, gl.FLOAT, false, STRIDE, 0)
    gl.enableVertexAttribArray(this.aPartColor)
    gl.vertexAttribPointer(this.aPartColor, 4, gl.FLOAT, false, STRIDE, 3 * 4)
    gl.enableVertexAttribArray(this.aPartSize)
    gl.vertexAttribPointer(this.aPartSize, 1, gl.FLOAT, false, STRIDE, 7 * 4)
    gl.uniformMatrix4fv(this.uPartProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uPartView, false, this.camera.viewMatrix)
    gl.uniform2f(this.uPartViewport, gl.drawingBufferWidth, gl.drawingBufferHeight)
    // Premultiplied-alpha additive blend: src * 1 + dst * 1.
    // The shader already pre-multiplies colour by alpha (colour-
    // values stay >1 for bright effects so they self-clamp at the
    // tone-map).  Switching from SRC_ALPHA / ONE_MINUS_SRC_ALPHA
    // means smoke puffs no longer OCCLUDE the bright projectile
    // and beam particles behind them — lasers / d-gun / sparks
    // shine through clouds the way they do in the original game.
    // Smoke colour values are < 1 so its additive contribution
    // just hazes the background slightly instead of going opaque.
    // Depth test stays on, depth write OFF so particles don't
    // pollute the depth buffer (would interfere with DoF post-FX).
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.depthMask(false)
    gl.drawArrays(gl.POINTS, 0, pool.count)
    gl.depthMask(true)
    // Reset to the studio's default alpha blend so anything drawn
    // after this pass (currently nothing, but defensive in case the
    // pipeline gains a post-pass) starts from a known state.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  // #initSpritesProgram links the animated-bitmap projectile shader and
  // allocates the interleaved-attribute VBO for the per-frame upload.
  // Layout: pos(3) + color(4) + size(1) + uvRect(4) = 12 floats per
  // particle.  Initial capacity matches the regular particle pool; the
  // upload path grows the buffer if a frame ever needs more.
  //
  // Sprites are batched by spriteId — one draw call per unique atlas
  // texture in flight.  Stock TA only ever has color=1 and color=2 in
  // play at once (PlasmaSm + PlasmaMd), so the typical batch count
  // stays at 1-2 draw calls per frame.
  #initSpritesProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programSprites = prog
    const gl = this.gl
    this.aSprPos = gl.getAttribLocation(prog, 'aPos')
    this.aSprColor = gl.getAttribLocation(prog, 'aColor')
    this.aSprSize = gl.getAttribLocation(prog, 'aSize')
    this.aSprUvRect = gl.getAttribLocation(prog, 'aUvRect')
    this.uSprProj = gl.getUniformLocation(prog, 'uProj')
    this.uSprView = gl.getUniformLocation(prog, 'uView')
    this.uSprViewport = gl.getUniformLocation(prog, 'uViewport')
    this.uSprAtlas = gl.getUniformLocation(prog, 'uAtlas')
    this._sprCapacity = 256
    this._sprInterleaved = new Float32Array(this._sprCapacity * 12)
    this._sprVBO = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this._sprVBO)
    gl.bufferData(gl.ARRAY_BUFFER, this._sprInterleaved.byteLength, gl.DYNAMIC_DRAW)
    // Sprite registry: id → {texture, frameCount, frameWidth, ...}.
    // id 0 is reserved as "no sprite" so a zero-default in the pool
    // means "fall back to coloured point particle."
    this._sprRegistry = new Map()
    this._sprNextId = 1
    // Reverse cache so the same weapon name → same id across re-fires.
    this._sprWeaponToId = new Map()
  }

  // registerWeaponBitmap takes the metadata returned by
  // weapon-bitmap-loader.js, uploads the sprite sheet as a GL texture,
  // and returns a numeric sprite id the particle pool stores per
  // particle.  Idempotent per weapon name — calling twice with the
  // same name returns the cached id without re-uploading.
  //
  // `colorSlot` (optional) is the weapon TDF's color= value (0-7) —
  // the engine-internal slot index that picks which fx.gaf sequence
  // this weapon's projectile uses (see internal/studio/weapon_bitmap.go
  // for the slot→sequence mapping).  Stashed on the registry entry so
  // the Projectiles + Effects panels can label sprite particles with
  // their weapon name and slot # rather than a raw kind code.
  registerWeaponBitmap(weaponName, sprite, colorSlot = 0) {
    if (!sprite || !sprite.image) return 0
    if (!this.programSprites || !this.gl) return 0
    const key = String(weaponName || '').trim().toUpperCase()
    if (key && this._sprWeaponToId.has(key)) return this._sprWeaponToId.get(key)
    const gl = this.gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    // Premultiplied alpha matches the additive blend we use in the
    // sprites fragment shader.  Without it, the GAF transparency index
    // would bleed dark edges into bright projectile sprites.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sprite.image)
    // CLAMP_TO_EDGE so the per-frame UV sub-rect doesn't bleed into the
    // adjacent frame's column when the float math overshoots by an
    // epsilon at the cell boundary.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // LINEAR filtering keeps the chunky sprite from pixelating as it
    // grows on screen; the projectile is pretty small anyway so mipmap
    // overhead isn't worth it.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    const id = this._sprNextId++
    this._sprRegistry.set(id, {
      texture:         tex,
      frameCount:      sprite.frameCount,
      frameWidth:      sprite.frameWidth,
      frameHeight:     sprite.frameHeight,
      sheetWidth:      sprite.sheetWidth,
      sheetHeight:     sprite.sheetHeight,
      frameDurationMs: sprite.frameDurationMs,
      // Carried for the inspector panels — see weaponBitmapInfo().
      weaponName:      String(weaponName || ''),
      colorSlot:       colorSlot | 0,
      sequence:        String(sprite.sequence || ''),
    })
    if (key) this._sprWeaponToId.set(key, id)
    this.requestRedraw()
    return id
  }

  // hasWeaponBitmap is a quick lookup used by the weapon-driver to know
  // whether to spawn a textured sprite vs. the synthetic point sprite.
  hasWeaponBitmap(weaponName) {
    const key = String(weaponName || '').trim().toUpperCase()
    return key ? this._sprWeaponToId.has(key) : false
  }

  // weaponBitmapId returns the registered sprite id for a weapon name,
  // or 0 when no bitmap has been registered.  Caller passes the id as
  // opts.spriteId to particles.emit so the renderer's sprite pass
  // picks it up.
  weaponBitmapId(weaponName) {
    const key = String(weaponName || '').trim().toUpperCase()
    return (key && this._sprWeaponToId.get(key)) || 0
  }

  // weaponBitmapInfo looks up a registered sprite by id and returns
  // `{ weaponName, colorSlot, sequence }`, or null when the id isn't
  // registered.  Used by the Projectiles + Effects inspectors to label
  // bitmap-particle cards with their real weapon name + TDF color slot
  // instead of a generic "K206" kind code.
  weaponBitmapInfo(spriteId) {
    if (!spriteId) return null
    const e = this._sprRegistry && this._sprRegistry.get(spriteId)
    if (!e) return null
    return {
      weaponName: e.weaponName,
      colorSlot:  e.colorSlot,
      sequence:   e.sequence,
    }
  }

  // #renderSpriteParticles draws every alive particle with spriteId>0
  // as a textured billboarded point quad.  Particles are partitioned
  // by spriteId (one draw call per atlas).  Runs AFTER #renderParticles
  // so the cone-shaped smoke trail behind a sprite projectile reads
  // correctly under it; the additive blend means ordering between the
  // bright sprite and its trail isn't visually critical.
  #renderSpriteParticles() {
    const pool = this._particlePool
    if (!pool || pool.count === 0 || !this.programSprites) return
    if (!this._sprRegistry || this._sprRegistry.size === 0) return
    const gl = this.gl

    // First pass: bucket alive sprite particles by spriteId.  Most
    // frames have ≤ 2 unique atlases in flight (PlasmaSm + PlasmaMd in
    // stock TA), so a Map keyed by the small numeric id beats sorting.
    let buckets = null
    for (let i = 0; i < pool.count; i++) {
      const sid = pool.spriteId[i]
      if (!sid) continue
      if (!this._sprRegistry.has(sid)) continue
      if (!buckets) buckets = new Map()
      let arr = buckets.get(sid)
      if (!arr) { arr = []; buckets.set(sid, arr) }
      arr.push(i)
    }
    if (!buckets) return

    // Grow the interleaved scratch buffer if any bucket overflows our
    // capacity.  Sized to the largest bucket (we re-use the buffer
    // across draw calls).
    let maxBucket = 0
    for (const arr of buckets.values()) if (arr.length > maxBucket) maxBucket = arr.length
    if (maxBucket > this._sprCapacity) {
      while (this._sprCapacity < maxBucket) this._sprCapacity *= 2
      this._sprInterleaved = new Float32Array(this._sprCapacity * 12)
      gl.bindBuffer(gl.ARRAY_BUFFER, this._sprVBO)
      gl.bufferData(gl.ARRAY_BUFFER, this._sprInterleaved.byteLength, gl.DYNAMIC_DRAW)
    }

    gl.useProgram(this.programSprites)
    gl.uniformMatrix4fv(this.uSprProj, false, this.camera.projMatrix)
    gl.uniformMatrix4fv(this.uSprView, false, this.camera.viewMatrix)
    gl.uniform2f(this.uSprViewport, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.uniform1i(this.uSprAtlas, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._sprVBO)
    const STRIDE = 12 * 4
    gl.enableVertexAttribArray(this.aSprPos)
    gl.vertexAttribPointer(this.aSprPos, 3, gl.FLOAT, false, STRIDE, 0)
    gl.enableVertexAttribArray(this.aSprColor)
    gl.vertexAttribPointer(this.aSprColor, 4, gl.FLOAT, false, STRIDE, 3 * 4)
    gl.enableVertexAttribArray(this.aSprSize)
    gl.vertexAttribPointer(this.aSprSize, 1, gl.FLOAT, false, STRIDE, 7 * 4)
    gl.enableVertexAttribArray(this.aSprUvRect)
    gl.vertexAttribPointer(this.aSprUvRect, 4, gl.FLOAT, false, STRIDE, 8 * 4)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE) // additive, matches particle pass
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(false)

    for (const [sid, indices] of buckets) {
      const sprite = this._sprRegistry.get(sid)
      const data = this._sprInterleaved
      const frameWidthUV = sprite.frameWidth / sprite.sheetWidth
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k]
        // Frame index from particle age — clamped to [0..frameCount-1]
        // by mod so the strip loops naturally if a projectile outlives
        // one full cycle.
        const frame = Math.floor(pool.age[i] / sprite.frameDurationMs) % sprite.frameCount
        const u0 = frame * frameWidthUV
        const u1 = u0 + frameWidthUV
        const o = k * 12
        data[o + 0]  = pool.x[i]
        data[o + 1]  = pool.y[i]
        data[o + 2]  = pool.z[i]
        data[o + 3]  = pool.r[i]
        data[o + 4]  = pool.g[i]
        data[o + 5]  = pool.b[i]
        data[o + 6]  = pool.a[i]
        data[o + 7]  = pool.size[i]
        data[o + 8]  = u0
        data[o + 9]  = 0   // v0
        data[o + 10] = u1
        data[o + 11] = 1   // v1
      }
      gl.bindTexture(gl.TEXTURE_2D, sprite.texture)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, indices.length * 12))
      gl.drawArrays(gl.POINTS, 0, indices.length)
    }

    gl.depthMask(true)
    gl.disableVertexAttribArray(this.aSprPos)
    gl.disableVertexAttribArray(this.aSprColor)
    gl.disableVertexAttribArray(this.aSprSize)
    gl.disableVertexAttribArray(this.aSprUvRect)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  }

  // #initDoFProgram links the post-process DoF program + sets up the
  // shared full-screen quad VBO it draws into.  The scene FBO is
  // (re)allocated per-frame because the canvas size can change with
  // window resizes — see #ensureSceneFBO.
  #initDoFProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programDoF = prog
    const gl = this.gl
    this.aDoFPos = gl.getAttribLocation(prog, 'aPos')
    this.uDoFScene = gl.getUniformLocation(prog, 'uScene')
    this.uDoFSceneDepth = gl.getUniformLocation(prog, 'uSceneDepth')
    this.uDoFTexel = gl.getUniformLocation(prog, 'uTexel')
    this.uDoFFocalDepth = gl.getUniformLocation(prog, 'uFocalDepth')
    this.uDoFFocalRange = gl.getUniformLocation(prog, 'uFocalRange')
    this.uDoFMaxBlur = gl.getUniformLocation(prog, 'uMaxBlur')
    this.uDoFEnabled = gl.getUniformLocation(prog, 'uEnabled')
    this.uDoFBloom = gl.getUniformLocation(prog, 'uBloom')
    this.uDoFBloomOn = gl.getUniformLocation(prog, 'uBloomOn')
    this.uDoFBloomStrength = gl.getUniformLocation(prog, 'uBloomStrength')
    this.uDoFCinematic = gl.getUniformLocation(prog, 'uCinematic')
    this.uDoFGrade = gl.getUniformLocation(prog, 'uGrade')
    this.uDoFFlareOn = gl.getUniformLocation(prog, 'uFlareOn')
    this.uDoFFlarePos = gl.getUniformLocation(prog, 'uFlarePos')
    this.uDoFFlareColor = gl.getUniformLocation(prog, 'uFlareColor')
    this.uDoFFlareStrength = gl.getUniformLocation(prog, 'uFlareStrength')
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, 1, 1,
      -1, -1, 1, 1, -1, 1,
    ]), gl.STATIC_DRAW)
    this._dofVBO = buf
  }

  // #ensureSceneFBO (re)allocates the scene colour + depth attachments
  // when the canvas dimensions change.  No-op when sized correctly.
  // Returns false when the FBO can't be created (no depth-texture
  // extension, no GL state) so callers can skip the DoF pass.
  #ensureSceneFBO() {
    if (!this._depthExt || !this.programDoF) return false
    const gl = this.gl
    const w = gl.drawingBufferWidth | 0
    const h = gl.drawingBufferHeight | 0
    if (w <= 0 || h <= 0) return false
    if (this._sceneFBO && this._sceneW === w && this._sceneH === h) return true
    if (this._sceneFBO) gl.deleteFramebuffer(this._sceneFBO)
    if (this._sceneColorTex) gl.deleteTexture(this._sceneColorTex)
    if (this._sceneDepthTex) gl.deleteTexture(this._sceneDepthTex)
    this._sceneFBO = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._sceneFBO)
    const color = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, color)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0)
    const depth = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, depth)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0)
    // Depth precision — a 24-bit (UNSIGNED_INT) depth texture matches the
    // default framebuffer.  The old 16-bit (UNSIGNED_SHORT) buffer was the
    // cause of the z-fighting on coplanar TA polygons + thin-geometry
    // "clipping" that only showed once a post effect routed the scene
    // through this FBO: the depthTier polygon-offset bias is tuned for
    // 24-bit depth and 16 bit couldn't separate the coplanar layers.  Fall
    // back to 16-bit only if the driver won't complete the 24-bit FBO.
    let status = 0
    for (const depthType of [gl.UNSIGNED_INT, gl.UNSIGNED_SHORT]) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, w, h, 0, gl.DEPTH_COMPONENT, depthType, null)
      status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      if (status === gl.FRAMEBUFFER_COMPLETE) break
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(this._sceneFBO)
      gl.deleteTexture(color)
      gl.deleteTexture(depth)
      this._sceneFBO = null
      this._sceneColorTex = null
      this._sceneDepthTex = null
      return false
    }
    this._sceneColorTex = color
    this._sceneDepthTex = depth
    this._sceneW = w
    this._sceneH = h
    return true
  }

  // #runPostChain composites the offscreen scene into the screen.
  // Stage 1 (composite): DoF blur + bloom add + cinematic grade via the
  // dof.frag program.  When the FXAA pass is active (anti-aliasing on) the
  // composite renders into the LDR FBO so FXAA can sample its result;
  // otherwise it draws straight to the default framebuffer.
  // Stage 2 (FXAA): only when anti-aliasing is on, the LDR FBO is edge-
  // smoothed into the default framebuffer.
  #runPostChain() {
    const gl = this.gl
    if (!this.programDoF || !this._sceneFBO) return
    // Bloom first — fills _bloomTex (or clears it) so the composite's
    // bloom-add reads a fresh result, never a stale prior frame.
    if (this.optBloom) this.#renderBloom()
    else this._bloomTex = null
    // FXAA runs when the user's AA toggle is on, OR whenever any OTHER post
    // effect has already forced the scene through this no-MSAA FBO — the
    // canvas's hardware MSAA is lost on the offscreen path, so without FXAA
    // the edges would go jagged the moment Cinematic / DoF / Bloom / Lens
    // Flare is enabled.  When on, the composite renders into the LDR FBO so
    // the FXAA pass can sample it; otherwise it draws straight to screen.
    const anyPostFx = this.optDof || this.optCinematic || this.optBloom || this.optLensFlare
    const wantFxaa = (this.optAntialias || anyPostFx) && !!this.programFxaa && this.#ensureLdrFBO()

    // Stage 1 — composite.
    if (wantFxaa) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._ldrFBO)
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.useProgram(this.programDoF)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._sceneColorTex)
    gl.uniform1i(this.uDoFScene, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this._sceneDepthTex)
    gl.uniform1i(this.uDoFSceneDepth, 1)
    // Bloom sampler — bind the live bloom texture when on, else a
    // harmless stand-in (the scene colour) so the sampler is always
    // backed; the uBloomOn gate keeps it out of the output anyway.
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, (this.optBloom && this._bloomTex) ? this._bloomTex : this._sceneColorTex)
    gl.uniform1i(this.uDoFBloom, 2)
    gl.uniform2f(this.uDoFTexel, 1 / this._sceneW, 1 / this._sceneH)
    gl.uniform1f(this.uDoFFocalDepth, this.dofFocalDepth)
    gl.uniform1f(this.uDoFFocalRange, this.dofFocalRange)
    gl.uniform1f(this.uDoFMaxBlur, this.dofMaxBlur)
    gl.uniform1f(this.uDoFEnabled, this.optDof ? 1 : 0)
    gl.uniform1f(this.uDoFBloomOn, (this.optBloom && this._bloomTex) ? 1 : 0)
    gl.uniform1f(this.uDoFBloomStrength, this.bloomStrength)
    gl.uniform1f(this.uDoFCinematic, this.optCinematic ? 1 : 0)
    gl.uniform1f(this.uDoFGrade, this.cinematicStrength)
    // Lens flare — project the sun (a far point along lightDir from the
    // camera target) into screen UV.  We fire the flare whenever the sun
    // is in FRONT of the camera (cw > 0), even when it projects off the
    // visible frame: the composite fades the bright core out off-screen
    // but still streaks the ghosts across the frame toward the sun, so a
    // partial flare appears when you look in the sun's direction (it sits
    // high overhead and is rarely framed directly).  Behind-camera suns
    // (cw <= 0) still disable it.
    let flareOn = 0, fx = 0.5, fy = 0.5
    let fcol = this._flareColor || (this._flareColor = [1, 1, 1])
    if (this.optLensFlare && this.camera) {
      const c = this.camera, L = this.lightDir, t = c.target, D = 5000
      const sx = t[0] + L[0] * D, sy = t[1] + L[1] * D, sz = t[2] + L[2] * D
      const m = this._flareVP || (this._flareVP = Mat4.create())
      Mat4.multiply(m, c.projMatrix, c.viewMatrix)
      const cw = m[3] * sx + m[7] * sy + m[11] * sz + m[15]
      if (cw > 0.0001) {
        flareOn = 1
        fx = (m[0] * sx + m[4] * sy + m[8] * sz + m[12]) / cw * 0.5 + 0.5
        fy = (m[1] * sx + m[5] * sy + m[9] * sz + m[13]) / cw * 0.5 + 0.5
        const lc = this.lightColor
        const mx = Math.max(lc[0], lc[1], lc[2], 1)
        fcol[0] = lc[0] / mx; fcol[1] = lc[1] / mx; fcol[2] = lc[2] / mx
      }
    }
    gl.uniform1f(this.uDoFFlareOn, flareOn)
    gl.uniform2f(this.uDoFFlarePos, fx, fy)
    gl.uniform3fv(this.uDoFFlareColor, fcol)
    gl.uniform1f(this.uDoFFlareStrength, this.lensFlareStrength)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._dofVBO)
    gl.enableVertexAttribArray(this.aDoFPos)
    gl.vertexAttribPointer(this.aDoFPos, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // Stage 2 — FXAA over the composited LDR image.
    if (wantFxaa) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.useProgram(this.programFxaa)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this._ldrColorTex)
      gl.uniform1i(this.uFxaaTex, 0)
      gl.uniform2f(this.uFxaaTexel, 1 / this._sceneW, 1 / this._sceneH)
      gl.uniform1f(this.uFxaaEnabled, 1)
      gl.bindBuffer(gl.ARRAY_BUFFER, this._dofVBO)
      gl.enableVertexAttribArray(this.aFxaaPos)
      gl.vertexAttribPointer(this.aFxaaPos, 2, gl.FLOAT, false, 0, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
  }

  // #initFxaaProgram links the FXAA pass + grabs its uniform locations.
  // Reuses the shared full-screen quad VBO created by #initDoFProgram.
  #initFxaaProgram(vsSrc, fsSrc) {
    const prog = this.#linkProgram(vsSrc, fsSrc)
    this.programFxaa = prog
    const gl = this.gl
    this.aFxaaPos = gl.getAttribLocation(prog, 'aPos')
    this.uFxaaTex = gl.getUniformLocation(prog, 'uTex')
    this.uFxaaTexel = gl.getUniformLocation(prog, 'uTexel')
    this.uFxaaEnabled = gl.getUniformLocation(prog, 'uEnabled')
  }

  // #ensureLdrFBO (re)allocates the full-res colour-only target the
  // composite stage writes to when FXAA needs a sampleable input.
  // Sized to the drawing buffer; matches scene FBO dims.
  #ensureLdrFBO() {
    const gl = this.gl
    const w = gl.drawingBufferWidth | 0
    const h = gl.drawingBufferHeight | 0
    if (w <= 0 || h <= 0) return false
    if (this._ldrFBO && this._ldrW === w && this._ldrH === h) return true
    if (this._ldrFBO) gl.deleteFramebuffer(this._ldrFBO)
    if (this._ldrColorTex) gl.deleteTexture(this._ldrColorTex)
    this._ldrFBO = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._ldrFBO)
    const color = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, color)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(this._ldrFBO); gl.deleteTexture(color)
      this._ldrFBO = null; this._ldrColorTex = null
      return false
    }
    this._ldrColorTex = color
    this._ldrW = w
    this._ldrH = h
    return true
  }

  // #initBloomPrograms links the bright-pass + separable-blur programs
  // (both share bloom.vert) and grabs their uniform locations.  They
  // reuse the shared full-screen quad VBO from #initDoFProgram.
  #initBloomPrograms(brightSrc, blurSrc) {
    const gl = this.gl
    const bp = this.#linkProgram(brightSrc.vs, brightSrc.fs)
    this.programBright = bp
    this.aBrightPos = gl.getAttribLocation(bp, 'aPos')
    this.uBrightTex = gl.getUniformLocation(bp, 'uTex')
    this.uBrightThreshold = gl.getUniformLocation(bp, 'uThreshold')
    const bl = this.#linkProgram(blurSrc.vs, blurSrc.fs)
    this.programBlur = bl
    this.aBlurPos = gl.getAttribLocation(bl, 'aPos')
    this.uBlurTex = gl.getUniformLocation(bl, 'uTex')
    this.uBlurDir = gl.getUniformLocation(bl, 'uDir')
  }

  // #ensureBloomFBOs (re)allocates the two half-res ping-pong colour
  // targets the bright-pass + blur write into.  Half-res keeps the blur
  // cheap and naturally widens the glow.
  #ensureBloomFBOs() {
    const gl = this.gl
    const w = Math.max(1, (gl.drawingBufferWidth >> 1))
    const h = Math.max(1, (gl.drawingBufferHeight >> 1))
    if (this._bloomFboA && this._bloomW === w && this._bloomH === h) return true
    for (const k of ['_bloomFboA', '_bloomFboB']) {
      if (this[k]) { gl.deleteFramebuffer(this[k]); this[k] = null }
    }
    for (const k of ['_bloomTexA', '_bloomTexB']) {
      if (this[k]) { gl.deleteTexture(this[k]); this[k] = null }
    }
    const make = () => {
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
      return ok ? { fbo, tex } : (gl.deleteFramebuffer(fbo), gl.deleteTexture(tex), null)
    }
    const a = make(), b = make()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (!a || !b) { this._bloomTex = null; return false }
    this._bloomFboA = a.fbo; this._bloomTexA = a.tex
    this._bloomFboB = b.fbo; this._bloomTexB = b.tex
    this._bloomW = w; this._bloomH = h
    return true
  }

  // #renderBloom extracts the bright pixels of the scene colour, blurs
  // them with a two-pass separable Gaussian, and leaves the result in
  // _bloomTex for the composite stage to add on top.  No-op (clears
  // _bloomTex) when the FBOs can't be allocated.
  #renderBloom() {
    const gl = this.gl
    if (!this.programBright || !this.programBlur || !this.#ensureBloomFBOs()) {
      this._bloomTex = null
      return
    }
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.viewport(0, 0, this._bloomW, this._bloomH)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._dofVBO)
    // Bright pass: scene colour -> bloom A.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomFboA)
    gl.useProgram(this.programBright)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._sceneColorTex)
    gl.uniform1i(this.uBrightTex, 0)
    gl.uniform1f(this.uBrightThreshold, 0.72)
    gl.enableVertexAttribArray(this.aBrightPos)
    gl.vertexAttribPointer(this.aBrightPos, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    // Blur — horizontal A -> B, then vertical B -> A.  SPREAD widens the
    // tap stride for a softer, larger glow than a 1-texel kernel.
    const SPREAD = 1.5
    gl.useProgram(this.programBlur)
    gl.enableVertexAttribArray(this.aBlurPos)
    gl.vertexAttribPointer(this.aBlurPos, 2, gl.FLOAT, false, 0, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomFboB)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexA)
    gl.uniform1i(this.uBlurTex, 0)
    gl.uniform2f(this.uBlurDir, SPREAD / this._bloomW, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloomFboA)
    gl.bindTexture(gl.TEXTURE_2D, this._bloomTexB)
    gl.uniform2f(this.uBlurDir, 0, SPREAD / this._bloomH)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    this._bloomTex = this._bloomTexA
  }

  // #loadTerrainTexture pulls the active tileset's flat-tile PNG from
  // the new /api/studio/ground-tile endpoint, uploads it with REPEAT
  // wrapping (so the ground shader can tile-sample by world-space
  // coords), and flips `_terrainReady` so the shader graduates from
  // its fallback look to real terrain.
  #loadTerrainTexture() {
    if (this._terrainTex) return
    const gl = this.gl
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = `/api/studio/ground-tile/${encodeURIComponent(this.terrainTileset)}`
    img.addEventListener('load', () => {
      const tex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
      const pot = (img.naturalWidth & (img.naturalWidth - 1)) === 0 && (img.naturalHeight & (img.naturalHeight - 1)) === 0
      if (pot) {
        gl.generateMipmap(gl.TEXTURE_2D)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      this._terrainTex = tex
      this._terrainReady = true
      this.requestRedraw()
    }, { once: true })
    img.addEventListener('error', () => {
      console.warn(`terrain texture failed to load for tileset ${this.terrainTileset}`)
    }, { once: true })
  }

  #initShadowFBO() {
    const gl = this.gl
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0)
    // Some WebGL1 implementations also require a color attachment.
    const color = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, color)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      // Disable shadow mapping if the driver refused our setup; the
      // main shader's uShadowEnabled flag falls back to flat lighting.
      console.warn(`shadow FBO incomplete (0x${status.toString(16)}), shadows disabled`)
      gl.deleteFramebuffer(fbo)
      gl.deleteTexture(tex)
      gl.deleteTexture(color)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      this._depthExt = null
      return
    }
    this._shadowFBO = fbo
    this._shadowTex = tex
    this._shadowColorTex = color
    // Second shadow FBO + textures for the twin-sun environment.
    // Built lazily on the same depth-texture path as the first.
    const tex2 = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex2)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo2 = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo2)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex2, 0)
    const color2 = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, color2)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color2, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
      this._shadowFBO2 = fbo2
      this._shadowTex2 = tex2
      this._shadowColorTex2 = color2
    } else {
      gl.deleteFramebuffer(fbo2)
      gl.deleteTexture(tex2)
      gl.deleteTexture(color2)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  #linkProgram(vsSrc, fsSrc) {
    const gl = this.gl
    const compile = (src, type) => {
      const sh = gl.createShader(type)
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(sh)
        gl.deleteShader(sh)
        throw new Error(`shader compile failed: ${info}`)
      }
      return sh
    }
    const vs = compile(vsSrc, gl.VERTEX_SHADER)
    const fs = compile(fsSrc, gl.FRAGMENT_SHADER)
    const prog = gl.createProgram()
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`)
    }
    return prog
  }

  static #normalise(v) {
    const len = Math.hypot(v[0], v[1], v[2])
    if (len === 0) return [0, 1, 0]
    return [v[0] / len, v[1] / len, v[2] / len]
  }
}
