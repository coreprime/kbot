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

// takAimProg mimics a TA:K v6 AimWeapon body: it echoes the weapon index it
// received (local 2) into the WEAPON_READY port via SET_VALUE.
func takAimProg() *Program {
	return prog(twoPieces(), 0, ScriptSource{
		Name: "AimWeapon",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, UVWeaponReady),
			i1(scripting.OP_PUSH_LOCAL_VAR, 2),
			i0(scripting.OP_SET_VALUE),
			i0(scripting.OP_RETURN),
		},
	})
}

// TestTAKWeaponReadyHandshake drives the TA:K aim handshake end to end: the
// script writes its weapon index into WEAPON_READY, TakeWeaponReady reports it
// once for that index only, and the flag clears on consumption.
func TestTAKWeaponReadyHandshake(t *testing.T) {
	rt := NewRuntime(1)
	u := rt.NewUnit(takAimProg(), nil)
	u.StartAim("AimWeapon", 100, 50, 1)
	rt.Tick(25)
	if u.TakeWeaponReady(0) {
		t.Fatal("weapon 0 reported ready; script signalled weapon 1")
	}
	if !u.TakeWeaponReady(1) {
		t.Fatal("weapon 1 never reported ready after the script's port write")
	}
	if u.TakeWeaponReady(1) {
		t.Fatal("WEAPON_READY did not clear on consumption")
	}
}

// TestTAKAimAbortedHandshake covers the abort side of the handshake
// (TargetCleared writing WEAPON_AIM_ABORTED), including ResetState clearing
// any pending flag.
func TestTAKAimAbortedHandshake(t *testing.T) {
	p := prog(twoPieces(), 0, ScriptSource{
		Name: "TargetCleared",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, UVWeaponAimAborted),
			i1(scripting.OP_PUSH_LOCAL_VAR, 0),
			i0(scripting.OP_SET_VALUE),
			i0(scripting.OP_RETURN),
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("TargetCleared", 2)
	rt.Tick(25)
	if !u.TakeWeaponAimAborted(2) {
		t.Fatal("weapon 2 abort never reported after the script's port write")
	}
	u.Start("TargetCleared", 2)
	rt.Tick(25)
	u.ResetState()
	if u.TakeWeaponAimAborted(2) {
		t.Fatal("ResetState left a pending WEAPON_AIM_ABORTED flag")
	}
}

// TestMissionCommandStackBalance proves MISSION_COMMAND consumes its declared
// arguments and pushes a neutral result, so an enclosing assignment still pops
// a value: PUSH 7 / PUSH 9 / MISSION_COMMAND(idx=0, argc=2) / POP static0.
func TestMissionCommandStackBalance(t *testing.T) {
	p := prog(twoPieces(), 1, ScriptSource{
		Name: "Go",
		Insts: []Instruction{
			i1(scripting.OP_PUSH_IMMEDIATE, 7),
			i1(scripting.OP_PUSH_IMMEDIATE, 9),
			i2(scripting.OP_MISSION_COMMAND, 0, 2),
			i1(scripting.OP_POP_STATIC, 0),
			i1(scripting.OP_PUSH_IMMEDIATE, 5),
			i1(scripting.OP_POP_STATIC, 0),
			i0(scripting.OP_RETURN),
		},
	})
	rt := NewRuntime(1)
	u := rt.NewUnit(p, nil)
	u.Start("Go")
	rt.Tick(25)
	// The final POP must see the PUSH 5, not a leftover MISSION_COMMAND arg:
	// static0 ends at 5 only if the opcode left the stack balanced.
	if u.static[0] != 5 {
		t.Fatalf("static0 = %d, want 5 (MISSION_COMMAND unbalanced the stack)", u.static[0])
	}
}
