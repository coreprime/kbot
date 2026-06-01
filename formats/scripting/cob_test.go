package scripting

import (
	"bytes"
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

func TestLoadFromFile(t *testing.T) {
	path := testutil.UnpackedFile(t, "scripts", "armack.cob")

	cob, err := LoadFromFile(path)
	if err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	if cob.VersionSignature != 4 {
		t.Errorf("Expected version 4, got %d", cob.VersionSignature)
	}

	if cob.NumScripts == 0 {
		t.Error("Expected scripts > 0")
	}

	if cob.NumPieces == 0 {
		t.Error("Expected pieces > 0")
	}

	t.Logf("Loaded %s: %d scripts, %d pieces, %d code words",
		path, cob.NumScripts, cob.NumPieces, len(cob.Code))
}

func TestLoadFromFile_Disassemble(t *testing.T) {
	path := testutil.UnpackedFile(t, "scripts", "armaas.cob")

	cob, err := LoadFromFile(path)
	if err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	for i := 0; i < int(cob.NumScripts); i++ {
		instrs, err := cob.Disassemble(i)
		if err != nil {
			t.Errorf("Script %d (%s) disassemble failed: %v", i, cob.ScriptNames[i], err)
		}
		if len(instrs) == 0 {
			t.Errorf("Script %d (%s) has no instructions", i, cob.ScriptNames[i])
		}
	}
}

func TestCOBWriteRead(t *testing.T) {
	path := testutil.UnpackedFile(t, "scripts", "armack.cob")

	original, err := LoadFromFile(path)
	if err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	// Write to buffer and read back.
	var buf = new(bytes.Buffer)
	if err := original.WriteToWriter(buf); err != nil {
		t.Fatalf("WriteToWriter failed: %v", err)
	}

	reread, err := LoadFromReader(buf)
	if err != nil {
		t.Fatalf("LoadFromReader failed: %v", err)
	}

	if original.NumScripts != reread.NumScripts {
		t.Errorf("Script count mismatch: %d vs %d", original.NumScripts, reread.NumScripts)
	}
	if original.NumPieces != reread.NumPieces {
		t.Errorf("Piece count mismatch: %d vs %d", original.NumPieces, reread.NumPieces)
	}
}

func TestCOBWriteReadBytes(t *testing.T) {
	path := testutil.UnpackedFile(t, "scripts", "armack.cob")

	original, err := LoadFromFile(path)
	if err != nil {
		t.Fatalf("LoadFromFile failed: %v", err)
	}

	var buf = new(bytes.Buffer)
	if err := original.WriteToWriter(buf); err != nil {
		t.Fatalf("WriteToWriter failed: %v", err)
	}

	reread, err := LoadFromReader(buf)
	if err != nil {
		t.Fatalf("LoadFromReader failed: %v", err)
	}

	if len(original.Code) != len(reread.Code) {
		t.Fatalf("Code length mismatch: %d vs %d", len(original.Code), len(reread.Code))
	}

	for i := range original.Code {
		if original.Code[i] != reread.Code[i] {
			t.Errorf("Code[%d] mismatch: 0x%08X vs 0x%08X", i, original.Code[i], reread.Code[i])
		}
	}
}
