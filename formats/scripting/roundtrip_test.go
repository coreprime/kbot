package scripting_test

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/compiler"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
	"github.com/coreprime/kbot/internal/testutil"
)

// TestCOBDecompileRoundTrip tests the full decompile → compile → compare cycle
func TestCOBDecompileRoundTrip(t *testing.T) {
	testCases := []struct {
		name     string
		cobFile  string
	}{
		{
			name:    "armaap",
			cobFile: filepath.Join(testutil.UnpackedPath(t), "scripts", "armaap.cob"),
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Create output directory in temp.
			outputDir := filepath.Join(t.TempDir(), tc.name)
			_ = os.RemoveAll(outputDir) // Clean existing output
			if err := os.MkdirAll(outputDir, 0755); err != nil {
				t.Fatalf("Failed to create output directory: %v", err)
			}

			// =============================================================
			// PHASE 0: Load and save original COB
			// =============================================================
			t.Log("Phase 0: Loading original COB file...")
			originalCOB, err := scripting.LoadFromFile(tc.cobFile)
			if err != nil {
				t.Fatalf("Failed to load original COB: %v", err)
			}

			// Save 00_original.cob
			originalPath := filepath.Join(outputDir, "00_original.cob")
			if err := originalCOB.SaveToFile(originalPath); err != nil {
				t.Fatalf("Failed to save 00_original.cob: %v", err)
			}
			t.Logf("✓ Saved 00_original.cob (%d bytes)", getFileSize(originalPath))

			// =============================================================
			// PHASE 1: Save metadata
			// =============================================================
			t.Log("Phase 1: Extracting metadata...")
			metadataPath := filepath.Join(outputDir, "01_metadata.txt")
			metadata := generateMetadata(originalCOB)
			if err := os.WriteFile(metadataPath, []byte(metadata), 0644); err != nil {
				t.Fatalf("Failed to save 01_metadata.txt: %v", err)
			}
			t.Logf("✓ Saved 01_metadata.txt")

			// =============================================================
			// PHASE 2: Disassemble original
			// =============================================================
			t.Log("Phase 2: Disassembling original COB...")
			disassembledPath := filepath.Join(outputDir, "02_disassembled.coba")
			if err := runCobber("disassemble", originalPath, disassembledPath); err != nil {
				t.Fatalf("Failed to disassemble: %v", err)
			}
			t.Logf("✓ Saved 02_disassembled.coba (%d bytes)", getFileSize(disassembledPath))

			// =============================================================
			// PHASE 3: Decompile to BOS
			// =============================================================
			t.Log("Phase 3: Decompiling to BOS...")
			decomp := decompiler.NewDecompiler(originalCOB)
			decompiledBOS, err := decomp.Decompile()
			if err != nil {
				t.Fatalf("Decompilation failed: %v", err)
			}

			decompiledPath := filepath.Join(outputDir, "03_decompiled.bos")
			if err := os.WriteFile(decompiledPath, []byte(decompiledBOS), 0644); err != nil {
				t.Fatalf("Failed to save 03_decompiled.bos: %v", err)
			}
			t.Logf("✓ Saved 03_decompiled.bos (%d bytes)", len(decompiledBOS))

			// =============================================================
			// PHASE 4: Analyze decompiled output
			// =============================================================
			t.Log("Phase 4: Analyzing decompiled output...")
			analysisPath := filepath.Join(outputDir, "04_decomp_analysis.txt")
			analysis := analyzeDecompiledOutput(decompiledBOS, originalCOB)
			if err := os.WriteFile(analysisPath, analysis, 0644); err != nil {
				t.Fatalf("Failed to save 04_decomp_analysis.txt: %v", err)
			}
			t.Logf("✓ Saved 04_decomp_analysis.txt")

			// =============================================================
			// PHASE 5: Compile BOS back to COB
			// =============================================================
			t.Log("Phase 5: Recompiling BOS to COB...")
			comp := compiler.NewCompiler(decompiledBOS)
			recompiledCOB, err := comp.Compile()
			if err != nil {
				t.Fatalf("Compilation failed: %v", err)
			}

			recompiledPath := filepath.Join(outputDir, "05_recompiled.cob")
			if err := recompiledCOB.SaveToFile(recompiledPath); err != nil {
				t.Fatalf("Failed to save 05_recompiled.cob: %v", err)
			}
			t.Logf("✓ Saved 05_recompiled.cob (%d bytes)", getFileSize(recompiledPath))

			// =============================================================
			// PHASE 6: Disassemble recompiled
			// =============================================================
			t.Log("Phase 6: Disassembling recompiled COB...")
			recompiledDisasmPath := filepath.Join(outputDir, "06_recompiled.coba")
			if err := runCobber("disassemble", recompiledPath, recompiledDisasmPath); err != nil {
				t.Fatalf("Failed to disassemble recompiled: %v", err)
			}
			t.Logf("✓ Saved 06_recompiled.coba (%d bytes)", getFileSize(recompiledDisasmPath))

			// =============================================================
			// PHASE 7: Detailed bytecode comparison
			// =============================================================
			t.Log("Phase 7: Comparing bytecode...")
			
			originalBytes, _ := os.ReadFile(originalPath)
			recompiledBytes, _ := os.ReadFile(recompiledPath)

			diffPath := filepath.Join(outputDir, "07_bytecode_diff.txt")
			diff := generateDetailedDiff(originalCOB, recompiledCOB, originalBytes, recompiledBytes)
			if err := os.WriteFile(diffPath, []byte(diff), 0644); err != nil {
				t.Fatalf("Failed to save 07_bytecode_diff.txt: %v", err)
			}
			t.Logf("✓ Saved 07_bytecode_diff.txt")

			// =============================================================
			// SUMMARY
			// =============================================================
			if bytes.Equal(originalBytes, recompiledBytes) {
				t.Log("✅ PERFECT MATCH! Byte-for-byte identical!")
			} else {
				sizeDiff := len(recompiledBytes) - len(originalBytes)
				t.Logf("📊 Bytecode differs:")
				t.Logf("   Original:    %d bytes", len(originalBytes))
				t.Logf("   Recompiled:  %d bytes", len(recompiledBytes))
				t.Logf("   Difference:  %+d bytes (%.1f%%)", 
					sizeDiff, 
					float64(sizeDiff)/float64(len(originalBytes))*100)
			}
		})
	}
}

// generateMetadata creates a detailed metadata report
func generateMetadata(cob *scripting.COB) string {
	var buf bytes.Buffer
	
	fmt.Fprintf(&buf, "COB File Metadata\n")
	fmt.Fprintf(&buf, "=================\n\n")
	fmt.Fprintf(&buf, "Version:          %d\n", cob.VersionSignature)
	fmt.Fprintf(&buf, "Scripts:          %d\n", cob.NumScripts)
	fmt.Fprintf(&buf, "Pieces:           %d\n", cob.NumPieces)
	fmt.Fprintf(&buf, "Code size:        %d bytes\n", len(cob.Code))
	fmt.Fprintf(&buf, "LengthOfScripts:    %d\n", cob.LengthOfScripts)
	fmt.Fprintf(&buf, "NumberOfStaticVars: %d\n", cob.NumberOfStaticVars)
	fmt.Fprintf(&buf, "UKZero:             %d\n", cob.UKZero)
	fmt.Fprintf(&buf, "OffsetToNameArray:  %d\n\n", cob.OffsetToNameArray)
	
	fmt.Fprintf(&buf, "Script Names (%d):\n", len(cob.ScriptNames))
	for i, name := range cob.ScriptNames {
		fmt.Fprintf(&buf, "  [%2d] %s\n", i, name)
	}
	
	fmt.Fprintf(&buf, "\nPiece Names (%d):\n", len(cob.PieceNames))
	for i, name := range cob.PieceNames {
		fmt.Fprintf(&buf, "  [%2d] %s\n", i, name)
	}
	
	return buf.String()
}

// analyzeDecompiledOutput performs simple analysis
func analyzeDecompiledOutput(bos string, cob *scripting.COB) []byte {
	lines := strings.Split(bos, "\n")
	
	var buf bytes.Buffer
	fmt.Fprintf(&buf, "Decompiled BOS Analysis\n")
	fmt.Fprintf(&buf, "=======================\n\n")
	fmt.Fprintf(&buf, "Total lines:      %d\n", len(lines))
	fmt.Fprintf(&buf, "Original scripts: %d\n", cob.NumScripts)
	fmt.Fprintf(&buf, "Original pieces:  %d\n\n", cob.NumPieces)
	
	// Count functions
	funcCount := 0
	for _, line := range lines {
		if strings.Contains(line, "()") && strings.Contains(line, "{") {
			funcCount++
		}
	}
	fmt.Fprintf(&buf, "Functions found:  %d\n", funcCount)
	
	return buf.Bytes()
}

// generateDetailedDiff creates a comprehensive diff report
func generateDetailedDiff(origCOB, recompCOB *scripting.COB, origBytes, recompBytes []byte) string {
	var buf bytes.Buffer
	
	fmt.Fprintf(&buf, "Detailed Bytecode Comparison\n")
	fmt.Fprintf(&buf, "============================\n\n")
	
	// Header comparison
	fmt.Fprintf(&buf, "HEADER COMPARISON\n")
	fmt.Fprintf(&buf, "=================\n\n")
	fmt.Fprintf(&buf, "Field                    Original        Recompiled      Match\n")
	fmt.Fprintf(&buf, "----------------------   -------------   -------------   -----\n")
	
	compareField := func(name string, orig, recomp uint32) {
		match := "✓"
		if orig != recomp {
			match = "✗"
		}
		fmt.Fprintf(&buf, "%-24s %-15d %-15d %s\n", name, orig, recomp, match)
	}
	
	compareField("VersionSignature", origCOB.VersionSignature, recompCOB.VersionSignature)
	compareField("NumScripts", origCOB.NumScripts, recompCOB.NumScripts)
	compareField("NumPieces", origCOB.NumPieces, recompCOB.NumPieces)
	compareField("LengthOfScripts", origCOB.LengthOfScripts, recompCOB.LengthOfScripts)
	compareField("Code offset", origCOB.OffsetToScriptCode, recompCOB.OffsetToScriptCode)
	compareField("Code size", uint32(len(origCOB.Code)), uint32(len(recompCOB.Code)))
	
	fmt.Fprintf(&buf, "\n")
	
	// Script-by-script comparison
	fmt.Fprintf(&buf, "SCRIPT-BY-SCRIPT COMPARISON\n")
	fmt.Fprintf(&buf, "===========================\n\n")
	
	numScripts := int(origCOB.NumScripts)
	if int(recompCOB.NumScripts) < numScripts {
		numScripts = int(recompCOB.NumScripts)
	}
	
	for i := 0; i < numScripts; i++ {
		scriptName := "unknown"
		if i < len(origCOB.ScriptNames) && origCOB.ScriptNames[i] != "" {
			scriptName = origCOB.ScriptNames[i]
		}
		
		fmt.Fprintf(&buf, "Script %d: %s\n", i, scriptName)
		fmt.Fprintf(&buf, "%s\n", strings.Repeat("-", 60))
		
		// Disassemble both versions
		origInst, _ := origCOB.Disassemble(i)
		recompInst, _ := recompCOB.Disassemble(i)
		
		fmt.Fprintf(&buf, "Original:    %d instructions\n", len(origInst))
		fmt.Fprintf(&buf, "Recompiled:  %d instructions\n", len(recompInst))
		
		// Find first difference
		minLen := len(origInst)
		if len(recompInst) < minLen {
			minLen = len(recompInst)
		}
		
		firstDiff := -1
		for j := 0; j < minLen; j++ {
			if origInst[j].Opcode != recompInst[j].Opcode ||
			   origInst[j].Operand != recompInst[j].Operand ||
			   origInst[j].Operand2 != recompInst[j].Operand2 {
				firstDiff = j
				break
			}
		}
		
		if firstDiff >= 0 {
			fmt.Fprintf(&buf, "First diff:  Instruction %d\n\n", firstDiff)
			
			// Show context around diff
			start := firstDiff - 2
			if start < 0 {
				start = 0
			}
			end := firstDiff + 5
			if end > minLen {
				end = minLen
			}
			
			fmt.Fprintf(&buf, "Context (instructions %d-%d):\n", start, end-1)
			fmt.Fprintf(&buf, "  Orig  | Recomp | Opcode           Operand     Operand2\n")
			fmt.Fprintf(&buf, "  ------|--------|------------------------------------------\n")
			
			for j := start; j < end; j++ {
				marker := "  "
				if j == firstDiff {
					marker = "→ "
				}
				
				orig := origInst[j]
				recomp := recompInst[j]
				
				origOp := scripting.OpcodeName(orig.Opcode)
				recompOp := scripting.OpcodeName(recomp.Opcode)
				
				match := "✓"
				if orig.Opcode != recomp.Opcode || orig.Operand != recomp.Operand {
					match = "✗"
				}
				
				fmt.Fprintf(&buf, "%s[%3d]  | [%3d]  | %-16s %10d  %10d\n",
					marker, j, j, origOp, orig.Operand, orig.Operand2)
				
				if j == firstDiff && match == "✗" {
					fmt.Fprintf(&buf, "        |        | %-16s %10d  %10d ← recompiled\n",
						recompOp, recomp.Operand, recomp.Operand2)
				}
			}
		} else if len(origInst) == len(recompInst) {
			fmt.Fprintf(&buf, "✅ PERFECT MATCH!\n")
		} else {
			fmt.Fprintf(&buf, "Instruction count differs at position %d\n", minLen)
		}
		
		fmt.Fprintf(&buf, "\n")
	}
	
	// Overall size comparison
	fmt.Fprintf(&buf, "OVERALL SIZE COMPARISON\n")
	fmt.Fprintf(&buf, "=======================\n\n")
	fmt.Fprintf(&buf, "Original:    %d bytes\n", len(origBytes))
	fmt.Fprintf(&buf, "Recompiled:  %d bytes\n", len(recompBytes))
	fmt.Fprintf(&buf, "Difference:  %+d bytes\n", len(recompBytes)-len(origBytes))
	
	return buf.String()
}

// runCobber runs kbot cob <command> via the CLI
func runCobber(command, input, output string) error {
	kbotPath, err := filepath.Abs("../../bin/kbot")
	if err != nil {
		return err
	}

	cmd := exec.Command(kbotPath, "cob", command, input, "--target", output)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}

// getFileSize returns file size in bytes
func getFileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}
