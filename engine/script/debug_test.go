package script

import (
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
)

// debugProg builds a four-instruction script that writes static[0] twice, with a
// natural park point in the middle: PUSH 5 / POP static0 / PUSH 9 / POP static0.
// Instruction index == byte Offset (the prog helper tags it), so breakpoints key
// on the instruction index.
func debugProg() *Program {
	return prog(twoPieces(), 1, ScriptSource{
		Name: "Go",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, 5),
			i1(scripting.OP_POP_STATIC, 0),
			i1(scripting.OP_PUSH_IMMEDIATE, 9),
			i1(scripting.OP_POP_STATIC, 0),
		},
	})
}

func TestStepThreadAdvancesOneInstruction(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(debugProg(), nil)
	u.Start("Go") // first thread is id 1, parked at pc 0 until run

	th := u.threadByID(1)
	if th == nil {
		t.Fatal("thread 1 not found")
	}

	u.StepThread(1) // PUSH 5
	if th.pc != 1 {
		t.Fatalf("after step 1: pc = %d, want 1", th.pc)
	}
	if u.static[0] != 0 {
		t.Fatalf("after step 1: static0 = %d, want 0 (POP not yet run)", u.static[0])
	}

	u.StepThread(1) // POP static0 = 5
	if u.static[0] != 5 {
		t.Fatalf("after step 2: static0 = %d, want 5", u.static[0])
	}
	if th.pc != 2 {
		t.Fatalf("after step 2: pc = %d, want 2", th.pc)
	}
}

func TestBreakpointParksThenResumes(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(debugProg(), nil)
	u.Start("Go")
	u.AddBreakpoint(0, 2) // park before the second PUSH

	rt.Tick(25) // runs until the breakpoint
	th := u.threadByID(1)
	if th == nil || !th.breakpointHit {
		t.Fatal("thread should be parked on the breakpoint")
	}
	if th.pc != 2 {
		t.Fatalf("parked pc = %d, want 2", th.pc)
	}
	if u.static[0] != 5 {
		t.Fatalf("at breakpoint: static0 = %d, want 5 (first POP ran)", u.static[0])
	}

	// Re-ticking while parked must not run past the breakpoint.
	rt.Tick(50)
	if u.static[0] != 5 {
		t.Fatalf("still parked: static0 = %d, want 5", u.static[0])
	}

	// Continue: clear the hit, arm resume, then a tick runs past the breakpoint.
	u.ClearBreakpointHits()
	if th.breakpointHit {
		t.Fatal("breakpointHit should be cleared after ClearBreakpointHits")
	}
	rt.Tick(75)
	if u.static[0] != 9 {
		t.Fatalf("after continue: static0 = %d, want 9", u.static[0])
	}
}

func TestCoverageStampsExecutedOffsets(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(debugProg(), nil)
	u.Start("Go")
	u.AddBreakpoint(0, 2)

	rt.Tick(25) // runs offsets 0 and 1, parks before 2
	cov := u.Coverage()
	got := map[uint32]bool{}
	for _, off := range cov[0] {
		got[off] = true
	}
	if !got[0] || !got[1] {
		t.Fatalf("coverage = %v, want offsets 0 and 1 executed", cov[0])
	}
	if got[2] {
		t.Fatal("offset 2 should not be marked executed while parked on its breakpoint")
	}
}

func TestSetThreadLocalStaticAndPC(t *testing.T) {
	// Script with one local so SetThreadLocal has a slot to write.
	p := prog(twoPieces(), 1, ScriptSource{
		Name: "Go",
		Insts: []Instruction{
			i1(scripting.OP_CREATE_LOCAL, 0),
			i1(scripting.OP_PUSH_IMMEDIATE, 1),
			i1(scripting.OP_POP_LOCAL_VAR, 0),
			i0(scripting.OP_RETURN),
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("Go")

	u.StepThread(1) // CREATE_LOCAL 0
	th := u.threadByID(1)
	if len(th.locals) == 0 {
		t.Fatal("expected a local slot after CREATE_LOCAL")
	}

	u.SetThreadLocal(1, 0, 42)
	if th.locals[0] != 42 {
		t.Fatalf("local0 = %d, want 42", th.locals[0])
	}

	u.SetStatic(0, 77)
	if u.static[0] != 77 {
		t.Fatalf("static0 = %d, want 77", u.static[0])
	}

	u.SetThreadPC(1, 3) // jump to RETURN
	if th.pc != 3 {
		t.Fatalf("pc = %d, want 3", th.pc)
	}
}
