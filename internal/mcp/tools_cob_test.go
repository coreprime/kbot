package mcp

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot-io/formats/scripting/assembly"
)

// TestRunCobLintChecksTACompatibility pins the cob_lint tool to the TA 3.1c
// compatibility rules: a version-4 COB with a TA: Kingdoms instruction is an
// error, and a file the reader rejects is reported as malformed-cob.
func TestRunCobLintChecksTACompatibility(t *testing.T) {
	cob, err := assembly.NewAssembler().Assemble(`.version 4
.script Create
0000  PUSH_CONST           3
0008  PLAY_SOUND           100
0010  POP_STACK
0014  PUSH_CONST           0
001C  RETURN
`)
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	var buf bytes.Buffer
	if err := cob.WriteToWriter(&buf); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	good := filepath.Join(dir, "unit.cob")
	bad := filepath.Join(dir, "broken.cob")
	if err := os.WriteFile(good, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bad, []byte{4, 0, 0}, 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := runCobLint(map[string]string{"unit.cob": good, "broken.cob": bad})
	if err != nil || res == nil || res.IsError {
		t.Fatalf("runCobLint: %v %s", err, textOf(res))
	}
	var out lintOutput
	if err := json.Unmarshal([]byte(textOf(res)), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.HasErrors {
		t.Error("has_errors = false")
	}
	found := map[string]string{}
	for _, d := range out.Diagnostics {
		found[d.File+" "+d.Rule] = d.Severity
	}
	if found["unit.cob ta-kingdoms-opcode"] != "error" {
		t.Errorf("unit.cob lacks a ta-kingdoms-opcode error: %v", found)
	}
	if found["broken.cob malformed-cob"] != "error" {
		t.Errorf("broken.cob lacks a malformed-cob error: %v", found)
	}
}
