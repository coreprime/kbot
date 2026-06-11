package script

import (
	"strings"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/rng"
)

// stepMs is one TA tick in milliseconds (40 Hz). Sleeps and animators advance
// on this fixed grid so timed sequences play at TA's cadence regardless of the
// host's frame rate.
const stepMs int64 = 1000 / ticksPerSecond

// Runtime hosts every unit's script VM for one world and advances them in
// lockstep on a fixed tick. It owns the deterministic RNG that OP_RAND draws
// from, so the whole simulation reproduces from a seed. It satisfies
// sim.Runtime: the world calls Tick once per simulated tick with its running
// millisecond clock.
type Runtime struct {
	units   []*Unit
	rng     *rng.Rng
	lastMs  int64
	started bool
}

// NewRuntime builds a runtime whose script RNG is seeded deterministically.
// Every client seeded identically draws the same script randomness in the same
// order, which is what keeps script-driven outcomes in lockstep.
func NewRuntime(seed uint32) *Runtime { return &Runtime{rng: rng.New(seed)} }

// NewUnit instantiates a unit of the given program with an optional Host and
// registers it for ticking. The returned *Unit satisfies sim.Binding.
func (r *Runtime) NewUnit(p *Program, host Host) *Unit {
	np := len(p.pieceNames)
	u := &Unit{
		rt:        r,
		prog:      p,
		host:      host,
		static:    make([]int32, p.numStatic),
		moveAnims: makeAnims(np * 3),
		rotAnims:  makeAnims(np * 3),
		visible:   make([]bool, np),
	}
	for i := range u.visible {
		u.visible[i] = true
	}
	r.units = append(r.units, u)
	return u
}

// Reset drops every hosted unit and rewinds the tick clock. The world calls
// this when it rebuilds its unit set (a resync from an authoritative snapshot)
// so stale script state can't leak across the restore.
func (r *Runtime) Reset() {
	r.units = nil
	r.lastMs = 0
	r.started = false
}

// Tick advances script time to the world's millisecond clock in fixed steps.
// The world increments its clock by exactly one tick before each call, so in
// steady state this runs a single step; the loop only matters if the clock ever
// jumps forward, and a fresh runtime aligns to the first observed time rather
// than fast-forwarding through history.
func (r *Runtime) Tick(ms int64) {
	if !r.started {
		r.lastMs = ms - stepMs
		r.started = true
	}
	for r.lastMs+stepMs <= ms {
		r.lastMs += stepMs
		snap := append([]*Unit(nil), r.units...)
		for _, u := range snap {
			u.tickStep()
		}
	}
}

func makeAnims(n int) []pieceAnim {
	a := make([]pieceAnim, n)
	for i := range a {
		a[i].done = true
	}
	return a
}

// Unit is one unit's live script state: its threads, static variables and
// per-piece animators. It satisfies sim.Binding.
type Unit struct {
	rt        *Runtime
	prog      *Program
	host      Host
	static    []int32
	moveAnims []pieceAnim
	rotAnims  []pieceAnim
	visible   []bool
	threads   []*thread
	// nextID hands out a stable per-unit identifier to each thread the unit
	// spawns. Debug-only (the studio's Runtime panel keys its thread list on it);
	// it never influences execution order, so it stays out of the world hash.
	nextID int32
	// effects buffers the render-only events the script emits via the COB
	// effect opcodes (EMIT_SFX / EXPLODE / PLAY_SOUND) during a tick. The world
	// drains it after each Tick, stamps the unit id + world anchor, and folds it
	// into the render snapshot's event stream. Render-only: it never feeds the
	// world hash, so it can't perturb determinism.
	effects []frame.Event
	// doneReturns records the return value of every thread that died during the
	// current tick, keyed by thread id, so a caller polling for an aim thread's
	// completion (the weapon SM gating fire on AimWeapon returning TRUE) can read
	// the result in the same tick before the dead thread is pruned. It is cleared
	// at the top of every tickStep, so it only ever holds this tick's deaths.
	doneReturns map[int32]int32
	// doneCorpse mirrors doneReturns for TA's Killed(severity, corpsetype)
	// out-param convention: when a thread dies, its second local (the
	// corpsetype the script chose) is recorded here for a same-tick
	// KilledStatus poll. Cleared with doneReturns at the top of each tick.
	doneCorpse map[int32]int32
	// weaponReady / weaponAborted accumulate TA:K's aim handshake: a v6 script
	// signals "weapon N has an aim solution" by writing N into the WEAPON_READY
	// port (and aborts via WEAPON_AIM_ABORTED) rather than returning a value
	// from its aim thread. Each write sets bit N; the world's weapon state
	// machine consumes bits through TakeWeaponReady / TakeWeaponAimAborted.
	// Deterministic state: it only changes through script execution.
	weaponReady   uint32
	weaponAborted uint32
	// finishedDying latches once the Dying script sets FINISHED_DYING —
	// TA:K's signal that the fall animation has completed.
	finishedDying bool
	// breakpoints and executed back the studio debugger, which runs against this
	// VM in the offline unit editor. breakpoints holds the byte offsets a thread
	// should park on, keyed by script index; executed accumulates every offset the
	// unit has run, for the coverage-dimming view. Both are debug-only — they
	// never feed the world hash — so they carry no determinism contract.
	breakpoints map[int]map[uint32]bool
	executed    map[int]map[uint32]bool
	// ports is the writable COB unit-value store consulted by GET_UNIT_VALUE /
	// SET_VALUE when no Host is attached. The offline unit editor drives it from
	// its inspector sliders (HEALTH / build / activation / standing orders) so
	// scripts such as SmokeUnit and MotionControl observe the user's chosen state.
	// Port writes never feed the world hash — combat-authoritative state lives on
	// the sim unit — so the editor's port pokes carry no determinism contract.
	ports map[int]int32
}

// recordEffect buffers one COB effect opcode as a partially-filled render event.
// piece is the opcode's piece operand (or volume for PLAY_SOUND); arg carries
// the sfx type (EMIT_SFX / EXPLODE) or the sound id (PLAY_SOUND). The world fills
// in UnitID and Anchor when it drains the buffer.
func (u *Unit) recordEffect(kind frame.EventKind, piece, arg int) {
	u.effects = append(u.effects, frame.Event{Kind: kind, Slot: piece, SfxType: arg})
}

// DrainEffects returns the effect events buffered since the last drain and
// clears the buffer. The world calls it each tick to harvest script-emitted
// SFX / sounds for the render snapshot.
func (u *Unit) DrainEffects() []frame.Event {
	if len(u.effects) == 0 {
		return nil
	}
	out := u.effects
	u.effects = nil
	return out
}

// newThread allocates a thread carrying the next per-unit id. Centralizing
// creation keeps ids monotonic so the inspector can follow a thread across ticks.
func (u *Unit) newThread(scriptIndex int, locals []int32) *thread {
	u.nextID++
	return &thread{id: u.nextID, scriptIndex: scriptIndex, locals: locals}
}

// KillAllThreads marks every live thread on every hosted unit dead. It backs the
// studio's "Terminate All Scripts" developer command; the next tickStep prunes
// the dead threads. Debug-only — a sandbox tool, never driven from gameplay — so
// it carries no determinism contract.
func (r *Runtime) KillAllThreads() {
	for _, u := range r.units {
		u.KillAllThreads()
	}
}

// KillAllThreads marks every live thread on this unit dead (the per-unit "Stop
// all threads" developer command). Animators keep their last pose; only the
// threads stop.
func (u *Unit) KillAllThreads() {
	for _, t := range u.threads {
		t.dead = true
	}
}

// KillThread marks the single thread with the given id dead (the per-thread kill
// button in the Runtime panel). Unknown ids are ignored.
func (u *Unit) KillThread(id int32) {
	for _, t := range u.threads {
		if t.id == id {
			t.dead = true
			return
		}
	}
}

// KillThreadsByName marks dead every live thread running the named script. The
// offline unit editor uses it to retract a transient pose handler (the
// RestoreAfterDelay / RestorePosition threads a one-shot aim leaves behind)
// before re-driving the unit. Unknown names are ignored.
func (u *Unit) KillThreadsByName(name string) {
	idx, ok := u.prog.ScriptIndex(name)
	if !ok {
		return
	}
	for _, t := range u.threads {
		if !t.dead && t.scriptIndex == idx {
			t.dead = true
		}
	}
}

// ResetState returns the unit to a clean slate: every thread dies, static vars
// zero, animators snap back to rest, and all pieces become visible — the
// per-unit "Reset" developer command. It does not re-run Create; the caller
// decides whether to restart any entry point.
func (u *Unit) ResetState() {
	u.threads = nil
	for i := range u.static {
		u.static[i] = 0
	}
	u.moveAnims = makeAnims(len(u.moveAnims))
	u.rotAnims = makeAnims(len(u.rotAnims))
	for i := range u.visible {
		u.visible[i] = true
	}
	u.effects = nil
	for k := range u.doneReturns {
		delete(u.doneReturns, k)
	}
	for k := range u.ports {
		delete(u.ports, k)
	}
	u.weaponReady = 0
	u.weaponAborted = 0
	u.finishedDying = false
}

// noteWeaponPortWrite records a SET_VALUE write to one of TA:K's signalling
// ports: the weapon handshake pair (value = weapon index) and FINISHED_DYING
// (the Dying fall animation's completion flag). Out-of-range weapon indices
// (a script writing garbage) are ignored rather than wrapped.
func (u *Unit) noteWeaponPortWrite(port int, v int32) {
	if port == UVFinishedDying {
		if v != 0 {
			u.finishedDying = true
		}
		return
	}
	if v < 0 || v > 31 {
		return
	}
	switch port {
	case UVWeaponReady:
		u.weaponReady |= 1 << uint(v)
	case UVWeaponAimAborted:
		u.weaponAborted |= 1 << uint(v)
	}
}

// FinishedDying reports whether the unit's Dying script has signalled
// completion by setting FINISHED_DYING — TA:K's cue that the fall animation
// has landed and the corpse swap can happen.
func (u *Unit) FinishedDying() bool { return u.finishedDying }

// TakeWeaponReady reports whether the script has signalled WEAPON_READY for
// the given weapon index since the last call, clearing the flag. This is the
// TA:K equivalent of an aim thread returning TRUE.
func (u *Unit) TakeWeaponReady(slot int) bool {
	if slot < 0 || slot > 31 {
		return false
	}
	bit := uint32(1) << uint(slot)
	if u.weaponReady&bit == 0 {
		return false
	}
	u.weaponReady &^= bit
	return true
}

// TakeWeaponAimAborted reports whether the script has signalled
// WEAPON_AIM_ABORTED for the given weapon index since the last call, clearing
// the flag.
func (u *Unit) TakeWeaponAimAborted(slot int) bool {
	if slot < 0 || slot > 31 {
		return false
	}
	bit := uint32(1) << uint(slot)
	if u.weaponAborted&bit == 0 {
		return false
	}
	u.weaponAborted &^= bit
	return true
}

// SetUnitValuePort writes a COB unit-value port that scripts read via
// GET_UNIT_VALUE (TA's GetUnitValue). The offline unit editor uses it to drive
// HEALTH / build-percent / activation / standing-orders from its inspector
// sliders. With no Host attached this store is the port source; a hosted unit
// routes through the Host instead. Debug/authoring-only — never feeds the hash.
func (u *Unit) SetUnitValuePort(port int, v int32) {
	if u.ports == nil {
		u.ports = map[int]int32{}
	}
	u.ports[port] = v
}

// UnitValuePort reports the current value of a COB unit-value port (the read the
// inspector's Ports panel surfaces). Returns the effective value GET_UNIT_VALUE
// would yield: an explicit port write, else TA's resting default.
func (u *Unit) UnitValuePort(port int) int32 {
	return u.getUnitValue(port)
}

// threadByID returns the thread carrying the given per-unit id, or nil. Used by
// the debugger control methods, which key on the same id the inspector reports.
func (u *Unit) threadByID(id int32) *thread {
	for _, t := range u.threads {
		if t.id == id {
			return t
		}
	}
	return nil
}

// StepThread advances one thread by exactly one instruction (the debugger's
// "Step" button). It clears any sleep / wait so the instruction runs now and
// resumes past a breakpoint the thread is parked on. A missing or dead thread is
// a no-op. Debug-only — never driven from gameplay.
func (u *Unit) StepThread(id int32) {
	t := u.threadByID(id)
	if t == nil || t.dead {
		return
	}
	t.sleepMs = 0
	t.waitOn = nil
	t.breakpointHit = false
	t.bpResume = false
	for !t.dead {
		insts := u.prog.scripts[t.scriptIndex].insts
		if t.pc >= len(insts) {
			if len(t.callStack) == 0 {
				t.dead = true
				return
			}
			u.returnFromCall(t, 0)
			continue
		}
		ins := insts[t.pc]
		u.markExecuted(t.scriptIndex, ins.Offset)
		t.pc++
		u.exec(t, ins)
		return
	}
}

// SetThreadPC moves a thread's program counter to an instruction index and
// clears its sleep / wait / breakpoint-parked state so execution resumes from
// the new spot. The index is clamped to the current script's instruction range.
func (u *Unit) SetThreadPC(id int32, pc int) {
	t := u.threadByID(id)
	if t == nil || t.dead {
		return
	}
	n := len(u.prog.scripts[t.scriptIndex].insts)
	if pc < 0 {
		pc = 0
	}
	if pc > n {
		pc = n
	}
	t.pc = pc
	t.sleepMs = 0
	t.waitOn = nil
	t.breakpointHit = false
}

// SetThreadLocal writes one of a thread's local variables (the debugger's
// editable Locals tray). Out-of-range indices are ignored.
func (u *Unit) SetThreadLocal(id int32, idx int, v int32) {
	t := u.threadByID(id)
	if t == nil || idx < 0 || idx >= len(t.locals) {
		return
	}
	t.locals[idx] = v
}

// SetStatic writes one of the unit's static variables (the debugger's editable
// Globals tray). Out-of-range indices are ignored.
func (u *Unit) SetStatic(idx int, v int32) {
	if idx < 0 || idx >= len(u.static) {
		return
	}
	u.static[idx] = v
}

// AddBreakpoint sets a breakpoint at a byte offset of one script; RemoveBreakpoint
// clears it; ClearBreakpoints drops every breakpoint on the unit. Threads park on
// a set offset before executing its instruction.
func (u *Unit) AddBreakpoint(scriptIdx int, offset uint32) {
	if scriptIdx < 0 || scriptIdx >= len(u.prog.scripts) {
		return
	}
	if u.breakpoints == nil {
		u.breakpoints = make(map[int]map[uint32]bool)
	}
	offs := u.breakpoints[scriptIdx]
	if offs == nil {
		offs = make(map[uint32]bool)
		u.breakpoints[scriptIdx] = offs
	}
	offs[offset] = true
}

func (u *Unit) RemoveBreakpoint(scriptIdx int, offset uint32) {
	if offs := u.breakpoints[scriptIdx]; offs != nil {
		delete(offs, offset)
	}
}

func (u *Unit) ClearBreakpoints() { u.breakpoints = nil }

// ClearBreakpointHits releases every thread parked on a breakpoint (the
// debugger's "Continue"): it clears the hit flag and arms bpResume so the thread
// runs past the breakpoint it is stopped on rather than re-parking immediately.
func (u *Unit) ClearBreakpointHits() {
	for _, t := range u.threads {
		if t.breakpointHit {
			t.breakpointHit = false
			t.bpResume = true
		}
	}
}

// Coverage returns a stable snapshot of every executed byte offset, keyed by
// script index, for the debugger's coverage-dimming view.
func (u *Unit) Coverage() map[int][]uint32 {
	out := make(map[int][]uint32, len(u.executed))
	for idx, offs := range u.executed {
		list := make([]uint32, 0, len(offs))
		for off := range offs {
			list = append(list, off)
		}
		out[idx] = list
	}
	return out
}

func animKey(piece, axis int) int { return piece*3 + axis }

func (u *Unit) moveAnim(piece, axis int) *pieceAnim {
	if piece < 0 || axis < 0 || axis > 2 {
		return nil
	}
	k := animKey(piece, axis)
	if k >= len(u.moveAnims) {
		return nil
	}
	return &u.moveAnims[k]
}

func (u *Unit) rotAnim(piece, axis int) *pieceAnim {
	if piece < 0 || axis < 0 || axis > 2 {
		return nil
	}
	k := animKey(piece, axis)
	if k >= len(u.rotAnims) {
		return nil
	}
	return &u.rotAnims[k]
}

func (u *Unit) setVisible(piece int, v bool) {
	if piece >= 0 && piece < len(u.visible) {
		u.visible[piece] = v
	}
}

func (u *Unit) animDone(w *waitCond) bool {
	arr := u.moveAnims
	if w.rot {
		arr = u.rotAnims
	}
	if w.key < 0 || w.key >= len(arr) {
		return true
	}
	return arr[w.key].done
}

// tickStep runs one fixed tick of script time: advance animators, resolve waits
// and sleeps, then run each ready thread to its next yield. Threads spawned this
// tick run next tick, matching the snapshot semantics scripts are written
// against.
func (u *Unit) tickStep() {
	// Reset this tick's death ledger; only threads that die during this tick's
	// run should be visible to a same-tick AimStatus poll.
	for k := range u.doneReturns {
		delete(u.doneReturns, k)
	}
	for k := range u.doneCorpse {
		delete(u.doneCorpse, k)
	}
	tickAnimArray(u.moveAnims)
	tickAnimArray(u.rotAnims)
	snap := append([]*thread(nil), u.threads...)
	for _, t := range snap {
		if t.dead {
			continue
		}
		if t.waitOn != nil {
			if u.animDone(t.waitOn) {
				t.waitOn = nil
				t.sleepMs = 0
			} else {
				continue
			}
		}
		if t.sleepMs > 0 {
			t.sleepMs -= stepMs
			if t.sleepMs > 0 {
				continue
			}
			t.sleepMs = 0
		}
		u.runThread(t)
	}
	live := u.threads[:0]
	for _, t := range u.threads {
		if !t.dead {
			live = append(live, t)
			continue
		}
		// Record the dying thread's return value so a same-tick poll can read it
		// before the thread vanishes from the slice.
		if u.doneReturns == nil {
			u.doneReturns = make(map[int32]int32)
		}
		u.doneReturns[t.id] = t.returnValue
		if u.doneCorpse == nil {
			u.doneCorpse = make(map[int32]int32)
		}
		u.doneCorpse[t.id] = localAt(t.locals, 1)
	}
	u.threads = live
}

// runThread executes a thread until it yields or dies. The instruction slice is
// re-read every iteration because CALL_SCRIPT and end-of-script returns swap the
// thread to a different script's code.
func (u *Unit) runThread(t *thread) {
	const max = 4096
	for n := 0; !t.dead && n < max; n++ {
		insts := u.prog.scripts[t.scriptIndex].insts
		if t.pc >= len(insts) {
			if len(t.callStack) == 0 {
				t.dead = true
				return
			}
			u.returnFromCall(t, 0)
			continue
		}
		// Debugger: park on a breakpoint before executing its instruction, unless
		// we just resumed from one (bpResume lets a step / continue clear the
		// instruction the thread is stopped on). Coverage stamps run regardless.
		ins := insts[t.pc]
		if u.atBreakpoint(t, ins.Offset) {
			t.breakpointHit = true
			return
		}
		t.bpResume = false
		u.markExecuted(t.scriptIndex, ins.Offset)
		t.pc++
		if u.exec(t, ins) {
			return
		}
	}
}

// atBreakpoint reports whether a breakpoint is set at the given offset of the
// thread's current script and execution should park on it. A resuming thread
// (bpResume) clears the breakpoint it is stopped on so a step / continue can
// proceed; the flag is consumed once the instruction runs.
func (u *Unit) atBreakpoint(t *thread, offset uint32) bool {
	if t.bpResume {
		return false
	}
	offs := u.breakpoints[t.scriptIndex]
	return offs != nil && offs[offset]
}

// markExecuted records that the given offset of a script has run, for the
// debugger's coverage view. Debug-only; lazily allocated so a unit with no
// debugger attached never grows the maps.
func (u *Unit) markExecuted(scriptIdx int, offset uint32) {
	if u.executed == nil {
		u.executed = make(map[int]map[uint32]bool)
	}
	offs := u.executed[scriptIdx]
	if offs == nil {
		offs = make(map[uint32]bool)
		u.executed[scriptIdx] = offs
	}
	offs[offset] = true
}

func (u *Unit) startScript(caller *thread, childIdx, argCount int) {
	if childIdx < 0 || childIdx >= len(u.prog.scripts) {
		return
	}
	args := make([]int32, argCount)
	for i := argCount - 1; i >= 0; i-- {
		args[i] = caller.pop()
	}
	lower := strings.ToLower(u.prog.scripts[childIdx].name)
	// A re-issued script cancels its prior instance, matching TA: a second
	// AimPrimary supersedes the first, a new MotionControl clobbers the old
	// walk thread. The caller is spared so a script may legally restart itself.
	for _, ex := range u.threads {
		if ex == caller || ex.dead {
			continue
		}
		if strings.ToLower(u.prog.scripts[ex.scriptIndex].name) == lower {
			ex.dead = true
		}
	}
	u.threads = append(u.threads, u.newThread(childIdx, args))
}

func (u *Unit) callScript(t *thread, childIdx, argCount int) {
	if childIdx < 0 || childIdx >= len(u.prog.scripts) {
		return
	}
	args := make([]int32, argCount)
	for i := argCount - 1; i >= 0; i-- {
		args[i] = t.pop()
	}
	t.callStack = append(t.callStack, callFrame{scriptIndex: t.scriptIndex, pc: t.pc, locals: t.locals})
	t.scriptIndex = childIdx
	t.pc = 0
	t.locals = args
}

// signal marks every thread whose signal mask intersects n for death. Scoped to
// this unit — signals never cross to other units.
func (u *Unit) signal(n int32) {
	for _, t := range u.threads {
		if t.signalMask&n != 0 {
			t.dead = true
		}
	}
}

// HasScript reports whether the unit's program defines the named entry point.
func (u *Unit) HasScript(name string) bool { return u.prog.HasScript(name) }

// ScriptNames returns the unit type's script entry-point names in index order,
// the list the offline editor's Actions panel turns into a run-script button
// per entry (Create, Activate, AimPrimary, …).
func (u *Unit) ScriptNames() []string { return u.prog.ScriptNames() }

// Start spawns a thread on the named script with the given integer arguments as
// its initial locals. Unknown names are ignored, matching the world's
// fire-and-forget calls into optional handlers (Create, StartMoving, ...).
func (u *Unit) Start(name string, args ...int) {
	idx, ok := u.prog.ScriptIndex(name)
	if !ok {
		return
	}
	u.threads = append(u.threads, u.newThread(idx, toI32(args)))
}

// Restart spawns a thread on the named script, first marking any live thread
// already running that same script dead. It gives the world the COB START
// opcode's supersede semantics, so a continuously re-driven tracking thread (a
// weapon's aim loop, re-issued as its target moves) replaces its prior instance
// instead of accumulating a fresh thread every tick.
func (u *Unit) Restart(name string, args ...int) {
	idx, ok := u.prog.ScriptIndex(name)
	if !ok {
		return
	}
	for _, ex := range u.threads {
		if !ex.dead && ex.scriptIndex == idx {
			ex.dead = true
		}
	}
	u.threads = append(u.threads, u.newThread(idx, toI32(args)))
}

// StartAim spawns the named aim script with the COB START supersede semantics
// (cancelling any live instance) and returns the new thread's id so the caller
// can poll its completion via AimStatus. It returns 0 if the script is unknown,
// which AimStatus reads as "already done" so a unit without the script never
// blocks its fire cadence.
func (u *Unit) StartAim(name string, args ...int) int32 {
	idx, ok := u.prog.ScriptIndex(name)
	if !ok {
		return 0
	}
	for _, ex := range u.threads {
		if !ex.dead && ex.scriptIndex == idx {
			ex.dead = true
		}
	}
	t := u.newThread(idx, toI32(args))
	u.threads = append(u.threads, t)
	return t.id
}

// AimStatus reports whether the thread with the given id has finished and, if
// so, the value it returned. A still-running thread reports (false, 0). A thread
// that died this tick reports its captured return value from the death ledger.
// An id that is neither live nor in the ledger — already pruned, or never a real
// thread (id 0) — reports (true, 1): a vanished aim thread is treated as a
// completed, successful aim so the weapon SM degrades to firing rather than
// stalling forever.
func (u *Unit) AimStatus(id int32) (done bool, ret int32) {
	for _, t := range u.threads {
		if t.id == id && !t.dead {
			return false, 0
		}
	}
	if rv, ok := u.doneReturns[id]; ok {
		return true, rv
	}
	return true, 1
}

// KilledStatus reports whether the tracked Killed thread has finished and,
// when it has, the corpsetype its second local held — TA's out-param
// convention (1 = intact corpse, 2 = damaged, 3 = nothing). A vanished or
// never-real id reports (true, 1) so a unit whose death script was pruned
// still leaves the default corpse.
func (u *Unit) KilledStatus(id int32) (done bool, corpsetype int32) {
	for _, t := range u.threads {
		if t.id == id && !t.dead {
			return false, 0
		}
	}
	if v, ok := u.doneCorpse[id]; ok {
		return true, v
	}
	return true, 1
}

// RunQuery executes a Query* script synchronously within the current tick and
// returns the value its first local ended up holding — the convention TA uses
// to report a firing piece. It fails (ok=false) if the script does not exist or
// would yield (sleep/wait/animate/spawn), keeping the synchronous contract honest.
func (u *Unit) RunQuery(name string, args ...int) (int32, bool) {
	idx, ok := u.prog.ScriptIndex(name)
	if !ok {
		return 0, false
	}
	t := u.newThread(idx, toI32(args))
	t.queryOnly = true
	for n := 0; !t.dead && n < 1024; n++ {
		insts := u.prog.scripts[t.scriptIndex].insts
		if t.pc >= len(insts) {
			t.dead = true
			break
		}
		ins := insts[t.pc]
		t.pc++
		yielded := u.exec(t, ins)
		if t.dead {
			break
		}
		if yielded {
			return 0, false
		}
	}
	if len(t.locals) > 0 {
		return t.locals[0], true
	}
	return 0, false
}

// Pieces returns the current per-piece transform for the render snapshot. A
// piece with no active animator on an axis contributes its rest value (zero
// offset / rotation), and visibility reflects SHOW/HIDE.
func (u *Unit) Pieces() []frame.PieceState {
	n := len(u.prog.pieceNames)
	out := make([]frame.PieceState, n)
	for i := 0; i < n; i++ {
		out[i] = frame.PieceState{
			Offset: fixed.Vec3{
				X: u.moveValue(i, 0),
				Y: u.moveValue(i, 1),
				Z: u.moveValue(i, 2),
			},
			Rot: [3]int32{
				u.rotValue(i, 0),
				u.rotValue(i, 1),
				u.rotValue(i, 2),
			},
			Visible: u.visible[i],
		}
	}
	return out
}

// CobState returns the unit's inspectable script state — a copy of its static
// variables plus a per-live-thread summary — for the studio's Runtime / Script
// Variables panels. Debug-only: it never feeds the world hash, so reporting it
// cannot perturb determinism.
func (u *Unit) CobState() frame.CobUnitState {
	threads := make([]frame.CobThread, 0, len(u.threads))
	for _, t := range u.threads {
		if t.dead {
			continue
		}
		sd := u.prog.scripts[t.scriptIndex]
		offset := 0
		if t.pc >= 0 && t.pc < len(sd.insts) {
			offset = int(sd.insts[t.pc].Offset)
		} else if n := len(sd.insts); n > 0 {
			offset = int(sd.insts[n-1].Offset)
		}
		ct := frame.CobThread{
			ID:            int(t.id),
			Script:        sd.name,
			PC:            t.pc,
			Offset:        offset,
			SleepMs:       int(t.sleepMs),
			SignalMask:    int(t.signalMask),
			Locals:        append([]int32(nil), t.locals...),
			Stack:         append([]int32(nil), t.stack...),
			BreakpointHit: t.breakpointHit,
		}
		if t.waitOn != nil {
			ct.Waiting = true
			ct.WaitTurn = t.waitOn.rot
		}
		threads = append(threads, ct)
	}
	return frame.CobUnitState{
		Static:  append([]int32(nil), u.static...),
		Threads: threads,
	}
}

// moveValue is a piece axis's translation in world units. A COB linear operand
// counts 1/65536 of a world unit, the same scale as fixed.Fixed, so the
// animator's integer value is already the world-unit offset's raw fixed form.
func (u *Unit) moveValue(piece, axis int) fixed.Fixed {
	k := animKey(piece, axis)
	if k >= len(u.moveAnims) {
		return 0
	}
	a := &u.moveAnims[k]
	if a.kind == animIdle {
		return 0
	}
	return fixed.Fixed(a.value.Int())
}

// rotValue is a piece axis's rotation as a raw TA-angle (65536 per turn).
func (u *Unit) rotValue(piece, axis int) int32 {
	k := animKey(piece, axis)
	if k >= len(u.rotAnims) {
		return 0
	}
	a := &u.rotAnims[k]
	if a.kind == animIdle {
		return 0
	}
	return int32(a.value.Int())
}

func toI32(args []int) []int32 {
	out := make([]int32, len(args))
	for i, v := range args {
		out[i] = int32(v)
	}
	return out
}
