package studio

import (
	"bytes"
	"testing"

	"github.com/coreprime/kbot-io/formats/scripting"
	"github.com/coreprime/kbot-io/formats/scripting/assembly"
)

// The unit-editor debugger's ASM pane names each instruction the way the
// game runs it, including words with stray low bits.
func TestCobScriptNamesInstructionsAsTheGameRunsThem(t *testing.T) {
	cob, err := assembly.NewAssembler().Assemble(`.version 4
.script Create
0000  PUSH_CONST           10
0008  PUSH_CONST           4
0010  UNKNOWN_0x10037000
0014  NOT
0018  POP_STACK
001C  JUMP@0x10064001      32
0024  PUSH_CONST           0
002C  RETURN
`)
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	var buf bytes.Buffer
	if err := cob.WriteToWriter(&buf); err != nil {
		t.Fatal(err)
	}
	out, err := cobScriptFromBytes("TEST.cob", buf.Bytes(), false)
	if err != nil {
		t.Fatalf("cobScriptFromBytes: %v", err)
	}
	if out.Name != "test" || len(out.Scripts) != 1 {
		t.Fatalf("name %q, %d scripts", out.Name, len(out.Scripts))
	}
	names := map[uint32]string{}
	for _, ins := range out.Scripts[0].Instructions {
		names[ins.Op] = ins.Name
	}
	for op, want := range map[uint32]string{
		scripting.OP_XOR:  "XOR",
		scripting.OP_NOT:  "NOT",
		scripting.OP_JUMP: "JUMP@0x10064001",
	} {
		if names[op] != want {
			t.Errorf("opcode 0x%08X named %q, want %q (all: %v)", op, names[op], want, names)
		}
	}
}
