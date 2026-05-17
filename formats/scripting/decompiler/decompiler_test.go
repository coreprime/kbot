package decompiler

import (
	"strings"
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/assembly"
	"github.com/coreprime/kbot/testutil"
)

func TestDecompiler_BasicOutput(t *testing.T) {
	path := testutil.UnpackedFile(t, "scripts", "cormstor.cob")
	cob, err := scripting.LoadFromFile(path)
	if err != nil {
		t.Fatalf("Failed to load COB: %v", err)
	}

	dec := NewDecompiler(cob)
	output, err := dec.Decompile()
	if err != nil {
		t.Fatalf("Decompile failed: %v", err)
	}

	if len(output) == 0 {
		t.Fatal("Decompile produced empty output")
	}

	if !strings.Contains(output, "piece ") {
		t.Error("Output missing piece declaration")
	}

	t.Logf("Decompiled output: %d bytes", len(output))
}

func TestDecompiler_Disassemble(t *testing.T) {
	path := testutil.UnpackedFile(t, "scripts", "corwin.cob")
	cob, err := scripting.LoadFromFile(path)
	if err != nil {
		t.Fatalf("Failed to load COB: %v", err)
	}

	dec := NewDecompiler(cob)
	output, err := dec.Disassemble(assembly.Plain)
	if err != nil {
		t.Fatalf("Disassemble failed: %v", err)
	}

	if len(output) == 0 {
		t.Fatal("Disassembly produced empty output")
	}

	if !strings.Contains(output, ".script") {
		t.Error("Disassembly missing .script directive")
	}
}

func TestDecompiler_RoundtripDecompile(t *testing.T) {
	path := testutil.UnpackedFile(t, "scripts", "cormstor.cob")
	origCOB, err := scripting.LoadFromFile(path)
	if err != nil {
		t.Fatalf("Failed to load COB: %v", err)
	}

	dec := NewDecompiler(origCOB)
	bosOutput, err := dec.Decompile()
	if err != nil {
		t.Fatalf("Decompile failed: %v", err)
	}

	if len(bosOutput) == 0 {
		t.Fatal("Empty decompiled output")
	}

	t.Logf("Decompiled %d bytes of BOS source", len(bosOutput))
}

func TestDecompiler_MultipleFiles(t *testing.T) {
	files := []string{"cormstor.cob", "armack.cob", "armaas.cob"}

	for _, f := range files {
		t.Run(f, func(t *testing.T) {
			path := testutil.UnpackedFile(t, "scripts", f)
			cob, err := scripting.LoadFromFile(path)
			if err != nil {
				t.Fatalf("Failed to load %s: %v", f, err)
			}

			dec := NewDecompiler(cob)
			output, err := dec.Decompile()
			if err != nil {
				t.Fatalf("Decompile failed for %s: %v", f, err)
			}
			if len(output) == 0 {
				t.Errorf("Empty output for %s", f)
			}
		})
	}
}

func TestDecompiler_OutputQuality(t *testing.T) {
	files := []struct {
		filename string
		checks   []string
	}{
		{
			filename: "cormstor.cob",
			checks:   []string{"piece ", "Create()", "SmokeUnit()"},
		},
	}

	for _, tc := range files {
		t.Run(tc.filename, func(t *testing.T) {
			path := testutil.UnpackedFile(t, "scripts", tc.filename)
			cob, err := scripting.LoadFromFile(path)
			if err != nil {
				t.Fatalf("Failed to load: %v", err)
			}

			dec := NewDecompiler(cob)
			output, err := dec.Decompile()
			if err != nil {
				t.Fatalf("Decompile failed: %v", err)
			}

			for _, check := range tc.checks {
				if !strings.Contains(output, check) {
					t.Errorf("Output missing expected content: %q", check)
				}
			}
		})
	}
}
