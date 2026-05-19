package compiler

import (
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
)

func TestCompileTAKIntrinsicsRoundTrip(t *testing.T) {
	src := `.version 6
.sound_name "create NPCBEG"

piece base, turret;

Create()
{
	dont-shadow(base);
	Mission-Command("create NPCBEG", 42, 99);
	return;
}
`
	cob, err := NewCompiler(src).Compile()
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if cob.VersionSignature != 6 {
		t.Errorf("VersionSignature = %d, want 6", cob.VersionSignature)
	}
	if cob.NumScripts != 1 {
		t.Fatalf("NumScripts = %d, want 1", cob.NumScripts)
	}
	if len(cob.SoundNames) != 1 || cob.SoundNames[0] != "create NPCBEG" {
		t.Errorf("SoundNames = %v, want [\"create NPCBEG\"]", cob.SoundNames)
	}

	insts, err := cob.Disassemble(0)
	if err != nil {
		t.Fatalf("Disassemble(0): %v", err)
	}

	var sawDontShadow, sawMission bool
	for _, in := range insts {
		switch in.Opcode {
		case scripting.OP_DONT_SHADOW:
			sawDontShadow = true
			if in.Operand != 0 { // piece "base" has index 0
				t.Errorf("DONT_SHADOW operand = %d, want 0", in.Operand)
			}
		case scripting.OP_MISSION_COMMAND:
			sawMission = true
			// Operand[0]: sound-name index (0 here).
			// Operand[1]: stack argument count (2: 42 and 99).
			if in.Operand != 0 || in.Operand2 != 2 {
				t.Errorf("MISSION_COMMAND operands = (%d, %d), want (0, 2)", in.Operand, in.Operand2)
			}
		}
	}
	if !sawDontShadow {
		t.Error("compiled output is missing DONT_SHADOW")
	}
	if !sawMission {
		t.Error("compiled output is missing MISSION_COMMAND")
	}
}

func TestCompileTAKMathIntrinsicEmitsOpcode(t *testing.T) {
	// `__tak_math_09(<expr>)` should emit the inner expression's opcodes
	// followed by TAK_MATH_09 (stack-neutral), then the POP_LOCAL.
	src := `.version 6

Create()
{
	var x;
	x = __tak_math_09(3 * 2);
	return;
}
`
	cob, err := NewCompiler(src).Compile()
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	insts, err := cob.Disassemble(0)
	if err != nil {
		t.Fatalf("Disassemble(0): %v", err)
	}
	// Find the MUL → TAK_MATH_09 → POP_LOCAL sequence.
	for i := 0; i+2 < len(insts); i++ {
		if insts[i].Opcode == scripting.OP_MUL &&
			insts[i+1].Opcode == scripting.OP_TAK_MATH_09 &&
			insts[i+2].Opcode == scripting.OP_POP_LOCAL_VAR {
			return
		}
	}
	t.Fatalf("did not find MUL → TAK_MATH_09 → POP_LOCAL_VAR sequence; got %v", opcodeNames(insts))
}

func TestCompilePreservesSoundNames(t *testing.T) {
	src := `.version 6
.sound_name "ARROW10"
.sound_name "ARAPRIESDIE1"

Create()
{
	return;
}
`
	cob, err := NewCompiler(src).Compile()
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	want := []string{"ARROW10", "ARAPRIESDIE1"}
	if len(cob.SoundNames) != len(want) {
		t.Fatalf("SoundNames = %v, want %v", cob.SoundNames, want)
	}
	for i, s := range want {
		if cob.SoundNames[i] != s {
			t.Errorf("SoundNames[%d] = %q, want %q", i, cob.SoundNames[i], s)
		}
	}
	if cob.VersionSignature != 6 {
		t.Errorf("VersionSignature = %d, want 6", cob.VersionSignature)
	}
}

func opcodeNames(insts []scripting.Instruction) []string {
	out := make([]string, len(insts))
	for i, in := range insts {
		out[i] = scripting.OpcodeName(in.Opcode)
	}
	return out
}
