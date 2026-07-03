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

export function setAssetProvider(provider: AssetProvider | null): void
export function getAssetProvider(): AssetProvider | null
export function requireAssetProvider(): AssetProvider
export function toTexImageSource(result: Blob | TexSource): Promise<TexSource>

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
  heading?: number
  pitch?: number
  buildPercent?: number
  side?: number
  teamColor?: [number, number, number]
  dead?: boolean
  /** Indexed like Model.flat. */
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

export interface WorldSnapshot {
  units?: SnapshotUnit[]
  projectiles?: SnapshotProjectile[]
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
      teamSides?: unknown[]
      lodHidePatterns?: RegExp[]
      projectileFallbackColors?: Record<string, unknown>
    }
    environment?: string | object | null
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

// Team + texture configuration
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
