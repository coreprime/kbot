package cob

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/scripting"
	"github.com/coreprime/kbot-io/formats/scripting/assembly"
	"github.com/coreprime/kbot-io/formats/scripting/linter"
)

// kingdomsListing assembles to a COB whose Create script plays a sound: a TA:
// Kingdoms instruction TA 3.1c has no handler for.
func kingdomsListing(version int) string {
	return ".version " + strconv.Itoa(version) + `
.script Create
0000  PUSH_CONST           3
0008  PLAY_SOUND           100
0010  POP_STACK
0014  PUSH_CONST           0
001C  RETURN
`
}

func assembleCOB(t *testing.T, listing string) []byte {
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

// runCommand executes cmd with args and returns its stderr and error.
func runCommand(t *testing.T, cmd *cobra.Command, args ...string) (string, error) {
	t.Helper()
	var stderr bytes.Buffer
	cmd.SetErr(&stderr)
	cmd.SetOut(io.Discard)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return stderr.String(), err
}

func writeFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCobLintRulesCoverDefaultRules(t *testing.T) {
	listed := map[string]bool{}
	for _, r := range cobLintRules {
		if listed[r.name] {
			t.Errorf("rule %s listed twice", r.name)
		}
		listed[r.name] = true
	}
	for _, r := range linter.DefaultRules() {
		if !listed[r.Name()] {
			t.Errorf("linter rule %s is missing from the help text and SARIF catalogue", r.Name())
		}
		delete(listed, r.Name())
	}
	for name := range listed {
		t.Errorf("rule %s is listed but the linter does not run it", name)
	}
	if got, want := len(cobLintRuleCatalogue()), len(cobLintRules); got != want {
		t.Errorf("SARIF catalogue has %d rules, want %d", got, want)
	}
	help := newCobLintCommand().Long
	for _, name := range []string{"ta-kingdoms-opcode", "ta-get-arguments", "malformed-cob"} {
		if !strings.Contains(help, name) {
			t.Errorf("help text lacks %s", name)
		}
	}
}

func TestLintCOBBytesChecksTACompatibility(t *testing.T) {
	has := func(diags []linter.Diagnostic, rule string) bool {
		for _, d := range diags {
			if d.Rule == rule && d.Severity == linter.Error {
				return true
			}
		}
		return false
	}
	if diags := lintCOBBytes(linter.New(), assembleCOB(t, kingdomsListing(4))); !has(diags, "ta-kingdoms-opcode") {
		t.Errorf("version-4 COB with PLAY_SOUND: diagnostics %v lack a ta-kingdoms-opcode error", diags)
	}
	if diags := lintCOBBytes(linter.New(), assembleCOB(t, kingdomsListing(6))); has(diags, "ta-kingdoms-opcode") {
		t.Errorf("version-6 COB is a TA: Kingdoms script and must not get TA errors: %v", diags)
	}
	diags := lintCOBBytes(linter.New(), []byte("not a cob"))
	if len(diags) != 1 || diags[0].Rule != "malformed-cob" || diags[0].Severity != linter.Error {
		t.Errorf("unloadable file: diagnostics = %v, want one malformed-cob error", diags)
	}
}

func TestCobLintSARIFReportsTACompatibility(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "unit.cob"), assembleCOB(t, kingdomsListing(4)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.cob"), []byte{1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = w
	lintErr := lintPath(dir, true, false, true)
	os.Stdout = stdout
	_ = w.Close()
	out, _ := io.ReadAll(r)

	if lintErr == nil {
		t.Error("lint with TA compatibility errors returned no error")
	}
	var doc struct {
		Runs []struct {
			Tool struct {
				Driver struct {
					Rules []struct {
						ID string `json:"id"`
					} `json:"rules"`
				} `json:"driver"`
			} `json:"tool"`
			Results []struct {
				RuleID string `json:"ruleId"`
				Level  string `json:"level"`
			} `json:"results"`
		} `json:"runs"`
	}
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("SARIF output is not JSON: %v\n%s", err, out)
	}
	if len(doc.Runs) != 1 {
		t.Fatalf("SARIF runs = %d", len(doc.Runs))
	}
	rules := map[string]bool{}
	for _, r := range doc.Runs[0].Tool.Driver.Rules {
		rules[r.ID] = true
	}
	results := map[string]string{}
	for _, res := range doc.Runs[0].Results {
		results[res.RuleID] = res.Level
		if !rules[res.RuleID] {
			t.Errorf("result rule %s is not in the SARIF rule catalogue", res.RuleID)
		}
	}
	for _, id := range []string{"cob.ta-kingdoms-opcode", "cob.malformed-cob"} {
		if results[id] != "error" {
			t.Errorf("SARIF result %s level = %q, want error (results %v)", id, results[id], results)
		}
	}
}

func TestCobCompileRejectsAndWarns(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out.cob")

	// TA has no modulo instruction; % must not compile into its XOR.
	src := writeFile(t, dir, "mod.bos", "Create()\n{\n\tvar x;\n\tx = 10 % 4;\n}\n")
	if _, err := runCommand(t, newCobCompileCommand(), src, "--target", out); err == nil {
		t.Error("% in a TA script compiled")
	}

	// TA: Kingdoms instructions need .version 6.
	src = writeFile(t, dir, "sound.bos", "Create()\n{\n\tplay-sound(3, 100);\n}\n")
	if _, err := runCommand(t, newCobCompileCommand(), src, "--target", out); err == nil {
		t.Error("play-sound in a TA script compiled")
	}
	src = writeFile(t, dir, "sound6.bos", ".version 6\nCreate()\n{\n\tplay-sound(3, 100);\n}\n")
	if stderr, err := runCommand(t, newCobCompileCommand(), src, "--target", out, "--strict"); err != nil {
		t.Errorf("play-sound under .version 6: %v\n%s", err, stderr)
	}

	// A duplicate function compiles with a warning; --strict fails on it.
	src = writeFile(t, dir, "dup.bos",
		"Helper()\n{\n\treturn 1;\n}\nHelper()\n{\n\treturn 2;\n}\nCreate()\n{\n\tcall-script Helper();\n}\n")
	stderr, err := runCommand(t, newCobCompileCommand(), src, "--target", out)
	if err != nil {
		t.Fatalf("duplicate function: %v", err)
	}
	if !strings.Contains(stderr, "warning: ") || !strings.Contains(stderr, "Helper") {
		t.Errorf("duplicate function: stderr lacks the warning:\n%s", stderr)
	}
	if _, err := os.Stat(out); err != nil {
		t.Errorf("duplicate function: no output written: %v", err)
	}
	if _, err := runCommand(t, newCobCompileCommand(), src, "--target", out, "--strict"); err == nil {
		t.Error("--strict did not fail on a warning")
	}
}

func TestCobAssembleWarnsOnKingdomsInstructions(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out.cob")
	listing := writeFile(t, dir, "ta.coba", kingdomsListing(4))
	stderr, err := runCommand(t, newCobAssembleCommand(), listing, "--target", out)
	if err != nil {
		t.Fatalf("assemble: %v", err)
	}
	if !strings.Contains(stderr, "warning: ") || !strings.Contains(stderr, "ta-kingdoms-opcode") {
		t.Errorf("stderr lacks the TA compatibility warning:\n%s", stderr)
	}
	if _, err := runCommand(t, newCobAssembleCommand(), listing, "--target", out, "--strict"); err == nil {
		t.Error("--strict did not fail on a TA compatibility warning")
	}

	listing = writeFile(t, dir, "tak.coba", kingdomsListing(6))
	stderr, err = runCommand(t, newCobAssembleCommand(), listing, "--target", out, "--strict")
	if err != nil || strings.Contains(stderr, "warning: ") {
		t.Errorf("version-6 listing: err=%v stderr=%q", err, stderr)
	}
	data, _ := os.ReadFile(out)
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil || cob.VersionSignature != 6 {
		t.Errorf("version-6 output: %v (version %v)", err, cob)
	}
}
