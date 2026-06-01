package script

import (
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
)

// portProg reads one unit-value port into static[0]: PUSH <port> /
// GET_UNIT_VALUE / POP static0 / RETURN.
func portProg(port int32) *Program {
	return prog(twoPieces(), 1, ScriptSource{
		Name: "Go",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, port),
			i0(scripting.OP_GET_UNIT_VALUE),
			i1(scripting.OP_POP_STATIC, 0),
			i0(scripting.OP_RETURN),
		},
	})
}

func TestUnitValuePortDefault(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(portProg(uvHealth), nil) // HEALTH
	u.Start("Go")
	rt.Tick(25)
	if u.static[0] != 100 {
		t.Fatalf("default HEALTH read = %d, want 100", u.static[0])
	}
}

func TestUnitValuePortWriteIsRead(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(portProg(uvHealth), nil)
	u.SetUnitValuePort(uvHealth, 37)
	u.Start("Go")
	rt.Tick(25)
	if u.static[0] != 37 {
		t.Fatalf("HEALTH read after write = %d, want 37", u.static[0])
	}
	if got := u.UnitValuePort(uvHealth); got != 37 {
		t.Fatalf("UnitValuePort(HEALTH) = %d, want 37", got)
	}
}

// TestSetValueOpcodeWritesPort confirms a script's SET_VALUE lands in the
// writable store (no Host attached) and a later GET_UNIT_VALUE reads it back.
func TestSetValueOpcodeWritesPort(t *testing.T) {
	// PUSH port / PUSH value / SET_VALUE, then PUSH port / GET / POP static0.
	p := prog(twoPieces(), 1, ScriptSource{
		Name: "Go",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, uvInBuildStance),
			i1(scripting.OP_PUSH_IMMEDIATE, 1),
			i0(scripting.OP_SET_VALUE),
			i1(scripting.OP_PUSH_IMMEDIATE, uvInBuildStance),
			i0(scripting.OP_GET_UNIT_VALUE),
			i1(scripting.OP_POP_STATIC, 0),
			i0(scripting.OP_RETURN),
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("Go")
	rt.Tick(25)
	if u.static[0] != 1 {
		t.Fatalf("INBUILDSTANCE after SET_VALUE = %d, want 1", u.static[0])
	}
	if got := u.UnitValuePort(uvInBuildStance); got != 1 {
		t.Fatalf("UnitValuePort(INBUILDSTANCE) = %d, want 1", got)
	}
}

// TestResetStateClearsPorts confirms ResetState wipes port writes so a freshly
// reset unit reads TA defaults again.
func TestResetStateClearsPorts(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(portProg(uvHealth), nil)
	u.SetUnitValuePort(uvHealth, 5)
	u.ResetState()
	if got := u.UnitValuePort(uvHealth); got != 100 {
		t.Fatalf("HEALTH after reset = %d, want default 100", got)
	}
}
