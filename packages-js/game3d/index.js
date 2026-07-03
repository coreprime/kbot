// Public entry point for @kbot/game3d — a self-contained WebGL renderer
// for Total Annihilation-style scenes (no three.js, no host server).
//
// Everything here draws state it is GIVEN: assets arrive through an
// injected AssetProvider (see assets.js) and per-tick unit/projectile
// state through createWorld().applyState() — the renderer knows no game
// rules.  Deep-integration hosts can also compose the underlying
// classes directly; both routes share the same module instances.

export { createWorld } from './create-world.js'
export { setAssetProvider, getAssetProvider, requireAssetProvider, toTexImageSource } from './assets.js'
export { HttpPackProvider } from './http-pack-provider.js'

// Engine <-> renderer pose conventions (heading + COB piece transforms) — the
// canonical constants/helpers a driver (replayer, lobby) uses to feed raw
// game data through the renderer with no per-driver sign or offset fix-ups.
export {
  TA_FULL_CIRCLE,
  TA_ANGLE_TO_RAD,
  headingToRadians,
  enginePieceToPose,
  unpackEnginePieces,
  applyPackedPieces,
  lerpPackedPieces,
} from './cob-pose.js'
export { loadMapTerrain, MAP_CELL_WU, MAP_HEIGHT_SCALE } from './map-terrain.js'
export { createTerrainSampler } from './terrain-sample.js'

// Core renderer stack
export { Mat4 } from './mat4.js'
export { TAPalette } from './palette.js'
export { TextureCache } from './texture-cache.js'
export { Piece } from './piece.js'
export { Model } from './model.js'
export { ModelLoader, setLodHidePatterns } from './model-loader.js'
export { OrbitCamera } from './orbit-camera.js'
export { ModelRenderer } from './model-renderer.js'
export { ModelViewer } from './model-viewer.js'
export { attachOrbitControls } from './camera-controls.js'

// Overlays, audio, input
export { ArmedCursor } from './armed-cursor.js'
export { AudioPool } from './audio-pool.js'
export { ExplosionOverlay } from './explosion-overlay.js'
export { attachUnitHotkeys } from './unit-hotkeys.js'

// Weapon / projectile visuals
export {
  SmokeTrailManager,
  setProjectileFallbackColors,
  projectileColor,
  laserColor,
  pickProjectileKind,
  projectileSize,
  projectileLightStrength,
  spawnLaserBeam,
  spawnProjectile,
  spawnProjectileInFlight,
  playWeaponSound,
} from './weapon-driver.js'
export { loadWeaponBitmap, clearWeaponBitmapCache } from './weapon-bitmap-loader.js'
export {
  normalizePackWeaponDef,
  weaponVisualPlan,
  spawnWeaponVisual,
  impactBurst,
  resolveDeathPlan,
  damageSmokeIntervalMs,
} from './world-fx.js'

// Team + texture configuration
export { TEAM_SIDES, TA_TEAM_SIDES, setTeamSides, teamColorForSide, displayRgbForSide, sideForKey } from './team-colors.js'
export { setEnhanceMeshEnabled, enhanceMeshEnabled, onEnhanceMeshChanged } from './enhance-mesh.js'
export {
  resolveTextureHints,
  setTextureHintOverride,
  clearTextureHintOverride,
  hasTextureHintOverride,
} from './hints-textures.js'

// Worlds / environments
export {
  loadWorlds,
  WORLD_LIST,
  SKY_PRESETS,
  ENVIRONMENT_PRESETS,
  GRAVITY_BY_ENV,
  GRAVITY_EARTH,
} from './worlds.js'

// Scene lighting + particles (shader-coupled)
export { MAX_PULSE_LIGHTS, setMaxSceneLights, getMaxSceneLights, gatherSceneLights } from './scene-lights.js'
export { ParticlePool } from './cob-particles.js'
