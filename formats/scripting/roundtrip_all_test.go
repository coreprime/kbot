package scripting_test

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/compiler"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
	"github.com/coreprime/kbot/testutil"
)

// TestAllCOBRoundtrip tests every .cob file from flat/scripts for byte-perfect roundtrip.
func TestAllCOBRoundtrip(t *testing.T) {
	cobDir := testutil.UnpackedDir(t, "scripts")

	entries, err := os.ReadDir(cobDir)
	if err != nil {
		t.Fatalf("Cannot read %s: %v", cobDir, err)
	}

	var cobFiles []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(strings.ToLower(e.Name()), ".cob") {
			cobFiles = append(cobFiles, filepath.Join(cobDir, e.Name()))
		}
	}
	sort.Strings(cobFiles)

	if len(cobFiles) == 0 {
		t.Fatal("No .cob files found")
	}
	t.Logf("Found %d .cob files", len(cobFiles))

	passed := 0
	failed := 0
	var failures []string

	for _, cobPath := range cobFiles {
		name := filepath.Base(cobPath)
		t.Run(name, func(t *testing.T) {
			result := roundtripOne(t, cobPath)
			if result == "" {
				passed++
			} else {
				failed++
				failures = append(failures, fmt.Sprintf("%-25s %s", name, result))
			}
		})
	}

	t.Logf("\n=== SUMMARY: %d/%d passed, %d failed ===", passed, len(cobFiles), failed)
	if len(failures) > 0 {
		t.Logf("Failures:")
		for _, f := range failures {
			t.Logf("  %s", f)
		}
	}
}

// roundtripOne does COB → BOS → COB and returns "" on success or an error description.
func roundtripOne(t *testing.T, cobPath string) string {
	t.Helper()

	// Phase 1: Load original
	origCOB, err := scripting.LoadFromFile(cobPath)
	if err != nil {
		t.Errorf("load failed: %v", err)
		return fmt.Sprintf("LOAD: %v", err)
	}

	// Save original through our writer to get canonical byte layout
	var origBuf bytes.Buffer
	if err := origCOB.WriteToWriter(&origBuf); err != nil {
		t.Errorf("save failed: %v", err)
		return fmt.Sprintf("SAVE: %v", err)
	}
	origBytes := origBuf.Bytes()

	// Phase 2: Decompile
	decomp := decompiler.NewDecompiler(origCOB)
	bos, err := decomp.Decompile()
	if err != nil {
		t.Errorf("decompile failed: %v", err)
		return fmt.Sprintf("DECOMPILE: %v", err)
	}

	// Phase 3: Recompile
	comp := compiler.NewCompiler(bos)
	recompCOB, err := comp.Compile()
	if err != nil {
		t.Errorf("compile failed: %v", err)
		return fmt.Sprintf("COMPILE: %v", err)
	}

	// Phase 4: Save recompiled
	var recompBuf bytes.Buffer
	if err := recompCOB.WriteToWriter(&recompBuf); err != nil {
		t.Errorf("recomp save failed: %v", err)
		return fmt.Sprintf("RECOMP_SAVE: %v", err)
	}
	recompBytes := recompBuf.Bytes()

	// Phase 5: Compare
	if bytes.Equal(origBytes, recompBytes) {
		return "" // success
	}

	// Find what differs
	sizeDiff := len(recompBytes) - len(origBytes)
	detail := fmt.Sprintf("SIZE: orig=%d recomp=%d diff=%+d", len(origBytes), len(recompBytes), sizeDiff)

	// Compare code sections
	if origCOB.NumScripts == recompCOB.NumScripts {
		for i := 0; i < int(origCOB.NumScripts); i++ {
			origInst, e1 := origCOB.Disassemble(i)
			recompInst, e2 := recompCOB.Disassemble(i)
			if e1 != nil || e2 != nil {
				continue
			}
			if len(origInst) != len(recompInst) {
				scriptName := "?"
				if i < len(origCOB.ScriptNames) {
					scriptName = origCOB.ScriptNames[i]
				}
				detail += fmt.Sprintf(" | script %s: %d→%d inst", scriptName, len(origInst), len(recompInst))
				continue
			}
			for j := 0; j < len(origInst) && j < len(recompInst); j++ {
				if origInst[j].Opcode != recompInst[j].Opcode ||
					origInst[j].Operand != recompInst[j].Operand ||
					origInst[j].Operand2 != recompInst[j].Operand2 {
					scriptName := "?"
					if i < len(origCOB.ScriptNames) {
						scriptName = origCOB.ScriptNames[i]
					}
					detail += fmt.Sprintf(" | script %s[%d]: %s(%d,%d)→%s(%d,%d)",
						scriptName, j,
						scripting.OpcodeName(origInst[j].Opcode), origInst[j].Operand, origInst[j].Operand2,
						scripting.OpcodeName(recompInst[j].Opcode), recompInst[j].Operand, recompInst[j].Operand2)
					break
				}
			}
		}
	}

	t.Errorf("MISMATCH: %s", detail)
	return detail
}
