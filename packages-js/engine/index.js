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

  /** Insert a unit directly; returns its unit id. */
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
   * state are applied: pos {x,y,z} in world units, heading in radians, vel in
   * world units/sec, hp and build on their 0..100 scales. The unit must
   * already exist; returns false for a missing id (create it first).
   */
  setUnitState(unitId, state) {
    return this.#api.setUnitState(this.#handle, unitId, state)
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
