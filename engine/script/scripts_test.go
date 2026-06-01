package script

import (
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
)

// idleProg defines two named entry points that each spin forever so a started
// thread stays live for inspection: a body (SLEEP/JUMP back) for "Go" and
// "Other".
func idleProg() *Program {
	loop := func(name string) ScriptSource {
		return ScriptSource{
			Name: name,
			Insts: []Instruction{
				{Op: scripting.OP_PUSH_IMMEDIATE, P1: 100, Offset: 0},
				{Op: scripting.OP_SLEEP, Offset: 4},
				{Op: scripting.OP_JUMP, P1: 0, Offset: 8},
			},
		}
	}
	return prog(twoPieces(), 1, loop("Go"), loop("Other"))
}

// TestScriptNames lists the program's entry points in index order.
func TestScriptNames(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(idleProg(), nil)
	got := u.ScriptNames()
	if len(got) != 2 || got[0] != "Go" || got[1] != "Other" {
		t.Fatalf("ScriptNames = %v, want [Go Other]", got)
	}
}

// TestStartScriptSpawnsThread confirms Start spawns a live thread on a named
// entry point and KillThreadsByName retracts it.
func TestStartScriptSpawnsThread(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(idleProg(), nil)
	u.Start("Go")
	rt.Tick(25)
	if n := u.countScript("Go"); n != 1 {
		t.Fatalf("after Start, live Go threads = %d, want 1", n)
	}
	u.KillThreadsByName("Go")
	if n := u.countScript("Go"); n != 0 {
		t.Fatalf("after KillThreadsByName, live Go threads = %d, want 0", n)
	}
}

// TestRestartSupersedes confirms Restart cancels a live instance rather than
// stacking a second thread on the same script.
func TestRestartSupersedes(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(idleProg(), nil)
	u.Start("Go")
	rt.Tick(25)
	u.Restart("Go")
	rt.Tick(25)
	if n := u.countScript("Go"); n != 1 {
		t.Fatalf("after Restart, live Go threads = %d, want 1", n)
	}
}

// TestKillThreadsByNameUnknown is a no-op for an unknown script name.
func TestKillThreadsByNameUnknown(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(idleProg(), nil)
	u.Start("Go")
	rt.Tick(25)
	u.KillThreadsByName("Missing")
	if n := u.countScript("Go"); n != 1 {
		t.Fatalf("unknown-name kill disturbed Go threads = %d, want 1", n)
	}
}
