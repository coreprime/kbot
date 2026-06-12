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

// _wasmOutputTail keeps the last chunk of the Go program's console output
// (panic messages + goroutine stacks land here via wasm_exec's fs shim) so a
// crash can be diagnosed after the fact — the engine parks in select{}
// forever, so go.run() resolving at all means the program died.
const _wasmOutputTail = []
const _WASM_TAIL_MAX = 16384

// _captureWasmOutput wraps the fs.writeSync shim wasm_exec.js installs so
// every byte the Go runtime writes is mirrored into _wasmOutputTail. The
// original shim still runs (console logging is unchanged).
function _captureWasmOutput() {
  const fs = globalThis.fs
  if (!fs || typeof fs.writeSync !== 'function' || fs.__kbotCaptured) return
  fs.__kbotCaptured = true
  const orig = fs.writeSync.bind(fs)
  const dec = new TextDecoder('utf-8')
  fs.writeSync = (fd, buf) => {
    try {
      _wasmOutputTail.push(dec.decode(buf))
      let total = 0
      for (let i = _wasmOutputTail.length - 1; i >= 0; i--) {
        total += _wasmOutputTail[i].length
        if (total > _WASM_TAIL_MAX) {
          _wasmOutputTail.splice(0, i)
          break
        }
      }
    } catch { /* capture is best-effort; never break the shim */ }
    return orig(fd, buf)
  }
}

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
    _captureWasmOutput()
    const go = new globalThis.Go()
    const result = await WebAssembly.instantiateStreaming(fetch(WASM_URL.href), go.importObject)
    // go.run never resolves while the module is parked in select{}; that is
    // intentional — it keeps the exported KbotEngine callable for the page's
    // lifetime.  We don't await it.  If it DOES resolve the engine panicked
    // (or os.Exit'd): preserve the captured output for diagnosis and let the
    // page know — every wasm-backed sim on this page is now dead.
    go.run(result.instance).then(() => {
      const output = _wasmOutputTail.join('')
      globalThis.__KBOT_WASM_CRASH = { output }
      console.error('KBot wasm engine exited — every sandbox/viewer sim on this page is dead. Captured output:\n' + output)
      try {
        window.dispatchEvent(new CustomEvent('kbot-wasm-crash', { detail: { output } }))
      } catch { /* event dispatch is best-effort */ }
    })
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

  // queued (the shift-click gesture) appends the order to each unit's queue
  // instead of replacing its current orders.
  move(unitIds, x, z, queued = false) { return this._engine.submitMove(this._handle, unitIds, x, z, !!queued) }
  attack(unitIds, targetId, queued = false) { return this._engine.submitAttack(this._handle, unitIds, targetId, !!queued) }

  // fire force-fires one unit's weapon slot.  A nonzero targetUnit aims the slot
  // at that unit; otherwise it fires at the ground point (px, pz) — the
  // shift-to-ground path.  Distinct from attack(), which is a standing order.
  fire(unitId, slot, targetUnit = 0, px = 0, pz = 0) {
    return this._engine.submitFire(this._handle, unitId, slot, targetUnit, px, pz)
  }

  stop(unitIds) { return this._engine.submitStop(this._handle, unitIds) }

  // build sends one mobile builder to construct unit type `name` at the
  // ground point — walk into builddistance, then raise the buildee to 100%.
  build(builderId, name, x, z) { return this._engine.submitBuild(this._handle, builderId, name, x, z) }

  // patrol appends a patrol waypoint to each unit's queue (consecutive
  // patrol legs loop); stance sets the standing move/fire orders;
  // selfDestruct toggles the 5-second fuse.
  patrol(unitIds, x, z) { return this._engine.submitPatrol(this._handle, unitIds, x, z) }
  stance(unitIds, moveMode, fireMode) { return this._engine.submitStance(this._handle, unitIds, moveMode, fireMode) }
  selfDestruct(unitIds) { return this._engine.submitSelfDestruct(this._handle, unitIds) }

  // load sends transports to pick up a unit; unload sets their cargo down
  // at a ground point.
  load(transportIds, targetUnit) { return this._engine.submitLoad(this._handle, transportIds, targetUnit) }
  unload(transportIds, x, z) { return this._engine.submitUnload(this._handle, transportIds, x, z) }

  // scheduleAt queues an authoritative order at an exact tick.  The networked
  // source uses it to apply command frames the server broadcasts.
  scheduleAt(tick, order) { this._engine.scheduleAt(this._handle, tick, order) }

  // restore reinitializes the world from an authoritative snapshot so a client
  // joining a match already in progress sees the current unit set.  The
  // networked source calls it when the server sends a snapshot. The public tick
  // is advanced to the restored tick so callers reading `tick` (the join
  // catch-up loop, the COB/Runtime panels) reflect the authority's clock
  // immediately rather than a stale pre-restore value.
  restore(snapshot) {
    this._engine.restore(this._handle, snapshot)
    if (snapshot && typeof snapshot.tick === 'number') this.tick = snapshot.tick
  }

  // renderState returns the render snapshot of the world at its CURRENT tick
  // without advancing it. The networked source uses it after a restore to paint
  // the authority's units immediately — including while the shared clock is
  // paused, where step() would never run. Null before the engine has a handle.
  renderState() {
    if (!this._engine || this._handle < 0) return null
    return this._engine.renderState(this._handle)
  }

  // step advances one simulation tick, fans out the tick's events, and returns
  // the render snapshot.
  step() {
    const snap = this._engine.step(this._handle)
    this.tick = snap.tick
    this._fanOutEvents(snap)
    return snap
  }

  // hash returns the authoritative-comparable world hash as a decimal string.
  // Null before the engine has a handle (callers treat that as "not ready").
  hash() {
    if (!this._engine || this._handle < 0) return null
    return this._engine.hash(this._handle)
  }

  // exportSnapshot returns the local world's authoritative state in the same
  // shape the server's wire snapshot serializes to (raw fixed-point integers),
  // for the Network panel's Diagnose drift comparison against the server. Does
  // not advance the world; null before the engine seeds.
  exportSnapshot() {
    if (!this._engine || this._handle < 0) return null
    return this._engine.exportSnapshot(this._handle)
  }

  // cobState returns the live COB inspection snapshot — { tick, units:[{ id,
  // name, static:[…], threads:[…] }] } — the studio's Runtime / Script
  // Variables panels render. Debug-only; reads no hashed state.
  cobState() {
    if (!this._engine || this._handle < 0) return { tick: 0, units: [] }
    return this._engine.cobState(this._handle)
  }

  // ── Developer commands ───────────────────────────────────────────
  //
  // Sandbox-only script control for the Runtime panel. They reach into the
  // engine's live COB state and never round-trip through the order stream, so
  // they are local-only (the join transport does not expose them).

  killAllThreads() {
    if (this._engine && this._handle >= 0) this._engine.killAllThreads(this._handle)
  }

  killUnitThreads(unitId) {
    if (this._engine && this._handle >= 0) this._engine.killUnitThreads(this._handle, unitId)
  }

  killThread(unitId, threadId) {
    if (this._engine && this._handle >= 0) this._engine.killThread(this._handle, unitId, threadId)
  }

  resetUnit(unitId) {
    if (this._engine && this._handle >= 0) this._engine.resetUnit(this._handle, unitId)
  }

  // ── COB debugger ─────────────────────────────────────────────────
  //
  // Offline unit-editor script debugging: single-stepping, breakpoints, variable
  // edits and coverage. Like the developer commands these mutate live VM state
  // outside the hashed contract and never cross the join transport. Each is a
  // no-op until the engine has a live handle.

  // stepThread advances one COB thread by a single instruction.
  stepThread(unitId, threadId) {
    if (this._engine && this._handle >= 0) this._engine.stepThread(this._handle, unitId, threadId)
  }

  // setThreadPc moves a thread's program counter to an instruction index.
  setThreadPc(unitId, threadId, pcIndex) {
    if (this._engine && this._handle >= 0) this._engine.setThreadPc(this._handle, unitId, threadId, pcIndex)
  }

  // setThreadLocal edits one of a thread's local variables.
  setThreadLocal(unitId, threadId, index, value) {
    if (this._engine && this._handle >= 0) this._engine.setThreadLocal(this._handle, unitId, threadId, index, value)
  }

  // setStaticVar edits one of a unit's static (global) variables.
  setStaticVar(unitId, index, value) {
    if (this._engine && this._handle >= 0) this._engine.setStaticVar(this._handle, unitId, index, value)
  }

  // addBreakpoint / removeBreakpoint toggle a breakpoint by script index + byte
  // offset (the offset the disassembly listing labels each line with).
  addBreakpoint(unitId, scriptIndex, offset) {
    if (this._engine && this._handle >= 0) this._engine.addBreakpoint(this._handle, unitId, scriptIndex, offset)
  }

  removeBreakpoint(unitId, scriptIndex, offset) {
    if (this._engine && this._handle >= 0) this._engine.removeBreakpoint(this._handle, unitId, scriptIndex, offset)
  }

  // clearBreakpoints drops every breakpoint on a unit.
  clearBreakpoints(unitId) {
    if (this._engine && this._handle >= 0) this._engine.clearBreakpoints(this._handle, unitId)
  }

  // clearBreakpointHits releases every thread parked on a breakpoint so
  // execution resumes (the debugger's Continue).
  clearBreakpointHits(unitId) {
    if (this._engine && this._handle >= 0) this._engine.clearBreakpointHits(this._handle, unitId)
  }

  // coverage returns the unit's executed byte offsets as { "<scriptIndex>":
  // [offset…] } for the debugger's coverage-dimming view.
  coverage(unitId) {
    if (!this._engine || this._handle < 0) return {}
    return this._engine.coverage(this._handle, unitId)
  }

  // ── Unit-value ports ─────────────────────────────────────────────
  //
  // The offline unit editor drives COB GET_UNIT_VALUE reads from its inspector
  // sliders — damage → HEALTH, build% → BUILD_PERCENT_LEFT, plus activation and
  // standing move/fire orders. Authoring-only: the engine answers script reads
  // from this writable store when no combat host is attached, so the join
  // transport never exposes these.

  // setUnitValue writes one COB unit-value port (TA's GetUnitValue table index).
  setUnitValue(unitId, port, value) {
    if (this._engine && this._handle >= 0) this._engine.setUnitValue(this._handle, unitId, port, value)
  }

  // getUnitValue reads back one port — the value a script's GET_UNIT_VALUE would
  // yield now (an explicit write, else TA's resting default).
  getUnitValue(unitId, port) {
    if (!this._engine || this._handle < 0) return 0
    return this._engine.getUnitValue(this._handle, unitId, port)
  }

  // ── Script invocation ────────────────────────────────────────────
  //
  // The offline unit editor's Actions panel runs a unit's named COB entry
  // points (Create, Activate, AimPrimary, …), lists the available ones, and
  // retracts a transient pose handler. Authoring-only: these reach the engine's
  // live VM directly and never cross the join transport.

  // startScript spawns a thread on the named entry point; args is an optional
  // integer array passed as the script's initial locals.
  startScript(unitId, name, args = []) {
    if (this._engine && this._handle >= 0) this._engine.startScript(this._handle, unitId, name, args)
  }

  // restartScript spawns the named script after cancelling any live instance of
  // it (the COB START supersede), used by per-tick re-driven aim threads.
  restartScript(unitId, name, args = []) {
    if (this._engine && this._handle >= 0) this._engine.restartScript(this._handle, unitId, name, args)
  }

  // killThreadsByName marks dead every live thread running the named script.
  killThreadsByName(unitId, name) {
    if (this._engine && this._handle >= 0) this._engine.killThreadsByName(this._handle, unitId, name)
  }

  // scriptNames lists a unit type's script entry-point names in index order.
  scriptNames(unitId) {
    if (!this._engine || this._handle < 0) return []
    return this._engine.scriptNames(this._handle, unitId)
  }

  dispose() {
    if (this._engine && this._handle >= 0) {
      this._engine.destroy(this._handle)
      this._handle = -1
    }
  }
}
