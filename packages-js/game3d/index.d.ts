// Type definitions for @kbot/game3d — the root export surface.
// Subpath modules (`@kbot/game3d/<module>`) mirror these named exports.

/** A 256-entry palette as [r, g, b] byte triples. */
export type PaletteTriples = Array<[number, number, number]>

/** Anything WebGL texImage2D (and 2D-canvas drawImage) accepts. */
export type TexSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement

/**
 * The asset seam: every byte @kbot/game3d needs arrives through one of
 * these methods.  Implement against any backend (the KBot Studio
 * server, static pre-extracted packs over HTTP, an in-browser HPI
 * reader) and the renderer neither knows nor cares.
 */
export interface AssetProvider {
  /** 256-entry RGB palette for flat-coloured primitives. REQUIRED. */
  palette(): Promise<PaletteTriples>
  /** Preprocessed model geometry for a model name. REQUIRED. */
  model(name: string, opts?: { enhanceMesh?: boolean }): Promise<ModelGeometry>
  /** Decoded texture image; name may carry a "?side=…" resolver query. REQUIRED. */
  texture(name: string): Promise<Blob | TexSource>

  /** COB animation script (parsed form); null ⇒ unit renders statically. */
  script?(name: string, opts?: { decompile?: boolean }): Promise<unknown | null>
  /** RAW COB bytecode (the engine script VM's runnable form); null ⇒ no script. */
  scriptBytes?(name: string): Promise<Uint8Array | null>
  /** Tileable flat-terrain texture for an environment tileset. */
  groundTile?(tileset: string): Promise<Blob | TexSource>
  /** Streamable URL for a sound stem (preferred over sound()). */
  soundUrl?(stem: string): string | null
  /** Sound bytes for a stem when soundUrl is absent. */
  sound?(stem: string): Promise<Blob | ArrayBuffer>
  /** <img>-assignable URL for an armed-cursor glyph. */
  cursorUrl?(name: string): string | null
  /** Cursor glyph bytes when cursorUrl is absent. */
  cursor?(name: string): Promise<Blob>
  /** Animated bitmap-projectile sprite metadata (base64 `sheet` + frames). */
  weaponBitmap?(weaponName: string): Promise<WeaponBitmapMeta | null>

  /** Game manifest (sides, palettes, unit list) — for drivers, not the renderer. */
  manifest?(): Promise<unknown>
  /** Parsed unit database (FBI/TDF + movement classes) — for drivers. */
  unitDB?(): Promise<unknown>
  /** Map pack (heightmap + tiles + features + minimap) — for drivers. */
  map?(name: string): Promise<unknown>
}

export interface ModelGeometry {
  name: string
  root: ModelGeometryNode
  bounds?: { min: [number, number, number]; max: [number, number, number] }
  textures?: string[]
  decals?: string[]
  textureQuery?: string
  textureSources?: Record<string, string>
}

export interface ModelGeometryNode {
  name: string
  origin: [number, number, number]
  vertices?: number[]
  primitives?: Array<{
    indices: number[]
    texture?: string
    isColored?: boolean
    colorIndex?: number
    colorRGB?: [number, number, number]
  }>
  selectionPrim?: number
  isEmitterPoint?: boolean
  children?: ModelGeometryNode[]
}

export interface WeaponBitmapMeta {
  sheet: string
  frameCount: number
  frameWidth: number
  frameHeight: number
  sheetWidth: number
  sheetHeight: number
  frameDurationMs: number
  originX: number
  originY: number
  sequence?: string
}

// Engine <-> renderer pose conventions (cob-pose.js): heading 0 faces -Z
// (north), 65536 TA angle units per turn; COB piece transforms convert via
// enginePieceToPose and apply BY NAME through the COB piece table.
export const TA_FULL_CIRCLE: number
export const TA_ANGLE_TO_RAD: number
export function headingToRadians(taHeading: number): number
export function enginePieceToPose(
  ox: number, oy: number, oz: number,
  rx: number, ry: number, rz: number,
): { move: [number, number, number]; rotate: [number, number, number] }
export function unpackEnginePieces(
  packed: Uint8Array | Float32Array | null | undefined,
): Array<{ move: [number, number, number]; rotate: [number, number, number]; visible: boolean }> | null
export function applyPackedPieces(
  model: Model,
  pieceNames: string[],
  packed: Uint8Array | Float32Array,
  cache?: Map<string, unknown> | null,
): void
/**
 * Interpolate two engine packed piece buffers (stride-7) by alpha:
 * offsets lerp linearly, rotations take the shortest arc in TA-angle
 * space (65536/turn), visibility switches hard from `next`.  Feeds
 * applyState's piecesPacked for smooth between-tick output frames.
 */
export function lerpPackedPieces(
  prevPacked: Uint8Array | Float32Array | null | undefined,
  nextPacked: Uint8Array | Float32Array | null | undefined,
  alpha: number,
  out?: Float32Array,
): Float32Array | null

// Packed-map terrain (map-terrain.js): turn a pack's maps/<name>.json +
// tile atlas into ModelRenderer.setMapTerrain() arguments.
export const MAP_CELL_WU: number
export const MAP_HEIGHT_SCALE: number
export function loadMapTerrain(provider: AssetProvider, name: string): Promise<{
  image: HTMLCanvasElement
  heights: Uint8Array
  w: number
  h: number
  cellWU: number
  heightScale: number
  seaLevel: number
  worldW: number
  worldH: number
  voids: Uint8Array | null
  startPositions: Array<{ number: number; x: number; z: number }>
  features: Array<{ name: string; ax: number; ay: number }>
  name: string
  minimapUrl: string | null
  ota: object | null
}>

/**
 * CPU sampler over a battlefield height field with the renderer mesh's
 * exact triangulation.  heightAt answers in display world-Y (raw height ×
 * heightScale); rawHeightAt in source units; normalAt is smoothed.
 */
export function createTerrainSampler(t: {
  heights: ArrayLike<number>
  w: number
  h: number
  cellWU?: number
  heightScale?: number
  originX?: number
  originZ?: number
}): {
  heightAt: (x: number, z: number) => number
  rawHeightAt: (x: number, z: number) => number
  normalAt: (x: number, z: number) => [number, number, number]
}

export function setAssetProvider(provider: AssetProvider | null): void
export function getAssetProvider(): AssetProvider | null
export function requireAssetProvider(): AssetProvider
export function toTexImageSource(result: Blob | TexSource): Promise<TexSource>

/**
 * AssetProvider over a static pre-extracted asset pack (`kbot pack`
 * output) served from a plain HTTP base URL — no studio server.
 */
export class HttpPackProvider implements AssetProvider {
  constructor(baseUrl: string)
  /** Absolute URL for a pack-relative path. */
  url(rel: string): string
  palette(): Promise<PaletteTriples>
  model(name: string, opts?: { enhanceMesh?: boolean }): Promise<ModelGeometry>
  texture(name: string): Promise<TexSource>
  script(name: string, opts?: { decompile?: boolean }): Promise<unknown | null>
  scriptBytes(name: string): Promise<Uint8Array | null>
  groundTile(tileset: string): Promise<TexSource>
  soundUrl(stem: string): string
  cursorUrl(name: string): string
  weaponBitmap(weaponName: string): Promise<WeaponBitmapMeta | null>
  manifest(): Promise<unknown>
  unitDB(): Promise<unknown>
  map(name: string): Promise<unknown>
}

// ── createWorld ────────────────────────────────────────────────────────

export interface UnitPlacement {
  id?: number | string
  x?: number
  y?: number
  z?: number
  /** Radians; defaults to the rest pose (π). */
  heading?: number
  side?: number
  teamColor?: [number, number, number] | null
  buildPercent?: number
  /** Clamp render Y to the terrain surface + slope-tilt to its normal. */
  grounded?: boolean
  /** Airborne / hovercraft / surface-vessel presentation flags. */
  air?: boolean
  hover?: boolean
  naval?: boolean
  /** 0..1 health fraction — health bar (when < 1) + damage smoke. */
  hp01?: number | null
  /** 0..5 veteran rank stars — drawn beneath the health bar, only while the bar shows. */
  rank?: number
  /** Airborne: hover bob + bank-into-turns + contrails; death = spiral crash. */
  air?: boolean
  /** Hovercraft: cushion gyration overlay. */
  hover?: boolean
  /** Surface vessel: stern wake while under way on the sea sheet. */
  naval?: boolean
  /**
   * false marks a structure — unitImpulse() hit-rock never applies.
   * Omitted → inferred: a grounded unit that never moves reads as a
   * structure.  true forces the mobile-hull treatment.
   */
  mobile?: boolean | null
}

export interface SnapshotPieceState {
  move?: [number, number, number]
  rotate?: [number, number, number]
  visible?: boolean
}

export interface SnapshotUnit {
  id: number | string
  /** Model name; `name` accepted as an alias. */
  model?: string
  name?: string
  x?: number
  y?: number
  z?: number
  /** Radians, game convention: 0 faces -Z (north) — headingToRadians of a wire heading, or the engine snapshot's headingRad. Externally-lerped values render as-is. */
  heading?: number
  pitch?: number
  roll?: number
  buildPercent?: number
  side?: number
  teamColor?: [number, number, number]
  /** Clamp render Y to terrain + slope-tilt (set tilt:false to keep flat). */
  grounded?: boolean
  tilt?: boolean
  /** 0..1 health fraction — health bar (when < 1) + damage smoke. */
  hp01?: number | null
  /** 0..5 veteran rank stars beneath the health bar — rendered only while the bar shows (unit damaged). */
  rank?: number
  /** Airborne (presentation): hover bob, bank-into-turns, contrails at speed, spiral-crash death. */
  air?: boolean
  /** Hovercraft cushion gyration. */
  hover?: boolean
  /** Surface vessel: stern wake while moving on the sea sheet. */
  naval?: boolean
  /**
   * false marks a structure — unitImpulse() hit-rock never applies.
   * Omitted → inferred: a grounded unit whose position/heading never
   * change across snapshots reads as a structure.  true forces mobility.
   */
  mobile?: boolean | null
  /** dead:true on a live unit triggers unitDeath(id, { severity: deathSeverity, corpse, heapCorpse, impactDir, impactMag }) once. */
  dead?: boolean
  deathSeverity?: number
  corpse?: string | null
  heapCorpse?: string | null
  /** World-frame [x, z] pointing source → victim; biases debris scatter away from the killing blow. */
  impactDir?: [number, number] | null
  /** Impact push magnitude (1 ≈ light round … 4 ≈ heavy shell). */
  impactMag?: number
  /** COB piece table (index-aligned with piecesPacked); static per type. */
  pieceNames?: string[]
  /** Engine stride-7 packed piece transforms, applied by name via pieceNames (optionally pre-blended with lerpPackedPieces). */
  piecesPacked?: Uint8Array | Float32Array
  /** Pre-converted renderer channels: Model.flat order, or COB order when pieceNames is set. */
  pieces?: SnapshotPieceState[]
}

export interface SnapshotProjectile {
  id?: number | string
  model?: string
  x?: number
  y?: number
  z?: number
  heading?: number
  pitch?: number
}

export interface SnapshotSfxEvent {
  /** 'emitSfx' (COB emit-sfx smoke/bubbles) or 'explode' (COB EXPLODE flash); other kinds no-op. */
  kind: string
  unitId?: number
  sfxType?: number
  x?: number
  y?: number
  z?: number
}

export interface WorldSnapshot {
  units?: SnapshotUnit[]
  projectiles?: SnapshotProjectile[]
  /** Engine render events — forwarded unfiltered; see World.sfxEvent. */
  events?: SnapshotSfxEvent[]
}

export interface World {
  /** The renderer (alias: renderer). */
  scene: ModelRenderer
  renderer: ModelRenderer
  camera: OrbitCamera
  loader: ModelLoader
  palette: TAPalette
  textureCache: TextureCache
  gl: WebGLRenderingContext
  /** Advance tracer visuals and render one frame. */
  step(dtMs?: number): void
  addUnit(name: string, placement?: UnitPlacement): Promise<number | string>
  removeUnit(id: number | string): void
  moveUnit(id: number | string, pos: { x?: number; y?: number; z?: number; heading?: number }): void
  /** Replace the rendered world from a sim snapshot. */
  applyState(snapshot: WorldSnapshot): void
  /** Spawn a purely visual tracer light. */
  fireWeapon(opts: {
    from: [number, number, number]
    to?: [number, number, number]
    vel?: [number, number, number]
    speed?: number
    color?: [number, number, number]
    strength?: number
    lifeMs?: number
  }): void
  /**
   * Spawn a presentation-only weapon visual.  With `weapon` (a pack
   * weapons.json id) the shot renders through the studio's visual
   * pipeline: palette-tinted laser pulse beams, the D-gun fireball +
   * flame trail, packed projectile meshes with TDF-cadenced smoke
   * trails, fx.gaf bitmap bolts, AoE-scaled particle tracers, muzzle
   * flash/start-smoke and impact bursts.  Without a resolvable weapon,
   * `type` picks the legacy line beam/tracer.  Explicit fields override.
   */
  weaponEffect(opts: {
    type?: 'beam' | 'laser' | 'tracer' | null
    from: [number, number, number]
    to: [number, number, number]
    color?: [number, number, number] | null
    durationMs?: number | null
    velocity?: number | null
    width?: number | null
    weapon?: string | null
  }): Promise<void>
  /**
   * Play a unit's death: severity < 50 leaves the intact `corpse` wreck
   * (sunk slightly, persists until removeCorpse/clearCorpses); 50..99
   * throws polygon debris + leaves `heapCorpse`; ≥ 100 debris only.
   * Corpse names come from the pack unitdb meta (corpseObject /
   * corpseHeapObject).  Removes the live unit; returns false if unknown.
   */
  unitDeath(id: number | string, opts?: {
    severity?: number
    corpse?: string | null
    heapCorpse?: string | null
    /** World-frame [x, z] source → victim: debris scatters away from it. */
    impactDir?: [number, number] | null
    impactMag?: number
    redraw?: boolean
  }): boolean
  removeCorpse(id: number | string): void
  clearCorpses(): void
  corpseIds(): Array<number | string>
  /**
   * Presentation-only hit-rock: the unit shudders on a damped pitch/roll
   * spring.  dirX/dirZ is the impact push direction in world space; mag
   * 1 ≈ light round, 4 ≈ heavy shell.  Structures never rock: a unit
   * with mobile:false — or, with no flag, a grounded unit that has never
   * moved or yawed — ignores the impulse entirely.
   */
  unitImpulse(id: number | string, opts: { dirX?: number; dirZ?: number; mag?: number }): void
  /** Render one engine render event ('emitSfx' smoke / 'explode' flash). */
  sfxEvent(ev: SnapshotSfxEvent): void
  /**
   * Install (or clear with null) a battlefield — the loadMapTerrain
   * payload.  When it carries features[] (packed maps do) the map's
   * features install too: sprite features as procedural 3D stand-ins
   * (batched; category/size from the pack's features.json), object
   * features as their real packed 3DO models.  opts.features:false skips
   * them; toggle later with setFeaturesEnabled.
   */
  setTerrain(terrain: object | null, opts?: { features?: boolean }): void
  /** Toggle the installed map features without rebuilding them. */
  setFeaturesEnabled(on: boolean): void
  /**
   * Drive the TA construction visual: a green nano spray from the builder
   * onto the build target (whose rising wireframe→solid treatment rides
   * its buildPercent).  Keyed per build order; { on:false } stops it.
   * Endpoints track units (fromUnitId/toUnitId) or fix positions (from/to).
   */
  latheBeam(key: string | number, opts: {
    fromUnitId?: number | string | null
    toUnitId?: number | string | null
    from?: [number, number, number] | null
    to?: [number, number, number] | null
    on?: boolean
    color?: [number, number, number, number] | null
  }): void
  /**
   * Reclaim visual: nano particles stream FROM the wreck (corpseId) or
   * unit/position back INTO the builder, and a corpseId target shrinks
   * while beamed.  The driver still calls removeCorpse when the recording
   * says the reclaim finished.
   */
  reclaimBeam(key: string | number, opts: {
    fromUnitId?: number | string | null
    corpseId?: number | string | null
    toUnitId?: number | string | null
    from?: [number, number, number] | null
    to?: [number, number, number] | null
    on?: boolean
    color?: [number, number, number, number] | null
  }): void
  /** Capture-complete flash: a brief bright shell pulse + spark shower. */
  captureFlash(id: number | string): boolean
  /** Surface Y at a world XZ (0 on the flat pad) — what `grounded` clamps to. */
  terrainHeightAt(x: number, z: number): number
  /** Smoothed surface normal at a world XZ. */
  terrainNormalAt(x: number, z: number): [number, number, number]
  /** Apply a renderer quality preset: 'standard' | 'cinematic'. */
  setQuality(name: string): boolean
  /** Most recent frame's cull counters: { drew, culled, total, … }. */
  stats(): { drew: number; culled: number; total: number; shadowed: number; full: number; mid: number; far: number }
  units(): Array<number | string>
  dispose(): void
}

export function createWorld(
  canvas: HTMLCanvasElement,
  opts: {
    assets: AssetProvider
    game?: {
      /** Defaults to the TA player palette (TA_TEAM_SIDES) when omitted. */
      teamSides?: unknown[]
      lodHidePatterns?: RegExp[]
      projectileFallbackColors?: Record<string, unknown>
    }
    environment?: string | object | null
    /** Renderer quality preset: 'standard' (default) | 'cinematic'. */
    quality?: string
    controls?: boolean
    autoStart?: boolean
    contextAttributes?: WebGLContextAttributes
  },
): Promise<World>

// ── Renderer stack (deep-integration surface) ─────────────────────────
// Intentionally loose: these classes predate the type surface and are
// documented in their modules; the types pin construction shapes only.

export class Mat4 {
  static create(): Float32Array
  static identity(out: Float32Array): Float32Array
  static multiply(out: Float32Array, a: Float32Array, b: Float32Array): Float32Array
  static perspective(out: Float32Array, fovy: number, aspect: number, near: number, far: number): Float32Array
  static translate(out: Float32Array, a: Float32Array, x: number, y: number, z: number): Float32Array
  static rotateX(out: Float32Array, a: Float32Array, rad: number): Float32Array
  static rotateY(out: Float32Array, a: Float32Array, rad: number): Float32Array
  static rotateZ(out: Float32Array, a: Float32Array, rad: number): Float32Array
  static lookAt(out: Float32Array, eye: number[], center: number[], up: number[]): Float32Array
  [key: string]: unknown
}

export class TAPalette {
  constructor(rgbTriples: PaletteTriples)
  entries: PaletteTriples
  colorFor(index: number): [number, number, number, number]
  static load(): Promise<TAPalette>
}

export class TextureCache {
  constructor(gl: WebGLRenderingContext)
  get(name: string): unknown
  ensure(names: string[]): Promise<void>
  dispose(): void
  [key: string]: unknown
}

export class Piece {
  name: string
  move: [number, number, number]
  rotate: [number, number, number]
  visible: boolean
  [key: string]: unknown
}

export class Model {
  name: string
  root: Piece | null
  flat: Piece[]
  cloneForInstance(): Model
  dispose(gl: WebGLRenderingContext): void
  [key: string]: unknown
}

export class ModelLoader {
  constructor(opts: { gl: WebGLRenderingContext; palette: TAPalette; textureCache: TextureCache })
  load(modelName: string): Promise<Model>
}
export function setLodHidePatterns(patterns: RegExp[]): void

export class OrbitCamera {
  constructor(opts?: object)
  yaw: number
  pitch: number
  distance: number
  [key: string]: unknown
}

export class ModelRenderer {
  constructor(opts: { canvas: HTMLCanvasElement; textureCache: TextureCache; gl: WebGLRenderingContext })
  init(): Promise<void>
  start(): void
  stop(): void
  draw(): void
  dispose(): void
  running: boolean
  setCamera(camera: OrbitCamera): void
  setModel(model: Model | null): void
  setEntities(entities: object[] | null): void
  setEnvironment(nameOrPreset: string | object): void
  setPulseLights(lights: Array<{ pos: number[]; color: number[]; strength: number }>): void
  /** Install baked map-feature batches (buildFeatureField output). */
  setMapFeatures(batches: Array<{ data: Float32Array; count: number }> | null): void
  clearMapFeatures(): void
  setFeaturesEnabled(on: boolean): void
  /** Install this frame's explosion triangles (ExplosionManager tris/vertCount). */
  setExplosionTris(data: Float32Array | null, vertCount: number): void
  requestRedraw(): void
  getCullStats(): { drew: number; culled: number; total: number; shadowed: number; full: number; mid: number; far: number }
  [key: string]: unknown
}

export class ModelViewer {
  constructor(opts: { canvas?: HTMLCanvasElement; statusEl?: Element; onModelLoaded?: (model: Model, cob: unknown) => void; sceneFactory?: (opts: object) => unknown })
  open(modelName: string): Promise<void>
  dispose(): void
  [key: string]: unknown
}

export function attachOrbitControls(opts: {
  canvas: HTMLCanvasElement
  renderer: ModelRenderer
  camera: OrbitCamera
  [key: string]: unknown
}): () => void

export class ArmedCursor {
  constructor(opts: { canvas: HTMLCanvasElement; host?: Element })
  setSlot(slot: string | null): void
  dispose(): void
  [key: string]: unknown
}

export class AudioPool {
  play(stem: string, opts?: { pos?: number[]; vol?: number; kind?: string; source?: string }): number
  setPlaybackRate(rate: number): void
  setPaused(paused: boolean): void
  [key: string]: unknown
}

// ── Map-feature stand-ins + polygonal explosions ───────────────────────

export function featureSeed(name: string, ax: number, ay: number): number
export function mulberry32(seed: number): () => number
export function categoryBuilder(category: string): (...args: unknown[]) => void
export function featureSizeWU(def: object | null): { r: number; h: number }
/**
 * Bake a packed map's feature placements into renderer batches + a list of
 * real-3DO features.  Deterministic per (name, cell); see map-features.js.
 */
export function buildFeatureField(opts: {
  features: Array<{ name: string; ax: number; ay: number }>
  defs?: Record<string, object>
  heightAt?: ((x: number, z: number) => number) | null
  cellWU?: number
}): {
  batches: Array<{ data: Float32Array; count: number }>
  models: Array<{ name: string; x: number; y: number; z: number; heading: number; feature: string }>
  counts: { placed: number; models: number; skipped: number }
}

export const MAX_CONCURRENT: number
export const MAX_PER_BUCKET: number
export const COALESCE_BUCKET_WU: number
export const BUDGET_FREE_COUNT: number
export function tierFor(opts: { aoe?: number; kind?: string; severity?: number }): string
/**
 * Capped, coalescing polygonal explosion system (fireball + shards +
 * shockwave ring as additive triangles) — see explosion-fx.js for the
 * readability disciplines.  createWorld owns one; standalone drivers can
 * run their own against ModelRenderer.setExplosionTris.
 */
export class ExplosionManager {
  liveCount: number
  spawn(pos: [number, number, number], opts?: { aoe?: number; kind?: 'impact' | 'death' | 'splash'; severity?: number }): object | null
  step(dtMs: number): void
  tris(): Float32Array
  vertCount(): number
  lights(): Array<{ pos: number[]; color: number[]; strength: number }>
  clear(): void
}

export class ExplosionOverlay {
  constructor(canvas: HTMLCanvasElement, project: (world: number[]) => { x: number; y: number; depth: number; pxPerWU: number } | null)
  [key: string]: unknown
}

export function attachUnitHotkeys(opts: object): () => void

// Weapon / projectile visuals
export class SmokeTrailManager {
  [key: string]: unknown
}
export function setProjectileFallbackColors(colors: Record<string, unknown> | null | undefined): void
export function projectileColor(weapon: unknown, kind: string, palette: TAPalette): number[]
export function laserColor(weapon: unknown, palette: TAPalette): number[]
export function pickProjectileKind(weapon: unknown): string
export function projectileSize(weapon: unknown, kind: string): number
export function projectileLightStrength(weapon: unknown, kind: string): number
export function spawnLaserBeam(opts: object): void
export function spawnProjectile(opts: object): void
export function spawnProjectileInFlight(opts: object): void
export function playWeaponSound(opts: object): void
export function loadWeaponBitmap(weaponName: string): Promise<object | null>
export function clearWeaponBitmapCache(): void

// World FX (world-fx.js) — the data-driven weapon/death presentation
// createWorld's weaponEffect/unitDeath build on; exported for drivers and
// headless tests.
export function normalizePackWeaponDef(id: string, def: object | null): object | null
export function weaponVisualPlan(w: object | null): 'beam' | 'model' | 'particle'
export function spawnWeaponVisual(opts: object): object | null
export function impactBurst(binding: object, pos: number[], opts?: { aoe?: number; sparks?: boolean }): void
export function resolveDeathPlan(opts?: { severity?: number; corpse?: string | null; heapCorpse?: string | null }): { debris: boolean; corpse: string | null }
export function damageSmokeIntervalMs(hp01: number | null | undefined): number | null

// Team + texture configuration
/** TA's player-colour table (side 0..7) — the default createWorld installs; map a recording's player slot onto `side` with it. */
export const TA_TEAM_SIDES: Array<{ side: number; key: string; label: string; rgb: [number, number, number] | null; swatchCss: string }>
export const TEAM_SIDES: unknown[]
export function setTeamSides(sides: unknown[] | null | undefined): void
export function teamColorForSide(side: number): [number, number, number]
export function displayRgbForSide(side: number): string
export function sideForKey(key: string): number
export function setEnhanceMeshEnabled(on: boolean): void
export function enhanceMeshEnabled(): boolean
export function onEnhanceMeshChanged(cb: () => void): () => void
export function resolveTextureHints(name: string): object
export function setTextureHintOverride(name: string, patch: object): void
export function clearTextureHintOverride(name: string): void
export function hasTextureHintOverride(name: string): boolean

// Worlds / environments
export function loadWorlds(): Promise<void>
export const WORLD_LIST: Array<{ env: string; icon?: string; label: string; title?: string }>
export const SKY_PRESETS: Record<string, object>
export const ENVIRONMENT_PRESETS: Record<string, object>
export const GRAVITY_BY_ENV: Record<string, number>
export const GRAVITY_EARTH: number

// Scene lighting + particles
export const MAX_PULSE_LIGHTS: number
export function setMaxSceneLights(n: number): void
export function getMaxSceneLights(): number
export function gatherSceneLights(pools: Iterable<unknown>, max?: number): Array<{ pos: number[]; color: number[]; strength: number }>
export class ParticlePool {
  [key: string]: unknown
}
