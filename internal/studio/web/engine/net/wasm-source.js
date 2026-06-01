// wasm-source.js
//
// FrameSource backed by the deterministic Go engine compiled to WebAssembly
// (cmd/engine-wasm).  The same simulation code runs here in the browser as on
// the authoritative server, which is what lets a client predict locally and
// reconcile against server snapshots without drift.
//
// The wasm module is loaded once per page and shared by every session.  Build
// it with `task build-wasm`, which emits engine.wasm + wasm_exec.js alongside
// this file.

import { FrameSource } from './frame-source.js'

// Module path of the compiled engine, relative to this file.
const WASM_URL = new URL('../engine.wasm', import.meta.url)
const WASM_EXEC_URL = new URL('../wasm_exec.js', import.meta.url)

let goReady = null

// loadGo injects Go's wasm_exec.js (a classic script that defines globalThis.Go)
// and instantiates the engine module.  Returns a promise that resolves once
// globalThis.KbotEngine is live.  Cached so repeated source construction shares
// one module instance.
function loadGo() {
  if (goReady) return goReady
  goReady = (async () => {
    if (typeof globalThis.Go === 'undefined') {
      await injectScript(WASM_EXEC_URL.href)
    }
    const go = new globalThis.Go()
    const result = await WebAssembly.instantiateStreaming(fetch(WASM_URL.href), go.importObject)
    // go.run never resolves while the module is parked in select{}; that is
    // intentional — it keeps the exported KbotEngine callable for the page's
    // lifetime.  We don't await it.
    go.run(result.instance)
    if (!globalThis.KbotEngine) {
      throw new Error('wasm engine loaded but KbotEngine was not exported')
    }
    return globalThis.KbotEngine
  })()
  return goReady
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(el)
  })
}

export class WasmFrameSource extends FrameSource {
  // spawnResolver, when supplied, is a synchronous function (name) -> metaObject
  // the engine calls to back a Spawn order (the networked path, where the
  // authoritative command stream introduces units by type name).  It must be
  // synchronous and deterministic, so callers pre-populate a meta cache.
  constructor({ seed = 0, inputDelay = 0, spawnResolver = null } = {}) {
    super()
    this._seed = seed >>> 0
    this._inputDelay = inputDelay >>> 0
    this._spawnResolver = spawnResolver
    this._engine = null
    this._handle = -1
    this._ready = null
  }

  // ready resolves once the wasm module is loaded and this source owns a live
  // engine handle.  Callers must await it before issuing orders or stepping.
  ready() {
    if (!this._ready) {
      this._ready = loadGo().then((engine) => {
        this._engine = engine
        this._handle = this._spawnResolver
          ? engine.create(this._seed, this._inputDelay, this._spawnResolver)
          : engine.create(this._seed, this._inputDelay)
      })
    }
    return this._ready
  }

  // addUnit introduces a unit directly (offline / authoring path).  spec mirrors
  // the legacy engine: { name, meta, x, z, headingRad, side }.  meta is the
  // /api/studio/unit shape.
  addUnit({ name, meta, x = 0, z = 0, headingRad = 0, side = 0 }) {
    const m = meta || { name }
    if (!m.name) m.name = name
    return this._engine.addUnit(this._handle, m, x, z, headingRad, side)
  }

  removeUnit(id) { this._engine.removeUnit(this._handle, id) }

  move(unitIds, x, z) { return this._engine.submitMove(this._handle, unitIds, x, z) }
  attack(unitIds, targetId) { return this._engine.submitAttack(this._handle, unitIds, targetId) }
  stop(unitIds) { return this._engine.submitStop(this._handle, unitIds) }

  // scheduleAt queues an authoritative order at an exact tick.  The networked
  // source uses it to apply command frames the server broadcasts.
  scheduleAt(tick, order) { this._engine.scheduleAt(this._handle, tick, order) }

  // restore reinitializes the world from an authoritative snapshot so a client
  // joining a match already in progress sees the current unit set.  The
  // networked source calls it when the server sends a snapshot.
  restore(snapshot) { this._engine.restore(this._handle, snapshot) }

  // step advances one simulation tick, fans out the tick's events, and returns
  // the render snapshot.
  step() {
    const snap = this._engine.step(this._handle)
    this.tick = snap.tick
    this._fanOutEvents(snap)
    return snap
  }

  // hash returns the authoritative-comparable world hash as a decimal string.
  hash() { return this._engine.hash(this._handle) }

  dispose() {
    if (this._engine && this._handle >= 0) {
      this._engine.destroy(this._handle)
      this._handle = -1
    }
  }
}
