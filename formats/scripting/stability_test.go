package scripting_test

import (
	"bytes"
	"os"
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
	"github.com/coreprime/kbot/testutil"
)

func TestDecompilerStability(t *testing.T) {
	files := []string{
		"cormstor.cob", "armanni.cob", "armaap.cob",
		"armavp.cob", "armbats.cob", "armcom.cob",
		"armaas.cob", "armack.cob", "corwin.cob",
	}

	for _, f := range files {
		t.Run(f, func(t *testing.T) {
			path := testutil.UnpackedFile(t, "scripts", f)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}

			cob, err := scripting.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				t.Fatalf("load: %v", err)
			}

			dec := decompiler.NewDecompiler(cob)
			output, err := dec.Decompile()
			if err != nil {
				t.Fatalf("decompile: %v", err)
			}

			if len(output) == 0 {
				t.Fatal("empty output")
			}
		})
	}
}

func TestDecompilerOutputQuality(t *testing.T) {
	files := []string{
		"cormstor.cob", "armanni.cob", "armaap.cob",
		"armavp.cob", "armbats.cob", "armcom.cob",
	}

	for _, f := range files {
		t.Run(f, func(t *testing.T) {
			path := testutil.UnpackedFile(t, "scripts", f)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read: %v", err)
			}

			cob, err := scripting.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				t.Fatalf("load: %v", err)
			}

			dec := decompiler.NewDecompiler(cob)
			output, err := dec.Decompile()
			if err != nil {
				t.Fatalf("decompile: %v", err)
			}

			if len(output) == 0 {
				t.Fatal("empty output")
			}
		})
	}
}
