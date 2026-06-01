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
		ins := insts[t.pc]
		t.pc++
		if u.exec(t, ins) {
			return
		}
	}
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
			ID:         int(t.id),
			Script:     sd.name,
			PC:         t.pc,
			Offset:     offset,
			SleepMs:    int(t.sleepMs),
			SignalMask: int(t.signalMask),
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
