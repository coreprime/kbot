package script

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/formats/scripting"
)

// taTurnsPerCircle is TA's angular unit: a full turn is 65536 angle-units, the
// same scale COB angle operands use.
const taTurnsPerCircle = 65536

// ticksPerSecond is the simulation rate the VM advances at. COB speeds are
// expressed per second, so each fixed tick moves an animator by speed/40. It
// matches sim.TickHz; the VM keeps its own copy to avoid importing sim.
const ticksPerSecond = 40

// animator kinds.
const (
	animIdle = iota
	animMove // linear translation toward target at speed units/sec
	animTurn // angular rotation toward target at speed angle-units/sec
	animSpin // continuous angular rotation; STOP_SPIN decelerates to rest
)

// Host is the optional callback surface the world exposes to running scripts:
// unit-value ports the scripts poll/set and the effect opcodes (EMIT_SFX,
// PLAY_SOUND, EXPLODE). A nil Host makes the VM self-contained — GET reads
// return TA's engine defaults and effect opcodes are no-ops — which is what the
// VM's unit tests rely on. The world supplies a real Host once combat and
// effects are wired through.
type Host interface {
	GetUnitValue(port int) int32
	SetUnitValue(port, value int)
	EmitSfx(sfxType, piece int)
	PlaySound(sound, volume int)
	Explode(piece, sfxType int)
}

// Unit-value ports the VM answers itself when no Host is attached. The full set
// lives in the engine's value table; these are the ones a script reads before
// any Host wiring exists, defaulted to TA's resting values.
const (
	uvActivation    = 1
	uvHealth        = 4
	uvInBuildStance = 5
	uvBusy          = 6
	uvArmored       = 20
)

// pieceAnim is one (piece, axis) animator. value/target/speed are fixed-point
// numbers whose real value equals the COB integer operand, so sub-tick motion
// accumulates without integer-division drift. kind is sticky after the first
// MOVE/TURN/SPIN so a finished animation holds its resting pose instead of
// snapping back to zero; done tracks whether motion is still in progress, which
// is what WAIT_FOR_TURN/WAIT_FOR_MOVE poll.
type pieceAnim struct {
	kind   int
	value  fixed.Fixed
	target fixed.Fixed
	speed  fixed.Fixed
	decel  fixed.Fixed
	done   bool
}

// waitCond names the animator a blocked thread is waiting on. rot=false selects
// the move animator array, rot=true the rotation array.
type waitCond struct {
	rot bool
	key int
}

// callFrame saves a caller's execution context across CALL_SCRIPT.
type callFrame struct {
	scriptIndex int
	pc          int
	locals      []int32
}

// thread is one cooperative COB thread: a private program counter, operand
// stack, locals and signal mask. Threads yield only on SLEEP/WAIT_FOR_* (and
// die on RETURN at top level or when a matching signal fires).
type thread struct {
	id          int32
	scriptIndex int
	pc          int
	stack       []int32
	locals      []int32
	signalMask  int32
	dead        bool
	sleepMs     int64
	waitOn      *waitCond
	callStack   []callFrame
	returnValue int32
	queryOnly   bool
	// breakpointHit is set when the thread parks on a breakpoint instruction (the
	// debugger autopauses on it); bpResume suppresses the breakpoint check for the
	// next instruction so a step / continue can move execution past the
	// breakpoint it is stopped on. Both are debug-only and never hashed.
	breakpointHit bool
	bpResume      bool
}

func (t *thread) push(v int32) { t.stack = append(t.stack, v) }
func (t *thread) pop() int32 {
	n := len(t.stack)
	if n == 0 {
		return 0
	}
	v := t.stack[n-1]
	t.stack = t.stack[:n-1]
	return v
}

// dtStep returns the per-tick advance for a per-second speed: speed/40, kept in
// fixed-point so the fractional remainder carries between ticks deterministically.
var ticksPerSec = fixed.FromInt(ticksPerSecond)

func dtStep(speed fixed.Fixed) fixed.Fixed { return speed.Div(ticksPerSec) }

func abs(v fixed.Fixed) fixed.Fixed {
	if v < 0 {
		return -v
	}
	return v
}

func sign(v fixed.Fixed) fixed.Fixed {
	switch {
	case v > 0:
		return fixed.One
	case v < 0:
		return -fixed.One
	default:
		return 0
	}
}

// tickAnimArray advances every in-progress animator in arr by one tick.
func tickAnimArray(arr []pieceAnim) {
	half := fixed.FromInt(taTurnsPerCircle / 2)
	circle := fixed.FromInt(taTurnsPerCircle)
	for i := range arr {
		a := &arr[i]
		if a.done {
			continue
		}
		switch a.kind {
		case animMove:
			delta := a.target - a.value
			step := dtStep(a.speed)
			if abs(delta) <= step {
				a.value = a.target
				a.done = true
			} else {
				a.value += sign(delta).Mul(step)
			}
		case animTurn:
			delta := a.target - a.value
			for delta > half {
				delta -= circle
			}
			for delta < -half {
				delta += circle
			}
			step := dtStep(a.speed)
			if abs(delta) <= step {
				a.value = a.target
				a.done = true
			} else {
				a.value += sign(delta).Mul(step)
			}
		case animSpin:
			a.value += dtStep(a.speed)
			if a.value > circle {
				a.value -= circle
			}
			if a.value < -circle {
				a.value += circle
			}
			if a.decel > 0 {
				ds := dtStep(a.decel)
				if abs(a.speed) <= ds {
					a.speed = 0
					a.done = true
					a.decel = 0
				} else {
					a.speed -= sign(a.speed).Mul(ds)
				}
			}
		}
	}
}

// exec runs one instruction on thread t. It returns true when the thread should
// yield for this tick (SLEEP, WAIT_FOR_*, or top-level RETURN).
func (u *Unit) exec(t *thread, ins Instruction) bool {
	op := ins.Op
	// A runQuery thread must resolve synchronously: any op that would yield,
	// animate a piece or spawn a thread aborts the query (treated as a yield).
	if t.queryOnly {
		switch op {
		case scripting.OP_SLEEP, scripting.OP_WAIT_FOR_TURN, scripting.OP_WAIT_FOR_MOVE,
			scripting.OP_MOVE, scripting.OP_TURN, scripting.OP_SPIN, scripting.OP_STOP_SPIN,
			scripting.OP_START_SCRIPT, scripting.OP_SIGNAL, scripting.OP_SET_SIGNAL_MASK,
			scripting.OP_EMIT_SFX, scripting.OP_EXPLODE, scripting.OP_PLAY_SOUND,
			scripting.OP_ATTACH_UNIT, scripting.OP_DROP_UNIT:
			return true
		}
	}
	switch op {
	// ── Stack ───────────────────────────────────────────────────
	case scripting.OP_PUSH_IMMEDIATE, scripting.OP_PUSH_CONSTANT:
		t.push(ins.P1)
	case scripting.OP_PUSH_LOCAL_VAR:
		t.push(localAt(t.locals, int(ins.P1)))
	case scripting.OP_PUSH_STATIC:
		t.push(staticAt(u.static, int(ins.P1)))
	case scripting.OP_CREATE_LOCAL:
		for len(t.locals) <= int(ins.P1) {
			t.locals = append(t.locals, 0)
		}
	case scripting.OP_STACK_ALLOC:
		t.locals = append(t.locals, 0)
	case scripting.OP_POP_LOCAL_VAR:
		v := t.pop()
		for len(t.locals) <= int(ins.P1) {
			t.locals = append(t.locals, 0)
		}
		t.locals[ins.P1] = v
	case scripting.OP_POP_STATIC:
		v := t.pop()
		for len(u.static) <= int(ins.P1) {
			u.static = append(u.static, 0)
		}
		u.static[ins.P1] = v
	case scripting.OP_POP_STACK:
		t.pop()

	// ── Arithmetic / bitwise (32-bit wrap, matching the bytecode) ─
	case scripting.OP_ADD:
		b, a := t.pop(), t.pop()
		t.push(a + b)
	case scripting.OP_SUB:
		b, a := t.pop(), t.pop()
		t.push(a - b)
	case scripting.OP_MUL:
		b, a := t.pop(), t.pop()
		t.push(a * b)
	case scripting.OP_DIV:
		b, a := t.pop(), t.pop()
		if b == 0 {
			t.push(0)
		} else {
			t.push(a / b)
		}
	case scripting.OP_MOD:
		b, a := t.pop(), t.pop()
		if b == 0 {
			t.push(0)
		} else {
			t.push(a % b)
		}
	case scripting.OP_BITWISE_AND:
		b, a := t.pop(), t.pop()
		t.push(a & b)
	case scripting.OP_BITWISE_OR:
		b, a := t.pop(), t.pop()
		t.push(a | b)
	case scripting.OP_BITWISE_XOR:
		b, a := t.pop(), t.pop()
		t.push(a ^ b)
	case scripting.OP_BITWISE_NOT:
		t.push(^t.pop())

	// ── Comparison / logical (0 = false, 1 = true) ───────────────
	case scripting.OP_LESS_THAN:
		b, a := t.pop(), t.pop()
		t.push(boolI(a < b))
	case scripting.OP_LESS_OR_EQUAL:
		b, a := t.pop(), t.pop()
		t.push(boolI(a <= b))
	case scripting.OP_GREATER_THAN:
		b, a := t.pop(), t.pop()
		t.push(boolI(a > b))
	case scripting.OP_GREATER_EQUAL:
		b, a := t.pop(), t.pop()
		t.push(boolI(a >= b))
	case scripting.OP_EQUAL:
		b, a := t.pop(), t.pop()
		t.push(boolI(a == b))
	case scripting.OP_NOT_EQUAL:
		b, a := t.pop(), t.pop()
		t.push(boolI(a != b))
	case scripting.OP_LOGICAL_AND:
		b, a := t.pop(), t.pop()
		t.push(boolI(a != 0 && b != 0))
	case scripting.OP_LOGICAL_OR:
		b, a := t.pop(), t.pop()
		t.push(boolI(a != 0 || b != 0))
	case scripting.OP_LOGICAL_XOR:
		b, a := t.pop(), t.pop()
		t.push(boolI((a != 0) != (b != 0)))
	case scripting.OP_LOGICAL_NOT:
		t.push(boolI(t.pop() == 0))

	// ── Random / unit values ─────────────────────────────────────
	case scripting.OP_RAND:
		hi, lo := t.pop(), t.pop()
		t.push(int32(u.rt.rng.Range(int(lo), int(hi))))
	case scripting.OP_GET_UNIT_VALUE, scripting.OP_GET:
		t.push(u.getUnitValue(int(t.pop())))
	case scripting.OP_SET_VALUE:
		value := t.pop()
		port := t.pop()
		if u.host != nil {
			u.host.SetUnitValue(int(port), int(value))
		} else {
			u.SetUnitValuePort(int(port), value)
		}

	// ── Piece animation ──────────────────────────────────────────
	case scripting.OP_MOVE:
		target, speed := t.pop(), t.pop()
		if a := u.moveAnim(int(ins.P1), int(ins.P2)); a != nil {
			a.kind = animMove
			a.target = fixed.FromInt(int(target))
			a.speed = abs(fixed.FromInt(int(speed)))
			a.done = false
		}
	case scripting.OP_TURN:
		target, speed := t.pop(), t.pop()
		if a := u.rotAnim(int(ins.P1), int(ins.P2)); a != nil {
			a.kind = animTurn
			a.target = fixed.FromInt(int(target))
			a.speed = abs(fixed.FromInt(int(speed)))
			a.done = false
		}
	case scripting.OP_SPIN:
		speed := t.pop()
		if a := u.rotAnim(int(ins.P1), int(ins.P2)); a != nil {
			a.kind = animSpin
			a.speed = fixed.FromInt(int(speed))
			a.decel = 0
			a.done = false
		}
	case scripting.OP_STOP_SPIN:
		decel := t.pop()
		if a := u.rotAnim(int(ins.P1), int(ins.P2)); a != nil && a.kind == animSpin {
			d := abs(fixed.FromInt(int(decel)))
			if d == 0 {
				d = abs(a.speed)
			}
			a.decel = d
			a.done = false
		}
	case scripting.OP_MOVE_NOW:
		value := t.pop()
		if a := u.moveAnim(int(ins.P1), int(ins.P2)); a != nil {
			a.kind = animMove
			a.value = fixed.FromInt(int(value))
			a.target = a.value
			a.speed = 0
			a.done = true
		}
	case scripting.OP_TURN_NOW:
		value := t.pop()
		if a := u.rotAnim(int(ins.P1), int(ins.P2)); a != nil {
			a.kind = animTurn
			a.value = fixed.FromInt(int(value))
			a.target = a.value
			a.speed = 0
			a.done = true
		}
	case scripting.OP_SHOW:
		u.setVisible(int(ins.P1), true)
	case scripting.OP_HIDE:
		u.setVisible(int(ins.P1), false)
	case scripting.OP_CACHE, scripting.OP_DONT_CACHE, scripting.OP_SHADE,
		scripting.OP_DONT_SHADE, scripting.OP_DONT_SHADOW:
		// Render hints with no bearing on simulation state.
	case scripting.OP_EMIT_SFX:
		sfx := t.pop()
		if u.host != nil {
			u.host.EmitSfx(int(sfx), int(ins.P1))
		}
		u.recordEffect(frame.EvEmitSfx, int(ins.P1), int(sfx))

	// ── Waits ────────────────────────────────────────────────────
	case scripting.OP_SLEEP:
		t.sleepMs = int64(t.pop())
		return true
	case scripting.OP_WAIT_FOR_TURN:
		t.waitOn = &waitCond{rot: true, key: animKey(int(ins.P1), int(ins.P2))}
		return true
	case scripting.OP_WAIT_FOR_MOVE:
		t.waitOn = &waitCond{rot: false, key: animKey(int(ins.P1), int(ins.P2))}
		return true

	// ── Control flow ─────────────────────────────────────────────
	case scripting.OP_JUMP:
		if idx, ok := u.prog.scripts[t.scriptIndex].offsetIdx[uint32(ins.P1)]; ok {
			t.pc = idx
		}
	case scripting.OP_JUMP_IF_FALSE:
		if t.pop() == 0 {
			if idx, ok := u.prog.scripts[t.scriptIndex].offsetIdx[uint32(ins.P1)]; ok {
				t.pc = idx
			}
		}
	case scripting.OP_RETURN:
		var ret int32
		if len(t.stack) > 0 {
			ret = t.pop()
		}
		if len(t.callStack) == 0 {
			t.returnValue = ret
			t.dead = true
			return true
		}
		u.returnFromCall(t, ret)
	case scripting.OP_START_SCRIPT:
		u.startScript(t, int(ins.P1), int(ins.P2))
	case scripting.OP_CALL_SCRIPT:
		u.callScript(t, int(ins.P1), int(ins.P2))
	case scripting.OP_SIGNAL:
		u.signal(t.pop())
	case scripting.OP_SET_SIGNAL_MASK:
		t.signalMask = t.pop()

	// ── Effects ──────────────────────────────────────────────────
	case scripting.OP_EXPLODE:
		sfx := t.pop()
		if u.host != nil {
			u.host.Explode(int(ins.P1), int(sfx))
		}
		u.recordEffect(frame.EvExplode, int(ins.P1), int(sfx))
	case scripting.OP_PLAY_SOUND:
		sound := t.pop()
		if u.host != nil {
			u.host.PlaySound(int(sound), int(ins.P1))
		}
		u.recordEffect(frame.EvPlaySound, int(ins.P1), int(sound))
	case scripting.OP_ATTACH_UNIT, scripting.OP_DROP_UNIT:
		// Unit attachment is resolved by the world, not the script VM.
	}
	return false
}

func (u *Unit) getUnitValue(port int) int32 {
	if u.host != nil {
		return u.host.GetUnitValue(port)
	}
	if u.ports != nil {
		if v, ok := u.ports[port]; ok {
			return v
		}
	}
	switch port {
	case uvActivation:
		return 1
	case uvHealth:
		return 100
	case uvInBuildStance, uvBusy, uvArmored:
		return 0
	default:
		return 0
	}
}

func (u *Unit) returnFromCall(t *thread, value int32) {
	n := len(t.callStack)
	if n == 0 {
		t.dead = true
		return
	}
	f := t.callStack[n-1]
	t.callStack = t.callStack[:n-1]
	t.scriptIndex = f.scriptIndex
	t.pc = f.pc
	t.locals = f.locals
	t.push(value)
}

func boolI(b bool) int32 {
	if b {
		return 1
	}
	return 0
}

func localAt(locals []int32, i int) int32 {
	if i < 0 || i >= len(locals) {
		return 0
	}
	return locals[i]
}

func staticAt(static []int32, i int) int32 {
	if i < 0 || i >= len(static) {
		return 0
	}
	return static[i]
}
