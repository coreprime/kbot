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
  /** Game-convention uint16 TA angle: 0 faces -Z (north), 65536/turn. */
  heading: number
  /** heading in radians — feeds game3d transform.headingRad directly. */
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

/**
 * Authoritative per-unit state override applied by setUnitState(). Only the
 * keys present are written; absent keys leave that part of the unit untouched.
 */
export interface UnitStateOverride {
  /** World position (world units, all three axes). */
  pos?: { x: number; y: number; z: number }
  /** Locomotion heading in radians. */
  heading?: number
  /** Scalar locomotion velocity in world units per second. */
  vel?: number
  /** Hit points on the sim's 0..100 scale. */
  hp?: number
  /** Construction progress 0..100 (below 100 the unit is inert). */
  build?: number
  /**
   * Pin the unit's motion flag to the wire's in-motion truth. The pin
   * persists until the next `moving` override: pinned-moving units coast
   * along their heading at `vel` and run their walk-cycle COB (StartMoving
   * fires on the transition), pinned-stopped units hold still (StopMoving).
   */
  moving?: boolean
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
  /**
   * Advance to the target tick and return the last snapshot (the replay seek
   * clock). A target at or before the current tick steps nothing.
   */
  stepTo(tick: number): Snapshot
  /**
   * Authoritatively overwrite one live unit's pose/state; returns false when
   * the unit does not exist.
   */
  setUnitState(unitId: number, state: UnitStateOverride): boolean
  /**
   * Play a unit's aim + fire COB scripts pointed at the world-unit target —
   * the replay driver's WeaponFire hook (turret swing, recoil, muzzle
   * flash). Presentation only: no projectile spawns and no damage applies.
   * Returns false for a missing or script-less unit.
   */
  playWeaponFire(unitId: number, slot: number, tx: number, ty: number, tz: number): boolean
  /** Spawn a thread on the named COB entry point with integer args. */
  startScript(unitId: number, name: string, args?: number[]): void
  /** Start the named script after cancelling any live instance of it. */
  restartScript(unitId: number, name: string, args?: number[]): void
  /** Kill every live thread running the named script. */
  killThreadsByName(unitId: number, name: string): void
  /** The unit type's COB entry-point names in script-index order. */
  scriptNames(unitId: number): string[]
  /** COB piece table in piece-index order (pairs with piecesPacked). */
  pieceNames(unitId: number): string[]
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
