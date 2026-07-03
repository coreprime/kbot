// ESM loader for the deterministic KBot simulation engine (engine.wasm).
//
// The wasm module is the studio's sim core compiled with GOOS=js/GOARCH=wasm.
// On start it registers a `KbotEngine` object on globalThis and then parks, so
// the module stays resident for the life of the page / process. This loader
// hides those mechanics behind a promise and wraps the flat handle-based API
// in a small Session class.
//
// The engine is a singleton per JS realm: the wasm module claims the one
// `KbotEngine` global, so repeated loadEngine() calls resolve to the same
// instance (the first call's wasm source wins). Multiple concurrent
// simulations are supported through createSession(), not multiple modules.

import './wasm/wasm_exec.js'

let enginePromise = null

/**
 * Load (or return the already-loaded) engine.
 * @param {{ wasmUrl?: string | URL, wasmBytes?: BufferSource }} [opts]
 */
export function loadEngine(opts = {}) {
  if (!enginePromise) enginePromise = instantiate(opts)
  return enginePromise
}

async function instantiate({ wasmUrl, wasmBytes } = {}) {
  const go = new globalThis.Go()
  let result
  if (wasmBytes) {
    result = await WebAssembly.instantiate(asArrayBuffer(wasmBytes), go.importObject)
  } else {
    const url = resolveUrl(wasmUrl ?? new URL('./wasm/engine.wasm', import.meta.url))
    result = await WebAssembly.instantiate(await fetchBytes(url), go.importObject)
  }
  // run() resolves only when the Go program exits; the engine parks forever,
  // so start it without awaiting and wait for the API global to appear.
  go.run(result.instance)
  const api = await waitForApi()
  return new Engine(api)
}

function resolveUrl(url) {
  return typeof url === 'string' ? new URL(url, import.meta.url) : url
}

async function fetchBytes(url) {
  if (url.protocol === 'file:') {
    // Node: fetch() rejects file: URLs, so read from disk instead. The
    // indirection keeps bundlers from trying to resolve the node builtin.
    const fs = await import(/* @vite-ignore */ 'node:fs/promises')
    const buf = await fs.readFile(url)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`engine.wasm fetch failed: ${resp.status} ${url}`)
  return resp.arrayBuffer()
}

function asArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

async function waitForApi() {
  for (let i = 0; i < 500; i++) {
    if (globalThis.KbotEngine) return globalThis.KbotEngine
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('engine.wasm started but never registered KbotEngine')
}

/** The loaded engine module: a session factory plus the raw flat API. */
export class Engine {
  /** @param {Record<string, Function>} api */
  constructor(api) {
    /** Raw handle-based wasm exports (create/destroy/addUnit/...). */
    this.raw = api
  }

  /**
   * Create an isolated deterministic simulation.
   * @param {{ seed?: number, inputDelay?: number, resolveUnit?: (name: string) => object | null }} [opts]
   */
  createSession({ seed = 0, inputDelay = 0, resolveUnit } = {}) {
    const handle = this.raw.create(seed, inputDelay, resolveUnit)
    return new Session(this.raw, handle)
  }
}

/** One simulation instance; methods mirror the wasm exports minus the handle. */
export class Session {
  #api
  #handle

  constructor(api, handle) {
    this.#api = api
    this.#handle = handle
  }

  get handle() {
    return this.#handle
  }

  /**
   * Insert a unit directly; returns its unit id. headingRad follows the
   * game convention every boundary heading uses: 0 faces -Z (map north),
   * the unit moves along (-sin, -cos) of it — convert a recording's uint16
   * heading with @kbot/game3d's headingToRadians and pass it straight in.
   */
  addUnit(meta, x, z, headingRad = 0, side = 1) {
    return this.#api.addUnit(this.#handle, meta, x, z, headingRad, side)
  }

  removeUnit(unitId) {
    this.#api.removeUnit(this.#handle, unitId)
  }

  submitMove(unitIds, x, z, queued = false) {
    return this.#api.submitMove(this.#handle, unitIds, x, z, queued)
  }

  submitAttack(unitIds, targetUnitId, queued = false) {
    return this.#api.submitAttack(this.#handle, unitIds, targetUnitId, queued)
  }

  submitFire(unitId, slot, targetUnitId = 0, x = 0, z = 0) {
    return this.#api.submitFire(this.#handle, unitId, slot, targetUnitId, x, z)
  }

  submitStop(unitIds) {
    return this.#api.submitStop(this.#handle, unitIds)
  }

  submitBuild(builderId, name, x, z, queued = false, headingRad = 0) {
    return this.#api.submitBuild(this.#handle, builderId, name, x, z, queued, headingRad)
  }

  submitPatrol(unitIds, x, z) {
    return this.#api.submitPatrol(this.#handle, unitIds, x, z)
  }

  submitStance(unitIds, moveMode, fireMode) {
    return this.#api.submitStance(this.#handle, unitIds, moveMode, fireMode)
  }

  submitSelfDestruct(unitIds) {
    return this.#api.submitSelfDestruct(this.#handle, unitIds)
  }

  submitRepair(builderId, targetUnitId) {
    return this.#api.submitRepair(this.#handle, builderId, targetUnitId)
  }

  submitLoad(transportIds, targetUnitId) {
    return this.#api.submitLoad(this.#handle, transportIds, targetUnitId)
  }

  submitUnload(transportIds, x, z) {
    return this.#api.submitUnload(this.#handle, transportIds, x, z)
  }

  /** Read-only build-placement legality probe. */
  canBuildAt(name, x, z) {
    return this.#api.canBuildAt(this.#handle, name, x, z)
  }

  /** Install a shared height field, or pass null to clear back to flat. */
  setTerrain(terrain) {
    return this.#api.setTerrain(this.#handle, terrain)
  }

  /** Queue an order for execution at an exact tick. */
  scheduleAt(tick, order) {
    this.#api.scheduleAt(this.#handle, tick, order)
  }

  /** Reinitialize from an authoritative snapshot. */
  restore(snapshot) {
    this.#api.restore(this.#handle, snapshot)
  }

  /** Advance one tick and return the render snapshot. */
  step() {
    return this.#api.step(this.#handle)
  }

  /**
   * step() through the packed-snapshot fast path: the engine serialises the
   * whole units array (fixed fields + piece transforms) into ONE byte
   * buffer instead of a js.Value tree, and this wrapper parses it back into
   * the classic snapshot shape — same fields, with piecesPacked as
   * zero-copy Float32Array views into the shared buffer.  At replay scale
   * (hundreds of units) this cuts the per-tick boundary cost several-fold.
   * The packed form omits the rarely-consumed extras (carrying, building,
   * prodQueue, queue) — use step() when you need those.
   */
  stepPacked() {
    return parsePackedSnapshot(this.#api.stepPacked(this.#handle))
  }

  /** stepTo() through the packed-snapshot fast path (see stepPacked). */
  stepToPacked(tick) {
    return parsePackedSnapshot(this.#api.stepToPacked(this.#handle, tick))
  }

  /** renderState() through the packed-snapshot fast path (see stepPacked). */
  renderStatePacked() {
    return parsePackedSnapshot(this.#api.renderStatePacked(this.#handle))
  }

  /**
   * Advance tick by tick until the world reaches the target tick and return
   * the last render snapshot — the replay seek clock. A target at or before
   * the current tick steps nothing and returns the current state (rewind is
   * restore() + stepTo(), never a negative step).
   */
  stepTo(tick) {
    return this.#api.stepTo(this.#handle, tick)
  }

  /**
   * Authoritatively overwrite one live unit's pose/state — the per-tick hook
   * replay uses to pin units to decoded wire truth. Only the keys present on
   * state are applied: pos {x,y,z} in world units, heading in radians (game
   * convention: 0 faces -Z / north — headingToRadians of the wire value, no
   * offsets), vel in world units/sec, hp and build on their 0..100 scales.
   * The unit must already exist; returns false for a missing id (create it
   * first).
   */
  setUnitState(unitId, state) {
    return this.#api.setUnitState(this.#handle, unitId, state)
  }

  /**
   * Play a unit's aim + fire COB scripts pointed at the world-unit target —
   * the replay driver's WeaponFire hook (turret swing, recoil, muzzle
   * flash). Presentation only: no projectile spawns and no damage applies.
   * Returns false for a missing or script-less unit so the driver can fall
   * back to a renderer-side tracer.
   */
  playWeaponFire(unitId, slot, tx, ty, tz) {
    return this.#api.playWeaponFire(this.#handle, unitId, slot, tx, ty, tz)
  }

  /**
   * Run a unit's Activate (on) / Deactivate (off) COB entry point and pin
   * the ACTIVATION port — the replay driver's building-activity hook
   * (extractor rotor spin, solar collector open/close). Presentation only.
   * Returns false for a missing or script-less unit.
   */
  setUnitActivation(unitId, on) {
    return this.#api.setUnitActivation(this.#handle, unitId, !!on)
  }

  /** Spawn a thread on the named COB entry point with integer args. */
  startScript(unitId, name, args = []) {
    this.#api.startScript(this.#handle, unitId, name, args)
  }

  /** Start the named script after cancelling any live instance of it. */
  restartScript(unitId, name, args = []) {
    this.#api.restartScript(this.#handle, unitId, name, args)
  }

  /** Kill every live thread running the named script. */
  killThreadsByName(unitId, name) {
    this.#api.killThreadsByName(this.#handle, unitId, name)
  }

  /**
   * The unit type's COB entry-point names in script-index order — the table
   * that resolves a recorded CobScriptCall's numeric index to a name.
   */
  scriptNames(unitId) {
    return this.#api.scriptNames(this.#handle, unitId)
  }

  /**
   * The unit's COB piece table in piece-index order — the names that pair
   * with the snapshot's packed piece transforms (piecesPacked) so per-piece
   * state applies BY NAME. COB table order is not the model hierarchy
   * order; index-blind application puts a Samson's hidden build flares on
   * its body. Empty for script-less units.
   */
  pieceNames(unitId) {
    return this.#api.unitPieceNames(this.#handle, unitId)
  }

  /** Render snapshot at the current tick without advancing. */
  renderState() {
    return this.#api.renderState(this.#handle)
  }

  /** Authoritative wire-shaped state export (raw fixed-point integers). */
  exportSnapshot() {
    return this.#api.exportSnapshot(this.#handle)
  }

  /** World hash as a decimal string (uint64-safe). */
  hash() {
    return this.#api.hash(this.#handle)
  }

  tick() {
    return this.#api.tick(this.#handle)
  }

  /** Live COB script inspection snapshot. */
  cobState() {
    return this.#api.cobState(this.#handle)
  }

  destroy() {
    this.#api.destroy(this.#handle)
  }
}

// ── Packed-snapshot parser ─────────────────────────────────────────────
//
// Mirrors cmd/engine-wasm/convert.go snapshotToPackedJS: a 4-word header
// (version, tick, unitCount, pieceFloatsTotal), unitCount fixed 20-word
// records, then every unit's stride-7 piece floats back to back.  Unit
// objects come back in the classic snapshot field shape; piecesPacked are
// SUBARRAY VIEWS into the shared Float32Array — no per-unit copies.
const PACKED_UNIT_WORDS = 20

function parsePackedSnapshot(raw) {
  if (!raw || !raw.unitsPacked) return raw
  const bytes = raw.unitsPacked
  const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
  const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
  const i32 = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
  const version = u32[0]
  if (version !== 1) throw new Error(`packed snapshot version ${version} unsupported`)
  const unitCount = u32[2]
  const names = raw.names || []
  const pieceBase = 4 + unitCount * PACKED_UNIT_WORDS
  const units = new Array(unitCount)
  for (let i = 0; i < unitCount; i++) {
    const w = 4 + i * PACKED_UNIT_WORDS
    const flags = u32[w + 3]
    const pieceOff = u32[w + 18]
    const pieceFloats = u32[w + 19]
    units[i] = {
      id: u32[w],
      name: names[u32[w + 1]] || '',
      side: i32[w + 2],
      dead: (flags & 1) !== 0,
      isMoving: (flags & 2) !== 0,
      hasMove: (flags & 4) !== 0,
      x: f32[w + 4],
      y: f32[w + 5],
      z: f32[w + 6],
      headingRad: f32[w + 7],
      heading: f32[w + 8],
      speed: f32[w + 9],
      health: f32[w + 10],
      buildPercent: f32[w + 11],
      moveX: f32[w + 12],
      moveZ: f32[w + 13],
      moveMode: u32[w + 14],
      fireMode: u32[w + 15],
      selfDestructMs: u32[w + 16],
      carriedBy: u32[w + 17],
      piecesPacked: pieceFloats > 0
        ? f32.subarray(pieceBase + pieceOff, pieceBase + pieceOff + pieceFloats)
        : null,
    }
  }
  return {
    tick: u32[1],
    units,
    projos: raw.projos || [],
    events: raw.events || [],
  }
}
