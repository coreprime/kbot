// Type declarations for the KBot engine ESM loader.

/** Options accepted by loadEngine(). */
export interface LoadEngineOptions {
  /** Location of engine.wasm; defaults to the copy bundled in this package. */
  wasmUrl?: string | URL
  /** Pre-fetched wasm bytes; takes precedence over wasmUrl. */
  wasmBytes?: BufferSource
}

/** Weapon stat block attached to a unit meta object. */
export interface WeaponMeta {
  name: string
  rangeWU?: number
  reloadSec?: number
  burst?: number
  commandFire?: boolean
  energyPerShot?: number
  metalPerShot?: number
  damageDefault?: number
  tolerance?: number
  model?: string
  beamWeapon?: boolean
  velocityWU?: number
  startVelocityWU?: number
  accelerationWU?: number
  turnRate?: number
  flightTimeSec?: number
  areaOfEffectWU?: number
  dropped?: boolean
  vlaunch?: boolean
  tracks?: boolean
  selfProp?: boolean
  ballistic?: boolean
}

/**
 * Unit stat block consumed by addUnit / the spawn resolver — the shape the
 * studio's unit endpoint returns. All fields are optional; absent numerics
 * read as zero and absent booleans as false.
 */
export interface UnitMeta {
  name: string
  maxVelocity?: number
  turnRate?: number
  acceleration?: number
  brakeRate?: number
  canMove?: boolean
  isAircraft?: boolean
  isHover?: boolean
  isShip?: boolean
  isSub?: boolean
  isHovercraft?: boolean
  isBuilder?: boolean
  onoffable?: boolean
  activateWhenBuilt?: boolean
  buildTime?: number
  workerTime?: number
  buildDistance?: number
  footprintX?: number
  footprintZ?: number
  yardMap?: string
  transportSlots?: number
  maxSlope?: number
  maxWaterDepth?: number
  minWaterDepth?: number
  costMetal?: number
  costEnergy?: number
  costMana?: number
  standingMoveOrder?: number
  standingFireOrder?: number
  makesMetal?: number
  makesEnergy?: number
  makesMana?: number
  storesMetal?: number
  storesEnergy?: number
  storesMana?: number
  cruiseAltitude?: number
  maxDamage?: number
  weapons?: WeaponMeta[]
  /** Raw COB bytecode driving the unit's piece animation. */
  cob?: Uint8Array
  [key: string]: unknown
}

/** Terrain height field shared by every lockstep peer. */
export interface TerrainSpec {
  w: number
  h: number
  cellWU: number
  heightScale: number
  seaLevel: number
  slopeScalePct?: number
  data: Uint8Array
  voids?: Uint8Array
}

/** Per-unit render state inside a Snapshot. */
export interface SnapshotUnit {
  id: number
  name: string
  side: number
  x: number
  y: number
  z: number
  heading: number
  headingRad: number
  speed: number
  health: number
  dead: boolean
  buildPercent: number
  isMoving: boolean
  hasMove: boolean
  moveX: number
  moveZ: number
  moveMode: number
  fireMode: number
  selfDestructMs: number
  /** Packed piece transforms: Float32 stride-7 (ox,oy,oz,rx,ry,rz,visible). */
  piecesPacked: Uint8Array | null
  [key: string]: unknown
}

/** Render snapshot returned by step() / renderState(). */
export interface Snapshot {
  tick: number
  units: SnapshotUnit[]
  projos: Record<string, unknown>[]
  events: Record<string, unknown>[]
  resources?: Record<string, unknown>[]
  [key: string]: unknown
}

export interface CreateSessionOptions {
  /** Deterministic seed shared by every lockstep peer. */
  seed?: number
  /** Ticks between submit and execution (lockstep input delay). */
  inputDelay?: number
  /** Resolver backing Spawn orders: unit name to UnitMeta (or null). */
  resolveUnit?: (name: string) => UnitMeta | null | undefined
}

/** The loaded engine module. */
export class Engine {
  /** Raw handle-based wasm exports (create/destroy/addUnit/...). */
  raw: Record<string, (...args: unknown[]) => unknown>
  createSession(opts?: CreateSessionOptions): Session
}

/** One deterministic simulation instance. */
export class Session {
  get handle(): number
  addUnit(meta: UnitMeta, x: number, z: number, headingRad?: number, side?: number): number
  removeUnit(unitId: number): void
  submitMove(unitIds: number[], x: number, z: number, queued?: boolean): number
  submitAttack(unitIds: number[], targetUnitId: number, queued?: boolean): number
  submitFire(unitId: number, slot: number, targetUnitId?: number, x?: number, z?: number): number
  submitStop(unitIds: number[]): number
  submitBuild(builderId: number, name: string, x: number, z: number, queued?: boolean, headingRad?: number): number
  submitPatrol(unitIds: number[], x: number, z: number): number
  submitStance(unitIds: number[], moveMode: number, fireMode: number): number
  submitSelfDestruct(unitIds: number[]): number
  submitRepair(builderId: number, targetUnitId: number): number
  submitLoad(transportIds: number[], targetUnitId: number): number
  submitUnload(transportIds: number[], x: number, z: number): number
  canBuildAt(name: string, x: number, z: number): boolean
  setTerrain(terrain: TerrainSpec | null): boolean
  scheduleAt(tick: number, order: Record<string, unknown>): void
  restore(snapshot: Record<string, unknown>): void
  step(): Snapshot
  renderState(): Snapshot
  exportSnapshot(): Record<string, unknown>
  hash(): string
  tick(): number
  cobState(): Record<string, unknown>
  destroy(): void
}

/**
 * Load (or return the already-loaded) engine. The engine is a singleton per
 * JS realm; concurrency comes from multiple sessions, not multiple modules.
 */
export function loadEngine(opts?: LoadEngineOptions): Promise<Engine>
