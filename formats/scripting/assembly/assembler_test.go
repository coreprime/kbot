package assembly

import (
	"testing"
)

func TestAssemblerDirectives(t *testing.T) {
	input := `.version 4
.statics 4
.piece base
.piece turret

.script Create
0000  PUSH_CONST           0
0008  RETURN
`
	asm := NewAssembler()
	cob, err := asm.Assemble(input)
	if err != nil {
		t.Fatalf("Assemble: %v", err)
	}
	if cob.VersionSignature != 4 {
		t.Errorf("Version = %d, want 4", cob.VersionSignature)
	}
	if cob.Unknown1 != 4 {
		t.Errorf("Unknown1 (statics) = %d, want 4", cob.Unknown1)
	}
	if len(cob.PieceNames) != 2 {
		t.Errorf("PieceNames = %v, want [base turret]", cob.PieceNames)
	}
	if cob.NumScripts != 1 {
		t.Errorf("NumScripts = %d, want 1", cob.NumScripts)
	}
	if len(cob.ScriptNames) != 1 || cob.ScriptNames[0] != "Create" {
		t.Errorf("ScriptNames = %v, want [Create]", cob.ScriptNames)
	}
}

func TestAssemblerNoScripts(t *testing.T) {
	_, err := NewAssembler().Assemble(".version 4\n")
	if err == nil {
		t.Fatal("expected error for listing with no scripts")
	}
}
