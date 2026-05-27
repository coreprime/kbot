// cob-runtime.js
//
// Pure-JS COB script interpreter.  Designed for reuse outside the
// studio (a future game-clone can drop this module in alongside the
// renderer to get unit-script behaviour with no studio-specific
// dependencies).
//
// Architecture overview
// ─────────────────────
//
//   CobRuntime  ← one per "world" / studio tab.  Hosts many CobUnits.
//     ├── paused, playbackRate, tick accumulator  (shared)
//     ├── _units  Map<unitId, CobUnit>
//     └── tick(dtMs) drives _tickStep on every unit in lock-step.
//
//   CobUnit     ← one per loaded model.  Owns the script + animators
//                 + thread list + static vars + per-piece visibility.
//                 Multiple units in the same runtime advance together
//                 on each fixed 40 Hz tick, exactly like an in-game
//                 battle would simulate them.
//
//   CobThread   ← cooperative thread inside a unit.  Holds the
//                 instruction PC, stack, locals, signal mask.
//
// The legacy single-unit constructor `new CobRuntime(scriptJSON, hooks)`
// still works — it auto-creates one CobUnit and exposes backwards-
// compatible proxies on the runtime so the existing studio call sites
// (`runtime.staticVars`, `runtime._threads`, `runtime.start(...)`, ...)
// keep working unchanged.  New multi-unit code paths use
// `runtime.addUnit(scriptJSON, hooks)` + `runtime.removeUnit(unit)`.
//
// Threads
// ───────
// COB scripts run as cooperative threads.  Each script invocation
// spawns a thread that owns a private stack + locals + program
// counter + signal mask.  Threads yield ONLY on opcodes that
// produce a wait (SLEEP, WAIT_FOR_TURN, WAIT_FOR_MOVE) or when
// they call into another script via START_SCRIPT (which forks a
// new thread but doesn't block the caller) or CALL_SCRIPT (which
// blocks the caller until the callee returns).
//
// Signalling
// ──────────
// COB has a one-shot signal/mask model: a script can call
// signal(N) which marks every thread in the SAME UNIT whose
// signal-mask AND N is non-zero for death.  Signals do not cross
// units — one unit's AimWeapon doesn't interrupt another unit's
// threads.
//
// Piece animation
// ───────────────
// MOVE / TURN / SPIN do NOT block - they update a per-(piece, axis)
// animator that ticks each frame toward the requested target.
// WAIT_FOR_TURN / WAIT_FOR_MOVE consult those animators and put the
// thread to sleep until they finish.  Each piece exposes its
// per-axis position (translation) + rotation (radians) - the
// renderer reads these every frame to build the world matrix.
//
// Time model
// ──────────
// COB sleeps in milliseconds.  Speeds are "units per second" (for
// linear) or "TA-angle units per second" (for angular).  The
// runtime's `tick(dtMs)` is called by the host once per frame with
// the wall-clock delta in ms; every unit's animators advance
// proportionally and every sleeping thread decrements together.

import {
  OP_MOVE, OP_TURN, OP_SPIN, OP_STOP_SPIN, OP_SHOW, OP_HIDE,
  OP_CACHE, OP_DONT_CACHE, OP_DONT_SHADOW, OP_MOVE_NOW, OP_TURN_NOW,
  OP_SHADE, OP_DONT_SHADE, OP_EMIT_SFX,
  OP_WAIT_FOR_TURN, OP_WAIT_FOR_MOVE, OP_SLEEP,
  OP_PUSH_IMMEDIATE, OP_PUSH_CONSTANT, OP_PUSH_LOCAL_VAR, OP_PUSH_STATIC,
  OP_CREATE_LOCAL, OP_STACK_ALLOC, OP_POP_LOCAL_VAR, OP_POP_STATIC, OP_POP_STACK,
  OP_ADD, OP_SUB, OP_MUL, OP_DIV, OP_MOD,
  OP_BITWISE_AND, OP_BITWISE_OR, OP_BITWISE_XOR, OP_BITWISE_NOT,
  OP_RAND, OP_GET_UNIT_VALUE, OP_GET,
  OP_LESS_THAN, OP_LESS_OR_EQUAL, OP_GREATER_THAN, OP_GREATER_EQUAL,
  OP_EQUAL, OP_NOT_EQUAL,
  OP_LOGICAL_AND, OP_LOGICAL_OR, OP_LOGICAL_XOR, OP_LOGICAL_NOT,
  OP_START_SCRIPT, OP_CALL_SCRIPT, OP_JUMP, OP_RETURN, OP_JUMP_IF_FALSE,
  OP_SIGNAL, OP_SET_SIGNAL_MASK,
  OP_EXPLODE, OP_PLAY_SOUND, OP_SET_VALUE, OP_ATTACH_UNIT, OP_DROP_UNIT,
  AXIS_X, AXIS_Y, AXIS_Z,
  UV_ACTIVATION, UV_HEALTH, UV_INBUILDSTANCE, UV_BUSY, UV_ARMORED,
  TA_TURNS_PER_CIRCLE, TA_TICK_MS, angleToRadians, linearToWorld,
} from './cob-opcodes.js'

// Each thread instance carries its own VM state.  The instruction
// stream is shared with every other thread executing the same
// script - threads index into the script's parsed instruction
// array at byte-offset positions, so the runtime keeps a per-script
// offset → index map (built once on load).
class CobThread {
  constructor(unit, scriptIndex, args) {
    this.unit = unit
    this.scriptIndex = scriptIndex
    this.script = unit.scripts[scriptIndex]
    // PC is an instruction-array index (not a byte offset).
    this.pc = 0
    // Operand stack.  COB stack values are all 32-bit ints; we use
    // JS Number with explicit |0 on arithmetic to preserve wrap.
    this.stack = []
    // Locals — addressed as L0..Ln by PUSH_LOCAL_VAR / POP_LOCAL_VAR.
    // Sized as needed; STACK_ALLOC / CREATE_LOCAL grow it.
    this.locals = args ? args.slice() : []
    // Signal mask - controls which signals can kill this thread.
    // Default 0 means "ignore all signals" so background threads
    // (Create, Activate) don't accidentally get killed by an
    // AimWeapon signal.  Scripts that DO want to be interruptible
    // call SET_SIGNAL_MASK explicitly.
    this.signalMask = 0
    // dead = true → tick() removes this thread next sweep.
    this.dead = false
    // When > 0 the thread is sleeping; tick decrements it.  When
    // we're waiting on a turn/move the value is Infinity until the
    // animator reports done, then we re-enter the run loop.
    this.sleepMs = 0
    // Active wait condition: { type, pieceAxis }.  When non-null,
    // tick() polls the named animator and clears the wait when it
    // reports done (overriding sleepMs).
    this.waitOn = null
    // Caller stack for CALL_SCRIPT - blocks the caller until the
    // callee returns; on RETURN the stack/locals get restored.
    this.callStack = []
    // ID is convenient for debug logging.  Unique within the unit.
    this.id = unit._nextThreadId++
  }

  // Sentinels for hot-path opcode dispatch.
  pushI(v) { this.stack.push(v | 0) }
  popI() { return (this.stack.pop() | 0) }
}

// Per-piece per-axis animator.  All three axes for all pieces live
// in a flat array indexed by `piece * 3 + axis`.  Each entry tracks
// the current value (position or angle), the target (when MOVE/TURN
// has a destination), and the speed (units/sec or TA-angle/sec).
//
//   kind = 0 (idle)     → no animation
//   kind = 1 (move)     → linear toward `target` at `speed` units/sec
//   kind = 2 (turn)     → angular toward `target` at `speed` units/sec
//   kind = 3 (spin)     → continuous angular at `speed` units/sec
//                          (no target; STOP_SPIN dampens to 0)
class PieceAxisAnim {
  constructor() {
    // kind is STICKY after the first MOVE/TURN/SPIN so the renderer
    // keeps reading the resting value once the animation completes
    // (without this, a turret that finished its aim turn would
    // visibly snap back to 0 the instant the animator went idle -
    // exactly the "instant flip to home position" bug).  Whether
    // the animation is still progressing is tracked via `done`.
    this.kind = 0
    this.value = 0
    this.target = 0
    this.speed = 0
    // STOP_SPIN deceleration target speed - when slowing a spin the
    // axis stays kind=3 + done=false until speed reaches 0, then
    // done=true while kind remains 3 so the spun orientation
    // persists.
    this.decel = 0
    // done=true means the animation reached its target / decel
    // completed.  WAIT_FOR_TURN / WAIT_FOR_MOVE poll this flag
    // instead of (kind != 2) so the wait clears WITHOUT having to
    // drop kind to 0 (which would erase the rest-pose).
    this.done = true
  }
}

// ─────────────────────────────────────────────────────────────────
// CobUnit — one loaded unit's complete script + animator state.
// Multiple CobUnits live inside one CobRuntime; the runtime drives
// all of them on a shared 40 Hz tick.
// ─────────────────────────────────────────────────────────────────

export class CobUnit {
  // runtime: host CobRuntime
  // id:      runtime-unique numeric id (set by runtime.addUnit)
  // script:  cobScriptJSON from /api/studio/cob/<name>
  // hooks:   per-unit { getPieceIndex, log?, emitSfx?, playSound?,
  //                     explode?, getUnitValue?, setUnitValue? }
  constructor(runtime, id, script, hooks = {}) {
    this.runtime = runtime
    this.id = id
    this.scripts = script.scripts || []
    this.scriptNames = script.scriptNames || []
    this.pieceNames = script.pieceNames || []
    this.staticVars = new Array(script.numStaticVars || 0).fill(0)
    this.hooks = hooks
    // Studio-side metadata.  Plain data — the runtime never touches
    // these; the debugger pane stores the decompiled source + the
    // BOS↔asm cross-reference maps here so multiple panels of the
    // same unit share one build.
    this.decompiled = ''
    this._decompiledSource = ''
    this.name = script.name || ''
    this.scriptOriginName = script.scriptOriginName || ''
    this._bosMap = null
    this._asmToBos = null
    // Normalise instruction operands.  The Go JSON encoder strips
    // zero values when the field is tagged omitempty, so p1/p2 land
    // as `undefined` for any opcode whose operand is 0 (notably the
    // common SHOW/HIDE pieceID=0 and the second operand of any
    // 1-param op).  Default to 0 here so the rest of the runtime can
    // assume p1/p2 are real ints; without this, animators initialised
    // by TURN_NOW with target=0 ended up with NaN values that polluted
    // every subsequent tick.
    for (const s of this.scripts) {
      for (const ins of s.instructions) {
        if (ins.p1 === undefined) ins.p1 = 0
        if (ins.p2 === undefined) ins.p2 = 0
      }
    }
    // Build offset → instruction-index lookup tables once per
    // script so JUMP / JUMP_IF_FALSE land in O(1).  Keyed by
    // BOTH the byte offset (what the disassembler emits) AND the
    // DWORD offset (what the bos compiler patches into JUMP
    // operands), because the Go-side buildCOB rewrites every
    // jump target to be an absolute DWORD index into c.Code
    // (target_dword = scriptBaseDword + script_local_dword).  The
    // runtime's JUMP handler doesn't know which units the script
    // was authored with, so a single canonical lookup that
    // accepts either form keeps complex flow-control scripts
    // (factory yards, gantry-open sequences) working — without
    // this, half the conditional branches silently no-oped and
    // the Krogoth gantry's Activate ran to completion in 6
    // instructions instead of marching its clamps through the
    // 200-instruction opening choreography.
    this._offsetMaps = this.scripts.map((s) => {
      const m = new Map()
      for (let i = 0; i < s.instructions.length; i++) {
        const off = s.instructions[i].offset
        m.set(off, i)            // direct byte-offset key
        m.set(off >>> 2, i)      // DWORD-offset key (what JUMP operand encodes)
      }
      return m
    })
    // scriptIndexByName lower-cases the name for case-insensitive lookup.
    this._scriptByName = new Map()
    for (let i = 0; i < this.scriptNames.length; i++) {
      this._scriptByName.set(this.scriptNames[i].toLowerCase(), i)
    }
    // Piece-axis animator arrays.  TA's `move` and `turn` operate
    // INDEPENDENTLY on the same (piece, axis) — translation along
    // axis Z and rotation around axis Z are tracked separately —
    // so we keep two parallel arrays.  Earlier the runtime collapsed
    // both into one slot, which silently dropped the corgant arms'
    // rotation when activatescr did `turn arm1a z-axis 87°` and
    // then `move arm1a z-axis -12.25wu` on the same axis (the move
    // overwrote the turn's animator state with kind=1 + a
    // translation target, leaving the rotation at 0).
    // Indexed by `piece * 3 + axis` in both arrays.
    this._moveAnims = []
    this._rotAnims = []
    this._threads = []
    // _recentlyKilled: ring buffer of threads dropped via signal()
    // within the last ~1.2 seconds.  Used by the studio's inspector
    // overlay to render a red-flash row for each so the user can
    // visually trace which prior thread a SIGNAL just cancelled.
    this._recentlyKilled = []
    this._nextThreadId = 1
    // Per-piece visibility flag.  Defaults all visible.  SHOW / HIDE
    // flip individual entries; the host queries with isPieceVisible.
    this._pieceVisible = new Array(this.pieceNames.length).fill(true)
    // Render flags per piece, settable by COB:
    //   _pieceShade   — `shade` / `dont-shade` opcodes.  Default ON
    //                   (TA's default is shaded; `dont-shade` flips
    //                   it for shiny chrome flares etc).
    //   _pieceCache   — `cache` / `dont-cache` opcodes.  Default OFF
    //                   (TA caches transforms only when the script
    //                   explicitly asks; `cache` is a hint to bake
    //                   the current transform until `dont-cache`).
    //   _pieceShadow  — `dont-shadow` opcode (no SHADOW opcode in TA;
    //                   shadow is on by default, scripts opt OUT).
    // Surfaced via isPieceShade/Cache/Shadow getters so the studio
    // piece-tree can mirror the live state without poking internals.
    this._pieceShade  = new Array(this.pieceNames.length).fill(true)
    this._pieceCache  = new Array(this.pieceNames.length).fill(false)
    this._pieceShadow = new Array(this.pieceNames.length).fill(true)
    // suppressedScripts: scripts whose START_SCRIPT spawn is silently
    // dropped.  Used by the studio to skip the engine-driven
    // "RestoreAfterDelay" auto-restore that snaps the turret back to
    // 0 after each aim.  Per-unit so a sim with two units can choose
    // independently whether each restores.
    this._suppressed = new Set()
    // Per-unit breakpoint set, keyed by "<scriptNameLower>:<offset>".
    // Per-unit so two units running the same script can be debugged
    // independently (BP on unit A doesn't pause when unit B runs the
    // same op).  In single-unit studio usage this matches the legacy
    // runtime-level behaviour exactly.
    this._breakpoints = new Set()
  }

  // ── Public unit API ──────────────────────────────────────────

  // start spawns a thread on the named script, pushing `args` as the
  // initial locals.  Returns the thread id (caller can ignore).
  // Use startThread instead if you need the live thread object (e.g.
  // to poll thread.returnValue once it dies).
  start(scriptName, args = []) {
    const t = this.startThread(scriptName, args)
    return t ? t.id : -1
  }

  // startThread is the same as start() but returns the CobThread
  // instance so the caller can hold a reference and read
  // `thread.dead` / `thread.returnValue` later.  Returns null when
  // the script name doesn't resolve.
  startThread(scriptName, args = []) {
    const idx = this._scriptByName.get(scriptName.toLowerCase())
    if (idx === undefined) return null
    const t = new CobThread(this, idx, args)
    this._threads.push(t)
    return t
  }

  // Lower-level handle: returns true if the named entry-point exists.
  // Used by the UI to enable/disable buttons.
  hasScript(scriptName) {
    return this._scriptByName.has(scriptName.toLowerCase())
  }

  // listScripts returns the script names in order - handy for a
  // debug picker that wants to enumerate every entry point.
  listScripts() { return this.scriptNames.slice() }

  // runQuery executes a Query* script SYNCHRONOUSLY within the
  // current tick — drains the thread to completion in one call and
  // returns the value its caller-arg slot ended up with.  Used by
  // the studio's fire scheduler to resolve QueryPrimary / Query-
  // Secondary / QueryTertiary into the firing piece index without
  // waiting for the next animator tick.
  //
  // Query scripts in TA's BOS are always trivial: read a static var
  // (the active barrel / gun index), branch on it, and assign the
  // matching piece constant into the `piecenum` parameter.  No
  // sleeps, no wait-for-turn, no turns — pure data resolution.  We
  // enforce that contract by aborting the loop the moment we see a
  // yield-style opcode (sleep / wait-for-turn / wait-for-move /
  // start-script / signal — anything that would suspend the thread),
  // dropping the thread and returning null.  That keeps the
  // synchronous contract honest: callers can rely on "result OR
  // null", never a half-executed query that mutates the unit state
  // weirdly.  Returns the value of `locals[0]` (the conventional
  // out-parameter slot for Query scripts) when the script
  // returns normally, or null when it can't be resolved
  // synchronously / the script doesn't exist.
  runQuery(scriptName, args = []) {
    const idx = this._scriptByName.get(scriptName.toLowerCase())
    if (idx === undefined) return null
    const t = new CobThread(this, idx, args)
    t.queryOnly = true
    // Tight execution loop bounded by an instruction limit so a
    // malformed loop in user scripts can't lock the renderer.
    let stepsLeft = 1024
    while (!t.dead && stepsLeft-- > 0) {
      const ins = t.script.instructions[t.pc]
      if (!ins) { t.dead = true; break }
      t.pc++
      // _exec returns true on yield-style ops (sleep / wait-for-turn /
      // wait-for-move) AND on OP_RETURN at the top level — both
      // suspend the thread under normal execution.  For our purposes
      // OP_RETURN is success (it set t.dead = true on the way out),
      // so consult t.dead to distinguish "completed cleanly" from
      // "wants to suspend".  Suspension = bail to caller with null;
      // anything else (including normal completion) falls through.
      const yielded = this._exec(t, ins)
      if (t.dead) break
      if (yielded) return null
    }
    return (t.locals && t.locals.length > 0) ? (t.locals[0] | 0) : null
  }

  // usesUnitValuePort returns true when ANY script in this unit
  // reads (OP_GET_UNIT_VALUE / OP_GET) or writes (OP_SET_VALUE)
  // the given port number.  Detection is conservative: TA scripts
  // push the port via OP_PUSH_IMMEDIATE immediately before the
  // get/set op (the BOS compiler emits no intermediate code), so
  // we scan each script's instruction stream for that adjacent
  // pair.  Cached on first call to keep the Controls panel's
  // per-port visibility checks cheap.
  usesUnitValuePort(port) {
    if (!this._portUsage) this._portUsage = new Map()
    if (this._portUsage.has(port)) return this._portUsage.get(port)
    let used = false
    outer:
    for (const s of this.scripts) {
      const ins = s.instructions
      for (let i = 0; i < ins.length - 1; i++) {
        if (ins[i].op !== OP_PUSH_IMMEDIATE) continue
        if (ins[i].p1 !== port) continue
        const next = ins[i + 1].op
        if (next === OP_GET_UNIT_VALUE || next === OP_GET || next === OP_SET_VALUE) {
          used = true
          break outer
        }
      }
    }
    this._portUsage.set(port, used)
    return used
  }

  suppressScript(name) { this._suppressed.add(name.toLowerCase()) }
  unsuppressScript(name) { this._suppressed.delete(name.toLowerCase()) }
  isSuppressed(name) { return this._suppressed.has(name.toLowerCase()) }

  // signal(n) marks every thread IN THIS UNIT whose signal-mask AND
  // n is non-zero for death.  Scoped to this unit — signals do not
  // cross to other units in the same runtime.
  signal(n) {
    for (const t of this._threads) {
      if ((t.signalMask & n) !== 0) {
        t.dead = true
        t.killedBySignal = n
        t.killedAt = performance.now()
      }
    }
  }

  killThreadsByName(name) {
    const lower = name.toLowerCase()
    let killed = 0
    for (const t of this._threads) {
      if (t.script.name.toLowerCase() === lower) {
        t.dead = true
        killed++
      }
    }
    return killed
  }

  killThreadById(id) {
    for (const t of this._threads) {
      if (t.id === id && !t.dead) { t.dead = true; return true }
    }
    return false
  }

  // killAllThreads marks every live thread dead.  Animators keep
  // their current rest pose so the visible unit freezes in place.
  // Returns the count of threads killed.  Called when the user
  // removes the unit from the runtime, or via the Threads panel's
  // "Stop All" header button.
  killAllThreads() {
    let killed = 0
    for (const t of this._threads) {
      if (!t.dead) { t.dead = true; killed++ }
    }
    return killed
  }

  // Hard reset — used by the host when removing a unit so any wedged
  // state can't leak back through hooks the host might still hold.
  destroy() {
    this.killAllThreads()
    this._threads.length = 0
    this._recentlyKilled.length = 0
    this._moveAnims.length = 0
    this._rotAnims.length = 0
    this._suppressed.clear()
    this._breakpoints.clear()
    this.hooks = {}
  }

  // ── Breakpoint API (per-unit) ────────────────────────────────
  addBreakpoint(scriptName, offset) {
    this._breakpoints.add(`${String(scriptName).toLowerCase()}:${offset >>> 0}`)
  }
  removeBreakpoint(scriptName, offset) {
    this._breakpoints.delete(`${String(scriptName).toLowerCase()}:${offset >>> 0}`)
  }
  hasBreakpoint(scriptName, offset) {
    return this._breakpoints.has(`${String(scriptName).toLowerCase()}:${offset >>> 0}`)
  }
  clearBreakpoints() { this._breakpoints.clear() }

  // stepOne runs exactly ONE bytecode instruction on the named
  // thread of THIS unit.  Used by the debugger's Step button.
  // Animators don't tick — caller is the runtime which decides
  // whether to advance other units.  Breakpoints aren't checked.
  stepOne(threadId) {
    const t = this._threads.find((x) => x.id === threadId && !x.dead)
    if (!t) return
    if (t.pc >= t.script.instructions.length) {
      if (t.callStack.length === 0) { t.dead = true; return }
      this._returnFromCall(t)
      return
    }
    const ins = t.script.instructions[t.pc]
    t.pc++
    this._exec(t, ins)
    t.breakpointHit = false
  }

  // ── Piece API consumed by the renderer ──────────────────────
  pieceOffset(pieceIdx) {
    return [
      this._moveValue(pieceIdx, AXIS_X),
      this._moveValue(pieceIdx, AXIS_Y),
      this._moveValue(pieceIdx, AXIS_Z),
    ]
  }
  pieceRotation(pieceIdx) {
    return [
      this._rotValue(pieceIdx, AXIS_X),
      this._rotValue(pieceIdx, AXIS_Y),
      this._rotValue(pieceIdx, AXIS_Z),
    ]
  }
  isPieceVisible(pieceIdx) {
    return pieceIdx < 0 || this._pieceVisible[pieceIdx] !== false
  }
  // Render-flag getters used by the studio's piece tree to mirror
  // the live COB state.  Index < 0 (synthetic pieces) returns the
  // default for that flag.  Shade and shadow default ON, cache
  // defaults OFF — matches TA's engine defaults so units that never
  // explicitly call the opcode read as "normal" in the tree.
  isPieceShade(pieceIdx)  { return pieceIdx < 0 || this._pieceShade[pieceIdx]  !== false }
  isPieceCache(pieceIdx)  { return pieceIdx >= 0 && this._pieceCache[pieceIdx]  === true }
  isPieceShadow(pieceIdx) { return pieceIdx < 0 || this._pieceShadow[pieceIdx] !== false }
  pieceIndexByName(name) {
    const lower = name.toLowerCase()
    for (let i = 0; i < this.pieceNames.length; i++) {
      if (this.pieceNames[i].toLowerCase() === lower) return i
    }
    return -1
  }

  // ── Internals ───────────────────────────────────────────────
  _animKey(piece, axis) { return piece * 3 + axis }
  _animMove(piece, axis) {
    const k = this._animKey(piece, axis)
    let a = this._moveAnims[k]
    if (!a) { a = new PieceAxisAnim(); this._moveAnims[k] = a }
    return a
  }
  _animRot(piece, axis) {
    const k = this._animKey(piece, axis)
    let a = this._rotAnims[k]
    if (!a) { a = new PieceAxisAnim(); this._rotAnims[k] = a }
    return a
  }
  _moveValue(piece, axis) {
    const a = this._moveAnims[this._animKey(piece, axis)]
    if (!a || a.kind === 0) return 0
    return linearToWorld(a.value)
  }
  _rotValue(piece, axis) {
    const a = this._rotAnims[this._animKey(piece, axis)]
    if (!a || a.kind === 0) return 0
    return angleToRadians(a.value)
  }
  _animDone(w) {
    const arr = w.family === 'move' ? this._moveAnims : this._rotAnims
    const a = arr[w.key]
    if (!a) return true
    return !!a.done
  }
  _tickAnimators(dt) {
    this._tickAnimArray(this._moveAnims, dt)
    this._tickAnimArray(this._rotAnims, dt)
  }
  _tickAnimArray(arr, dt) {
    for (const a of arr) {
      if (!a || a.done) continue
      switch (a.kind) {
        case 1: { // move toward target
          const delta = a.target - a.value
          const step = a.speed * dt
          if (Math.abs(delta) <= step) { a.value = a.target; a.done = true }
          else a.value += Math.sign(delta) * step
          break
        }
        case 2: { // turn toward target
          let delta = a.target - a.value
          const HALF = TA_TURNS_PER_CIRCLE / 2
          while (delta > HALF) delta -= TA_TURNS_PER_CIRCLE
          while (delta < -HALF) delta += TA_TURNS_PER_CIRCLE
          const step = a.speed * dt
          if (Math.abs(delta) <= step) { a.value = a.target; a.done = true }
          else a.value += Math.sign(delta) * step
          break
        }
        case 3: { // spin
          a.value += a.speed * dt
          if (a.value > TA_TURNS_PER_CIRCLE) a.value -= TA_TURNS_PER_CIRCLE
          if (a.value < -TA_TURNS_PER_CIRCLE) a.value += TA_TURNS_PER_CIRCLE
          if (a.decel > 0) {
            const ds = a.decel * dt
            if (Math.abs(a.speed) <= ds) { a.speed = 0; a.done = true; a.decel = 0 }
            else a.speed -= Math.sign(a.speed) * ds
          }
          break
        }
      }
    }
  }

  // _tickStep runs ONE fixed-rate tick of script-time on this unit.
  // Called from CobRuntime._tickStep for every active unit.  Animator
  // advance + sleep decrement + thread instruction run all happen
  // here.  Returns the number of instructions executed (for metrics).
  _tickStep(stepMs) {
    const dtSec = stepMs * 0.001
    this._tickAnimators(dtSec)
    let instCount = 0
    const snap = this._threads.slice()
    for (const t of snap) {
      if (t.dead) continue
      if (t.waitOn) {
        if (this._animDone(t.waitOn)) {
          t.waitOn = null
          t.sleepMs = 0
        } else {
          continue
        }
      }
      if (t.sleepMs > 0) {
        t.sleepMs -= stepMs
        if (t.sleepMs > 0) continue
        t.sleepMs = 0
      }
      instCount += this._runThread(t)
    }
    // Drop dead threads.  Reverse-iterate so splice indices stay valid.
    const now = performance.now()
    for (let i = this._threads.length - 1; i >= 0; i--) {
      const t = this._threads[i]
      if (!t.dead) continue
      if (t.killedBySignal) {
        this._recentlyKilled.push({
          script: t.script,
          pc: t.pc,
          signalMask: t.signalMask,
          killedBySignal: t.killedBySignal,
          killedAt: t.killedAt,
        })
      }
      this._threads.splice(i, 1)
    }
    while (this._recentlyKilled.length > 0 && now - this._recentlyKilled[0].killedAt > 1200) {
      this._recentlyKilled.shift()
    }
    if (this._recentlyKilled.length > 8) {
      this._recentlyKilled.splice(0, this._recentlyKilled.length - 8)
    }
    return instCount
  }

  // _runThread executes a single thread's instructions until it
  // hits a yield (sleep / wait / dead).  Returns instructions ran.
  //
  // Critical: read t.script.instructions INSIDE the loop on every
  // iteration.  CALL_SCRIPT (and the implicit return from end-of-
  // script) swap t.script to a different function, and the old
  // caller's instruction array must NOT be reused — otherwise the
  // callee's PC indexes back into the caller's bytecode, which on
  // armlab's Create→InitState→RETURN chain made the thread loop
  // forever (pc=19's CALL_SCRIPT in Create kept re-firing because
  // execution stayed in Create's instruction stream even though
  // t.script said "InitState").
  _runThread(t) {
    let count = 0
    const MAX = 4096
    let allowFirstBreakpoint = !t.breakpointHit
    t.breakpointHit = false
    while (!t.dead && count < MAX) {
      const insts = t.script.instructions
      if (t.pc >= insts.length) {
        if (t.callStack.length === 0) { t.dead = true; break }
        this._returnFromCall(t)
        continue
      }
      const ins = insts[t.pc]
      if (allowFirstBreakpoint && this._breakpoints.size > 0) {
        if (this._breakpoints.has(`${t.script.name.toLowerCase()}:${ins.offset >>> 0}`)) {
          // BP fires: mark this thread as paused-on-bp AND halt the
          // entire host runtime so animators + other units' threads
          // also freeze.  Without the runtime-wide pause, the rest
          // of the world keeps moving — not what "breakpoint" means
          // to a user.
          t.breakpointHit = true
          this.runtime.paused = true
          break
        }
      }
      allowFirstBreakpoint = true
      t.pc++
      count++
      if (this._exec(t, ins)) break // exec returned `true` → yielded
    }
    return count
  }

  // _exec runs one instruction.  Returns true when the thread
  // should yield (sleep, wait, dead).  All references to per-unit
  // state (`this.staticVars`, `this._pieceVisible`, `this.hooks`,
  // `this.scripts`, `this._scriptByName`, `this._suppressed`) read
  // from this CobUnit — that's what makes the multi-unit model
  // hang together: two units run the same script binary
  // concurrently but never touch each other's state.
  _exec(t, ins) {
    const op = ins.op
    // Query-only fast path — a thread spawned via runQuery() is
    // forbidden from any operation that would yield (sleep, wait-
    // for-turn / wait-for-move), animate a piece (move, turn, spin,
    // visibility/cache/shadow flags), or spawn another thread
    // (start-script, signal).  Returning true treats the op as a
    // yield, which runQuery's loop interprets as "can't resolve
    // synchronously" and bails.  We allow piece visibility flags
    // (show/hide/shade/cache/shadow) through because they're
    // accidentally common in feature-detection style scripts (a
    // Query that toggles an indicator flag), and they don't
    // suspend or animate.
    if (t.queryOnly) {
      switch (op) {
        case OP_SLEEP:
        case OP_WAIT_FOR_TURN:
        case OP_WAIT_FOR_MOVE:
        case OP_MOVE:
        case OP_TURN:
        case OP_SPIN:
        case OP_STOP_SPIN:
        case OP_START_SCRIPT:
        case OP_SIGNAL:
        case OP_SET_SIGNAL_MASK:
        case OP_EMIT_SFX:
        case OP_EXPLODE:
        case OP_PLAY_SOUND:
        case OP_ATTACH_UNIT:
        case OP_DROP_UNIT:
          return true
        default:
          break
      }
    }
    switch (op) {
      // ── Stack ──────────────────────────────────────────────
      case OP_PUSH_IMMEDIATE:
      case OP_PUSH_CONSTANT:
        t.pushI(ins.p1)
        return false
      case OP_PUSH_LOCAL_VAR: {
        const i = ins.p1
        t.pushI(t.locals[i] | 0)
        return false
      }
      case OP_PUSH_STATIC: {
        const i = ins.p1
        t.pushI(this.staticVars[i] | 0)
        return false
      }
      case OP_CREATE_LOCAL:
      case OP_STACK_ALLOC:
        if (op === OP_CREATE_LOCAL) {
          while (t.locals.length <= ins.p1) t.locals.push(0)
        } else {
          t.locals.push(0)
        }
        return false
      case OP_POP_LOCAL_VAR: {
        const v = t.popI()
        while (t.locals.length <= ins.p1) t.locals.push(0)
        t.locals[ins.p1] = v
        return false
      }
      case OP_POP_STATIC: {
        const v = t.popI()
        while (this.staticVars.length <= ins.p1) this.staticVars.push(0)
        this.staticVars[ins.p1] = v
        return false
      }
      case OP_POP_STACK:
        t.popI()
        return false

      // ── Arithmetic / bitwise ───────────────────────────────
      case OP_ADD: { const b = t.popI(); const a = t.popI(); t.pushI(a + b); return false }
      case OP_SUB: { const b = t.popI(); const a = t.popI(); t.pushI(a - b); return false }
      case OP_MUL: { const b = t.popI(); const a = t.popI(); t.pushI(Math.imul(a, b)); return false }
      case OP_DIV: { const b = t.popI(); const a = t.popI(); t.pushI(b === 0 ? 0 : (a / b) | 0); return false }
      case OP_MOD: { const b = t.popI(); const a = t.popI(); t.pushI(b === 0 ? 0 : a % b); return false }
      case OP_BITWISE_AND: { const b = t.popI(); const a = t.popI(); t.pushI(a & b); return false }
      case OP_BITWISE_OR:  { const b = t.popI(); const a = t.popI(); t.pushI(a | b); return false }
      case OP_BITWISE_XOR: { const b = t.popI(); const a = t.popI(); t.pushI(a ^ b); return false }
      case OP_BITWISE_NOT: { const a = t.popI(); t.pushI(~a); return false }

      // ── Comparisons / logical (TA uses 0 = false, non-zero = true) ──
      case OP_LESS_THAN:     { const b = t.popI(); const a = t.popI(); t.pushI(a <  b ? 1 : 0); return false }
      case OP_LESS_OR_EQUAL: { const b = t.popI(); const a = t.popI(); t.pushI(a <= b ? 1 : 0); return false }
      case OP_GREATER_THAN:  { const b = t.popI(); const a = t.popI(); t.pushI(a >  b ? 1 : 0); return false }
      case OP_GREATER_EQUAL: { const b = t.popI(); const a = t.popI(); t.pushI(a >= b ? 1 : 0); return false }
      case OP_EQUAL:         { const b = t.popI(); const a = t.popI(); t.pushI(a === b ? 1 : 0); return false }
      case OP_NOT_EQUAL:     { const b = t.popI(); const a = t.popI(); t.pushI(a !== b ? 1 : 0); return false }
      case OP_LOGICAL_AND: { const b = t.popI(); const a = t.popI(); t.pushI(a && b ? 1 : 0); return false }
      case OP_LOGICAL_OR:  { const b = t.popI(); const a = t.popI(); t.pushI(a || b ? 1 : 0); return false }
      case OP_LOGICAL_XOR: { const b = t.popI(); const a = t.popI(); t.pushI((!!a) !== (!!b) ? 1 : 0); return false }
      case OP_LOGICAL_NOT: { const a = t.popI(); t.pushI(a ? 0 : 1); return false }

      // ── Random / unit values ──────────────────────────────
      case OP_RAND: {
        const hi = t.popI(); const lo = t.popI()
        const lo2 = Math.min(lo, hi), hi2 = Math.max(lo, hi)
        t.pushI(lo2 + Math.floor(Math.random() * (hi2 - lo2 + 1)))
        return false
      }
      case OP_GET_UNIT_VALUE:
      case OP_GET: {
        const port = t.popI()
        let value = 0
        if (this.hooks.getUnitValue) value = this.hooks.getUnitValue(port) | 0
        else if (port === UV_ACTIVATION) value = 1
        else if (port === UV_HEALTH) value = 100
        else if (port === UV_INBUILDSTANCE) value = 0
        else if (port === UV_BUSY) value = 0
        else if (port === UV_ARMORED) value = 0
        t.pushI(value)
        return false
      }
      case OP_SET_VALUE: {
        const value = t.popI()
        const port = t.popI()
        if (this.hooks.setUnitValue) this.hooks.setUnitValue(port, value)
        return false
      }

      // ── Piece animation ───────────────────────────────────
      case OP_MOVE: {
        const target = t.popI(); const speed = t.popI()
        const a = this._animMove(ins.p1, ins.p2)
        a.kind = 1; a.target = target; a.speed = Math.abs(speed); a.done = false
        return false
      }
      case OP_TURN: {
        const target = t.popI(); const speed = t.popI()
        const a = this._animRot(ins.p1, ins.p2)
        a.kind = 2; a.target = target; a.speed = Math.abs(speed); a.done = false
        return false
      }
      case OP_SPIN: {
        const speed = t.popI()
        const a = this._animRot(ins.p1, ins.p2)
        a.kind = 3; a.speed = speed; a.decel = 0; a.done = false
        return false
      }
      case OP_STOP_SPIN: {
        const decel = t.popI()
        const a = this._animRot(ins.p1, ins.p2)
        if (a.kind === 3) { a.decel = Math.abs(decel) || a.speed; a.done = false }
        return false
      }
      case OP_MOVE_NOW: {
        const value = t.popI()
        const a = this._animMove(ins.p1, ins.p2)
        a.kind = 1; a.value = value; a.target = value; a.speed = 0; a.done = true
        return false
      }
      case OP_TURN_NOW: {
        const value = t.popI()
        const a = this._animRot(ins.p1, ins.p2)
        a.kind = 2; a.value = value; a.target = value; a.speed = 0; a.done = true
        return false
      }
      case OP_SHOW: { this._pieceVisible[ins.p1] = true; return false }
      case OP_HIDE: { this._pieceVisible[ins.p1] = false; return false }
      case OP_SHADE:        { this._pieceShade[ins.p1]  = true;  return false }
      case OP_DONT_SHADE:   { this._pieceShade[ins.p1]  = false; return false }
      case OP_CACHE:        { this._pieceCache[ins.p1]  = true;  return false }
      case OP_DONT_CACHE:   { this._pieceCache[ins.p1]  = false; return false }
      case OP_DONT_SHADOW:  { this._pieceShadow[ins.p1] = false; return false }
      case OP_EMIT_SFX: {
        const sfxType = t.popI()
        if (this.hooks.emitSfx) this.hooks.emitSfx(sfxType, ins.p1)
        return false
      }

      // ── Waits ─────────────────────────────────────────────
      case OP_SLEEP: {
        t.sleepMs = t.popI()
        return true
      }
      case OP_WAIT_FOR_TURN: {
        t.waitOn = { type: 'turn', family: 'rot', key: this._animKey(ins.p1, ins.p2) }
        return true
      }
      case OP_WAIT_FOR_MOVE: {
        t.waitOn = { type: 'move', family: 'move', key: this._animKey(ins.p1, ins.p2) }
        return true
      }

      // ── Control flow ──────────────────────────────────────
      case OP_JUMP: {
        const idx = this._offsetMaps[t.scriptIndex].get(ins.p1 >>> 0)
        if (idx !== undefined) t.pc = idx
        return false
      }
      case OP_JUMP_IF_FALSE: {
        const cond = t.popI()
        if (!cond) {
          const idx = this._offsetMaps[t.scriptIndex].get(ins.p1 >>> 0)
          if (idx !== undefined) t.pc = idx
        }
        return false
      }
      case OP_RETURN: {
        const ret = t.stack.length > 0 ? t.popI() : 0
        if (t.callStack.length === 0) {
          // Top-level thread returning — stash the value on the
          // thread itself so external callers (e.g. the studio's
          // aim+fire scheduler) can read what AimWeapon returned.
          t.returnValue = ret
          t.dead = true
          return true
        }
        this._returnFromCall(t, ret)
        return false
      }
      case OP_START_SCRIPT: {
        const childIdx = ins.p1
        const argCount = ins.p2
        const args = []
        for (let i = 0; i < argCount; i++) args.unshift(t.popI())
        if (childIdx >= 0 && childIdx < this.scripts.length) {
          const childNameLower = this.scriptNames[childIdx].toLowerCase()
          if (!this._suppressed.has(childNameLower)) {
            // Kill any existing instance of the SAME script before
            // spawning a new one — matches how real TA handles
            // start-script invocations: a second AimPrimary while one
            // is still running cancels the first, and a re-issued
            // MotionControl clobbers the previous walking thread.
            // Without this, repeated start-script calls stacked an
            // ever-growing list of duplicate threads.  Caller-thread
            // (t) is excluded so a script that start-scripts itself
            // (rare but legal) doesn't murder its own caller.
            for (const existing of this._threads) {
              if (existing === t || existing.dead) continue
              if (existing.script.name.toLowerCase() === childNameLower) {
                existing.dead = true
              }
            }
            const child = new CobThread(this, childIdx, args)
            this._threads.push(child)
          }
        }
        return false
      }
      case OP_CALL_SCRIPT: {
        const childIdx = ins.p1
        const argCount = ins.p2
        const args = []
        for (let i = 0; i < argCount; i++) args.unshift(t.popI())
        if (childIdx >= 0 && childIdx < this.scripts.length) {
          t.callStack.push({
            scriptIndex: t.scriptIndex,
            script: t.script,
            pc: t.pc,
            locals: t.locals,
          })
          t.scriptIndex = childIdx
          t.script = this.scripts[childIdx]
          t.pc = 0
          t.locals = args
        }
        return false
      }
      case OP_SIGNAL: {
        const mask = t.popI()
        this.signal(mask)
        return false
      }
      case OP_SET_SIGNAL_MASK: {
        t.signalMask = t.popI()
        return false
      }

      // ── Effects ───────────────────────────────────────────
      case OP_EXPLODE: {
        const sfxType = t.popI()
        if (this.hooks.explode) this.hooks.explode(ins.p1, sfxType)
        return false
      }
      case OP_PLAY_SOUND: {
        const sound = t.popI()
        if (this.hooks.playSound) this.hooks.playSound(sound, ins.p1)
        return false
      }
      case OP_ATTACH_UNIT:
      case OP_DROP_UNIT:
        // Multi-unit attachment ops.  In a game we'd resolve the
        // unit id off the stack and re-parent it; the studio
        // typically displays a single unit so a no-op is safe.
        return false

      default:
        if (this.hooks.log) this.hooks.log(`COB: unknown op 0x${op.toString(16)} (${ins.name})`)
        return false
    }
  }

  _returnFromCall(t, value = 0) {
    const frame = t.callStack.pop()
    if (!frame) { t.dead = true; return }
    t.scriptIndex = frame.scriptIndex
    t.script = frame.script
    t.pc = frame.pc
    t.locals = frame.locals
    t.pushI(value)
  }
}

// ─────────────────────────────────────────────────────────────────
// CobRuntime — the world host.  Owns shared time control (paused,
// playbackRate, fixed-step accumulator) and a map of CobUnits.
// One CobRuntime per studio editor tab; multiple units inside it
// would simulate them concurrently as if they were on a battlefield.
//
// CobRuntime knows NOTHING about per-unit state — scripts, animators,
// piece visibility, breakpoints, hooks etc. all live on CobUnit.
// Callers add units explicitly with `addUnit(script, hooks)` and
// keep the returned CobUnit handle for everything per-unit.
// ─────────────────────────────────────────────────────────────────

export class CobRuntime {
  constructor() {
    this._units = new Map()           // unitId → CobUnit
    this._nextUnitId = 1
    // Shared time state.  Sleeps and animators of every unit share
    // the same fixed-step clock so units don't drift relative to
    // each other.
    this.paused = false
    this.playbackRate = 1
    this._tickAccumMs = 0
    // simTimeMs — monotonically increasing simulation clock in
    // milliseconds, advanced by `dtMs * playbackRate` on every tick.
    // Use this (NOT performance.now()) for any game-logic timing that
    // should respect slow-mo / fast-forward: reload cadence, burst
    // inter-shot delays, smoke-trail emission intervals, etc.  At
    // 0.5× playback this ticks half as fast as wall time, so a 2 s
    // reload still takes 2 s of SIM time (= 4 s of wall time) — which
    // is the behaviour the user expects from "slow-mo".  Frozen when
    // paused.  Sub-frame precision (advances even between the fixed
    // 25 ms TA ticks) so per-frame consumers always see a smooth
    // monotonic clock.
    this.simTimeMs = 0
    // Telemetry — surfaced by the Runtime overlay's stats line so
    // the user can see the sim's actual throughput.  `tickCount` is
    // the total number of fixed 25 ms ticks executed across the
    // runtime's lifetime; `lastTickMs` is wall-clock duration of
    // the most recent tick() call (which may have drained several
    // fixed sub-steps).  Both reset only when the runtime is
    // disposed — the panel divides as needed for "per second" type
    // displays.
    this.tickCount = 0
    this.lastTickMs = 0
    // Last-tick instruction count — how many bytecode instructions
    // executed across every unit during the most recent tick() call.
    // Surfaced in the Runtime overlay's stats line so the user can
    // see the sim's per-tick CPU load alongside the wall-clock cost.
    this.lastInstCount = 0
  }

  // ── Telemetry ───────────────────────────────────────────────

  // threadCount sums live threads across every unit.  Used by the
  // Runtime overlay's stats line — single pass over the units map
  // each refresh tick, which is fine since the overlay throttles
  // to 4 Hz.
  threadCount() {
    let n = 0
    for (const u of this._units.values()) n += u._threads.length
    return n
  }

  // ── Unit registry ───────────────────────────────────────────

  // addUnit creates a new CobUnit from a compiled script + per-unit
  // hooks and registers it with the runtime.  Returns the unit so
  // the caller can issue `unit.start(...)` etc.
  addUnit(script, hooks = {}) {
    const id = this._nextUnitId++
    const unit = new CobUnit(this, id, script, hooks)
    this._units.set(id, unit)
    return unit
  }

  // removeUnit kills every thread in the unit + clears its animator
  // state + drops it from the runtime's map.  Pass the CobUnit
  // instance OR its numeric id.  Safe to call mid-tick — the
  // _tickStep snapshot won't process a removed unit next iteration.
  removeUnit(unitOrId) {
    const id = (typeof unitOrId === 'object' && unitOrId !== null) ? unitOrId.id : unitOrId
    const unit = this._units.get(id)
    if (!unit) return
    unit.destroy()
    this._units.delete(id)
  }

  // units returns an iterable of every registered CobUnit.  Order is
  // insertion order (Map iteration semantics).
  units() { return this._units.values() }
  unitById(id) { return this._units.get(id) }
  unitCount() { return this._units.size }

  // ── Time / control ──────────────────────────────────────────

  // setPaused / setPlaybackRate apply to the WHOLE runtime — every
  // unit's threads + animators react to these.
  setPaused(p) { this.paused = !!p }
  setPlaybackRate(rate) {
    this.playbackRate = Math.max(0.01, Math.min(10, +rate || 1))
  }

  // killAllThreads runtime-wide: iterates every registered unit and
  // marks every live thread dead.  Used by the Runtime overlay's
  // "Terminate All Scripts" button (and any other host-level kill
  // sweep that doesn't want to dig into the unit registry itself).
  // Returns the total count of threads killed across all units.
  killAllThreads() {
    let killed = 0
    for (const u of this._units.values()) {
      if (typeof u.killAllThreads === 'function') killed += u.killAllThreads()
    }
    return killed
  }

  // findThreadById walks every unit's live thread list and returns
  // the matching CobThread + its owning CobUnit, or null when the
  // id isn't live.  Used by host code that has a thread id snapshot
  // (debugger panels, kill-by-id buttons) and needs to locate the
  // backing object without knowing which unit owns it.
  findThreadById(threadId) {
    for (const u of this._units.values()) {
      const t = (u._threads || []).find((x) => x.id === threadId && !x.dead)
      if (t) return { thread: t, unit: u }
    }
    return null
  }

  // tick advances every unit by `dtMs` of wall-clock time.  Call
  // once per render frame.  The wall-clock dt is accumulated and
  // drained in fixed TA_TICK_MS (25 ms) steps so every unit's
  // animator + sleep timer share the same 40 Hz grid.  Returns the
  // total instructions executed across all units.
  tick(dtMs) {
    if (this.paused) return 0
    const scaledMs = Math.min(250, Math.max(0, dtMs)) * this.playbackRate
    this._tickAccumMs += scaledMs
    // Advance the sim clock by the SAME scaledMs the accumulator gets
    // — so consumers reading simTimeMs see sub-tick resolution between
    // the fixed 25 ms drains.  At 1× playback this matches wall-clock
    // delta; at 0.5× it advances at half wall-rate, etc.
    this.simTimeMs += scaledMs
    let instCount = 0
    let stepsRemaining = 8
    // Wall-clock wall around the inner loop so the Runtime overlay
    // can show "last tick X ms" — measures the actual CPU cost of
    // draining the accumulator, not the wrapping render frame.
    const start = performance.now()
    while (this._tickAccumMs >= TA_TICK_MS && stepsRemaining-- > 0) {
      this._tickAccumMs -= TA_TICK_MS
      instCount += this._tickStep(TA_TICK_MS)
      this.tickCount++
    }
    if (stepsRemaining <= 0) this._tickAccumMs = 0
    this.lastTickMs = performance.now() - start
    this.lastInstCount = instCount
    return instCount
  }

  _tickStep(stepMs) {
    let instCount = 0
    // Snapshot the unit map so addUnit during a tick doesn't try to
    // run the new unit on the same step (it'll run on the next).
    const snap = [...this._units.values()]
    for (const u of snap) instCount += u._tickStep(stepMs)
    return instCount
  }

  // stepOne finds the unit that owns `threadId` and advances that
  // thread by one bytecode instruction.  Used by the debugger's
  // single-step button.  Animators stay frozen.  Returns the
  // owning CobUnit so the caller can refresh its panel.
  stepOne(threadId) {
    for (const u of this._units.values()) {
      const t = u._threads.find((x) => x.id === threadId)
      if (t) { u.stepOne(threadId); return u }
    }
    return null
  }
}
