package assetrender

import (
	"bytes"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/formats/scripting/assembly"
)

func assembleForTest(t *testing.T, listing string) []byte {
	t.Helper()
	cob, err := assembly.NewAssembler().Assemble(listing)
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	var buf bytes.Buffer
	if err := cob.WriteToWriter(&buf); err != nil {
		t.Fatalf("write: %v", err)
	}
	return buf.Bytes()
}

func lintRules(t *testing.T, out map[string]any) map[string]string {
	t.Helper()
	diags, ok := out["lintResults"].([]lintDiag)
	if !ok {
		t.Fatalf("lintResults missing or of type %T", out["lintResults"])
	}
	rules := map[string]string{}
	for _, d := range diags {
		rules[d.Rule] = d.Severity
	}
	return rules
}

// The asset explorer names opcodes the way the game runs them:
// 0x10037000 is XOR, 0x10038000 the unary NOT and 0x10059000 a second XOR.
func TestDescribeCOBUsesTheGameOpcodeNames(t *testing.T) {
	data := assembleForTest(t, `.version 4
.script Create
0000  PUSH_CONST           10
0008  PUSH_CONST           4
0010  UNKNOWN_0x10037000
0014  NOT
0018  PUSH_CONST           1
0020  XOR_ALT
0024  RETURN
`)
	out, ok := newTestRenderer(t).Describe("scripts/test.cob", data)
	if !ok || out["format"] != "COB" {
		t.Fatalf("Describe: ok=%v format=%v", ok, out["format"])
	}
	disasm, _ := out["disassembly"].(string)
	for _, want := range []string{"XOR", "NOT", "XOR_ALT"} {
		if !strings.Contains(disasm, want) {
			t.Errorf("disassembly lacks %s:\n%s", want, disasm)
		}
	}
	for _, stale := range []string{"MOD", "BITWISE_XOR", "BITWISE_NOT", "LOGICAL_XOR"} {
		if strings.Contains(disasm, stale) {
			t.Errorf("disassembly still uses %s:\n%s", stale, disasm)
		}
	}
}

func TestDescribeCOBLintsTACompatibility(t *testing.T) {
	data := assembleForTest(t, `.version 4
.script Create
0000  PUSH_CONST           3
0008  PLAY_SOUND           100
0010  POP_STACK
0014  PUSH_CONST           0
001C  RETURN
`)
	out, _ := newTestRenderer(t).Describe("scripts/test.cob", data)
	if sev := lintRules(t, out)["ta-kingdoms-opcode"]; sev != "error" {
		t.Errorf("ta-kingdoms-opcode severity = %q, want error", sev)
	}
}

func TestDescribeCOBReportsAFileThatDoesNotLoad(t *testing.T) {
	out, ok := newTestRenderer(t).Describe("scripts/broken.cob", []byte{0x04, 0, 0, 0, 0xff})
	if !ok || out["format"] != "COB" {
		t.Fatalf("Describe: ok=%v format=%v", ok, out["format"])
	}
	if sev := lintRules(t, out)["malformed-cob"]; sev != "error" {
		t.Errorf("malformed-cob severity = %q, want error", sev)
	}
}

func TestDescribeBOSShowsCompilerWarnings(t *testing.T) {
	src := "Helper()\n{\n\treturn 1;\n}\nHelper()\n{\n\treturn 2;\n}\nCreate()\n{\n\tcall-script Helper();\n}\n"
	out, _ := newTestRenderer(t).Describe("scripts/dup.bos", []byte(src))
	if sev := lintRules(t, out)["compiler"]; sev != "warning" {
		t.Errorf("compiler warning severity = %q, want warning (out %v)", sev, out["lintResults"])
	}

	out, _ = newTestRenderer(t).Describe("scripts/mod.bos", []byte("Create()\n{\n\tvar x;\n\tx = 10 % 4;\n}\n"))
	if msg, _ := out["lintError"].(string); !strings.Contains(msg, "compilation failed") {
		t.Errorf("%% in a TA script: lintError = %q, want a compilation failure", msg)
	}
}
