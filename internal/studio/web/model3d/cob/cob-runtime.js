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
// Each CobRuntime instance owns the state for ONE unit:
//   * static variables          (shared across all threads of the unit)
//   * piece-animation table     (per-(piece, axis) move/turn/spin state)
//   * a list of cooperative threads.
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
// signal(N) which marks every thread whose signal-mask AND N is
// non-zero for death.  This is how AimWeapon interrupts itself if
// fired again before the previous aim completes.  We honour the
// model precisely - matching the original game's gun-aiming feel.
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
// the wall-clock delta in ms; animators advance proportionally and
// sleeping threads decrement their wait counter.

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
  constructor(runtime, scriptIndex, args) {
    this.runtime = runtime
    this.scriptIndex = scriptIndex
    this.script = runtime.scripts[scriptIndex]
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
    // ID is convenient for debug logging.
    this.id = runtime._nextThreadId++
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

export class CobRuntime {
  // script: cobScriptJSON from /api/studio/cob/<name>.
  // hooks: { getPieceIndex(name) → number, log?, emitSfx?, playSound? }
  constructor(script, hooks = {}) {
    this.scripts = script.scripts || []
    this.scriptNames = script.scriptNames || []
    this.pieceNames = script.pieceNames || []
    this.staticVars = new Array(script.numStaticVars || 0).fill(0)
    this.hooks = hooks
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
    // suppressedScripts: scripts whose START_SCRIPT spawn is silently
    // dropped.  Used by the studio to skip the engine-driven
    // "RestoreAfterDelay" auto-restore that snaps the turret back to
    // 0 after each aim - in a real game the game loop is constantly
    // re-issuing aim commands so the restore never fires; in a static
    // viewer the restore wins and we lose the aimed pose the user
    // just dialled in.  Names are matched case-insensitively against
    // the resolved script name at START_SCRIPT time.
    this._suppressed = new Set()
    // playbackRate scales every animator step + every sleep decrement.
    // Default 1.0 = real-time.  The studio exposes a slider so users
    // can slow down a long sequence (Krogoth gantry open, AimPrimary)
    // for inspection.
    this.playbackRate = 1
    // Fixed-step tick accumulator.  Wall-clock dt feeds in; the
    // runtime drains it in TA_TICK_MS (25 ms) chunks so animator
    // advance + sleep decrement land on the same 40 Hz grid TA's
    // engine uses.  Without this, a 16.67 ms render dt would
    // half-decrement sleeps and drift them by the frame remainder
    // every cycle; with it, `sleep 200` is always exactly 8 ticks.
    this._tickAccumMs = 0
  }

  // start spawns a thread on the named script, pushing `args` as the
  // initial locals.  Returns the thread id (caller can ignore).
  start(scriptName, args = []) {
    const idx = this._scriptByName.get(scriptName.toLowerCase())
    if (idx === undefined) return -1
    const t = new CobThread(this, idx, args)
    this._threads.push(t)
    return t.id
  }

  // Lower-level handle: returns true if the named entry-point exists.
  // Used by the UI to enable/disable buttons.
  hasScript(scriptName) {
    return this._scriptByName.has(scriptName.toLowerCase())
  }

  // listScripts returns the script names in order - handy for a
  // debug picker that wants to enumerate every entry point.
  listScripts() { return this.scriptNames.slice() }

  // suppressScript / unsuppressScript control which scripts are
  // silently dropped at START_SCRIPT time.  Matching is
  // case-insensitive.  See _suppressed for the studio's primary use
  // case (turret-restore).
  suppressScript(name) { this._suppressed.add(name.toLowerCase()) }
  unsuppressScript(name) { this._suppressed.delete(name.toLowerCase()) }
  isSuppressed(name) { return this._suppressed.has(name.toLowerCase()) }

  // setPlaybackRate scales the per-tick advance.  1.0 = real-time,
  // 0.25 = quarter speed (handy for inspecting fast cycles like
  // muzzle recoil).  Larger than 1 is allowed but rarely useful.
  setPlaybackRate(rate) {
    this.playbackRate = Math.max(0.01, Math.min(10, +rate || 1))
  }

  // tick advances every thread + animator by `dtMs` of wall-clock
  // time.  Call once per render frame.  Returns the number of
  // instructions executed (useful for runaway detection / metrics).
  //
  // The wall-clock dt is accumulated and drained in fixed TA_TICK_MS
  // (25 ms) steps so animator advance + sleep decrement land on the
  // same 40 Hz grid TA's engine uses.  This gives deterministic
  // pacing: a `sleep 200` ALWAYS resolves after exactly 8 ticks,
  // regardless of whether the renderer hands us 16.67 ms (60 FPS) or
  // 33 ms (30 FPS) per frame.  Wall-clock dt above 250 ms is clamped
  // — typically a tab-switch pause — so the runtime doesn't burn
  // through a stockpile of accumulated ticks all in one frame.
  tick(dtMs) {
    // Apply the playback-rate multiplier to the wall-clock advance so
    // animator + sleep tick share the same scaled clock — without that
    // the animator would run at real-time speed while sleeps still
    // drained at full rate, producing inconsistent slow-motion.
    const scaledMs = Math.min(250, Math.max(0, dtMs)) * this.playbackRate
    this._tickAccumMs += scaledMs
    let instCount = 0
    // Safety cap of 8 ticks per frame keeps a momentary stutter from
    // cascading into a single mega-frame that bursts through several
    // hundred milliseconds of script time at once.
    let stepsRemaining = 8
    while (this._tickAccumMs >= TA_TICK_MS && stepsRemaining-- > 0) {
      this._tickAccumMs -= TA_TICK_MS
      instCount += this._tickStep(TA_TICK_MS)
    }
    // Drop any over-accumulation that the safety cap left behind, so
    // we don't bank ticks for the next frame.
    if (stepsRemaining <= 0) this._tickAccumMs = 0
    return instCount
  }

  // _tickStep runs ONE fixed-rate tick of script-time.  Split from
  // tick() so the accumulator loop can call it N times per render
  // frame without duplicating the animator+thread walk.
  _tickStep(stepMs) {
    const dtSec = stepMs * 0.001
    // Animators always advance even if no thread is alive - that
    // way a SPIN started by Activate keeps running after the
    // script returns.
    this._tickAnimators(dtSec)
    // Iterate a snapshot of the thread list - START_SCRIPT may
    // append new threads during this tick; they'll run next tick.
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
    // Recently-signal-killed threads are moved to a ring buffer so the
    // inspector overlay can still render them briefly with a red flash;
    // entries older than ~1.5s are dropped.  Naturally-completed
    // threads (RETURN, end-of-script) are removed immediately.
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
    // Cap the recently-killed buffer at 8 entries and drop anything
    // older than the inspector's flash duration.  Cheap O(n) pass.
    while (this._recentlyKilled.length > 0 && now - this._recentlyKilled[0].killedAt > 1200) {
      this._recentlyKilled.shift()
    }
    if (this._recentlyKilled.length > 8) {
      this._recentlyKilled.splice(0, this._recentlyKilled.length - 8)
    }
    return instCount
  }

  // signal(n) marks every thread whose signal-mask AND n is non-zero
  // for death.  Used by AimWeapon-style scripts to invalidate prior
  // aiming chains when re-fired.  TA semantics: dying threads run
  // their next opcode then exit, so we just set dead=true.  We also
  // stamp `killedBySignal` + `killedAt` for the studio inspector
  // overlay so it can flash the row red briefly.
  signal(n) {
    for (const t of this._threads) {
      if ((t.signalMask & n) !== 0) {
        t.dead = true
        t.killedBySignal = n
        t.killedAt = performance.now()
      }
    }
  }

  // killThreadsByName drops any threads running the named script.
  // Studio uses this to kill stale RestoreAfterDelay threads when
  // the user re-aims - without it, the FIRST restore's 6-second
  // timer is already running and fires partway through the LAST
  // aim's hold window, snapping the turret back early.
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

  // killThreadById drops a single thread by its `id` (CobThread.id
  // is the per-runtime monotonically-increasing identifier set in
  // the constructor).  Returns true if a matching live thread was
  // found and marked dead; false otherwise.  Used by the Threads
  // inspector's per-row trash-can icon so the user can debug a
  // misbehaving thread without nuking the whole runtime.
  killThreadById(id) {
    for (const t of this._threads) {
      if (t.id === id && !t.dead) { t.dead = true; return true }
    }
    return false
  }

  // killAllThreads marks every live thread dead.  Animators keep
  // their current rest pose (kind stays sticky), so the visible
  // unit doesn't snap back to origin — it just freezes in place
  // until the user re-fires a script.  Used by the Threads panel's
  // "Stop All" header button.  Returns the count of threads killed.
  killAllThreads() {
    let killed = 0
    for (const t of this._threads) {
      if (!t.dead) { t.dead = true; killed++ }
    }
    return killed
  }

  // ── Piece API consumed by the renderer ──────────────────────────
  // Each animator stores either a translation (move) or an angle
  // (turn / spin), per axis.  The renderer pulls the per-axis
  // values to build the piece's world matrix.
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
  // Map piece name to index.  Used by clients that want to query
  // by name (e.g. piece-tree → COB index).
  pieceIndexByName(name) {
    const lower = name.toLowerCase()
    for (let i = 0; i < this.pieceNames.length; i++) {
      if (this.pieceNames[i].toLowerCase() === lower) return i
    }
    return -1
  }

  // ── Internals ───────────────────────────────────────────────────
  // Same key shape for both arrays — piece * 3 + axis.  The choice
  // of array (move vs rot) is the slot family selector.
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
  // _moveValue / _rotValue return the per-axis translation / angle
  // for the renderer's matrix build.  Each reads from its own
  // family so a `move` and a `turn` on the SAME (piece, axis) no
  // longer compete for one slot.  Both intentionally skip the
  // `done` check — the rest-pose value must persist after an
  // animation completes (turret stays where it aimed, etc).
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
  // _animDone — used by WAIT_FOR_TURN / WAIT_FOR_MOVE to decide
  // when to wake the sleeping thread.  Routed to the correct array
  // via w.family (set when the wait is registered).  We check
  // `done` rather than `kind` because kind stays sticky after the
  // animation finishes (so the rest-pose persists).
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
          // Shortest-arc: wrap delta into [-HALF, +HALF].  HALF =
          // half a turn in TA angle units.
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
          // Wrap so the value never grows unbounded - 1 turn = TA_TURNS_PER_CIRCLE.
          if (a.value > TA_TURNS_PER_CIRCLE) a.value -= TA_TURNS_PER_CIRCLE
          if (a.value < -TA_TURNS_PER_CIRCLE) a.value += TA_TURNS_PER_CIRCLE
          // Decel toward 0 if STOP_SPIN was issued.  When speed
          // reaches 0 we mark done=true but leave kind=3 so the
          // spun orientation persists in the rendered transform.
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
    const MAX = 4096 // runaway guard - generous enough for any real script
    while (!t.dead && count < MAX) {
      const insts = t.script.instructions
      if (t.pc >= insts.length) {
        // Implicit return at end-of-script.
        if (t.callStack.length === 0) { t.dead = true; break }
        this._returnFromCall(t)
        continue
      }
      const ins = insts[t.pc]
      t.pc++
      count++
      if (this._exec(t, ins)) break // exec returned `true` → yielded
    }
    return count
  }

  // _exec runs one instruction.  Returns true when the thread
  // should yield (sleep, wait, dead).  Centralised so the inner
  // loop stays a clean while-switch.
  _exec(t, ins) {
    const op = ins.op
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
        // Grow locals on demand.  CREATE_LOCAL takes an index;
        // STACK_ALLOC just opens a slot.  Either way idempotent.
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
        // GET pops 1-4 inputs depending on the port.  The runtime
        // covers the ports a TA viewer actually needs - others
        // return 0 so legacy scripts that consult exotic ports
        // still run without crashing.
        const port = t.popI()
        // For ports that take extra args (PIECE_XZ etc), they were
        // pushed BEFORE the port.  We don't yet decode every one;
        // the common ones are stateless.
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
        // The Go-side disassembler unpacks piece/axis into separate
        // p1/p2 fields (NOT the legacy packed-low-16-bits encoding
        // some bos documentation describes).  piece=p1, axis=p2.
        // Same convention for every piece-targeted animation opcode
        // below.  The MOVE_NOW / TURN_NOW family is the exception -
        // they encode (piece+axis) plus an immediate value, which the
        // disassembler hands back as a 3-DWORD instruction; see those
        // cases for the special-handling.
        //
        // Stack layout: the bos compiler pushes SPEED first (deeper)
        // then TARGET (on top), so popI() returns the target first.
        // Getting this order wrong sends barrels off to absurd
        // distances at glacial speeds, which is exactly what made the
        // Millennium's recoil look like an endless backwards crawl
        // until this was caught.
        //
        // done=false starts the new animation; the animator tick
        // will flip it back to true when target is reached.
        //
        // Slot family: MOVE writes to _moveAnims, so a TURN on the
        // SAME (piece, axis) lives in a separate slot and isn't
        // overwritten — corgant's arm1a needs both `turn z 87°` AND
        // `move z -12.25wu` to be live at the same time.
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
        // Spins are continuous (no target); done=false keeps the
        // tick loop running so value accumulates each frame.  A
        // STOP_SPIN issues a decel that eventually flips done=true.
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
        // MOVE_NOW / TURN_NOW carry (piece, axis, value) as three
        // inline DWORDs.  The Go disassembler emits the first two
        // (piece, axis) as p1+p2 and reads the value from the stack
        // via a preceding PUSH_CONST - so we pop the value off the
        // stack instead of reading a third operand.  done=true
        // immediately because the snap is instantaneous.
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
      case OP_SHADE:
      case OP_DONT_SHADE:
      case OP_CACHE:
      case OP_DONT_CACHE:
      case OP_DONT_SHADOW:
        // Rendering hints we don't model - safe to no-op.
        return false
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
        // Wait until the (piece, axis) turn animator reports idle.
        // piece=p1, axis=p2 - same separated-operand layout as OP_TURN.
        // family='rot' routes _animDone() to the _rotAnims array.
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
        if (t.callStack.length === 0) { t.dead = true; return true }
        this._returnFromCall(t, ret)
        return false
      }
      case OP_START_SCRIPT: {
        const childIdx = ins.p1
        const argCount = ins.p2
        const args = []
        for (let i = 0; i < argCount; i++) args.unshift(t.popI())
        if (childIdx >= 0 && childIdx < this.scripts.length) {
          // Suppression check.  Studio adds names like
          // "RestoreAfterDelay" here so the auto-snap-back doesn't
          // overwrite the user's aim.  Args are already popped off
          // the parent's stack so the call site continues cleanly
          // regardless of whether the child actually spawns.
          if (!this._suppressed.has(this.scriptNames[childIdx].toLowerCase())) {
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
          // Reuse the same thread - push a frame, switch script.
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
        // Multiplayer-only opcodes; safe to ignore in a viewer.
        return false

      default:
        // Unknown opcodes are logged once via the optional hook and
        // then skipped so a single unimplemented op doesn't hang the
        // entire script.
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
