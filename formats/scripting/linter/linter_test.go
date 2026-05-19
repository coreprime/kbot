package linter

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/testutil"
)

func TestLintRealCOB(t *testing.T) {
	cobDir := testutil.UnpackedDir(t, "scripts")
	entries, err := os.ReadDir(cobDir)
	if err != nil {
		t.Skipf("scripts not available: %v", err)
	}

	if len(entries) == 0 {
		t.Skip("no COB files found")
	}

	l := New()
	linted := 0

	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".cob" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(cobDir, e.Name()))
		if err != nil {
			continue
		}
		cob, err := scripting.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			continue
		}

		diags := l.Lint(cob)
		_ = diags // Just ensure no panics
		linted++

		if linted >= 20 {
			break
		}
	}

	if linted == 0 {
		t.Skip("no COB files could be loaded")
	}

	t.Logf("Linted %d COB files without errors", linted)
}

func TestInvalidCallRule(t *testing.T) {
	// Build a minimal COB with a CALL_SCRIPT to a non-existent index.
	cob := &scripting.COB{
		VersionSignature: 4,
		NumScripts:       2,
		NumPieces:        1,
		ScriptNames:      []string{"Create", "Helper"},
		PieceNames:       []string{"base"},
		ScriptCodeIndices: []uint32{0, 5},
		NumberOfStaticVars: 0,
	}

	// Script 0 (Create): CALL_SCRIPT 5 (out of range), RETURN
	// Script 1 (Helper): RETURN
	cob.Code = buildCode([]uint32{
		scripting.OP_CALL_SCRIPT, 5, 0, // call script index 5 (doesn't exist)
		scripting.OP_RETURN,
		0, // padding
		scripting.OP_RETURN,
	})

	l := New()
	diags := l.Lint(cob)

	// Should NOT panic; the invalid index is handled gracefully.
	_ = diags
}

func buildCode(words []uint32) []byte {
	var buf bytes.Buffer
	for _, w := range words {
		b := make([]byte, 4)
		b[0] = byte(w)
		b[1] = byte(w >> 8)
		b[2] = byte(w >> 16)
		b[3] = byte(w >> 24)
		buf.Write(b)
	}
	return buf.Bytes()
}
