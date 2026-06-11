package script

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/formats/scripting"
)

// TestProgramCarriesTAKSoundTable proves a retail TA:K v6 COB's sound-name
// table survives compilation so PLAY_SOUND effects resolve to .wav stems
// (death cries, ability stingers).
func TestProgramCarriesTAKSoundTable(t *testing.T) {
	root := os.Getenv("TAK_UNPACKED_PATH")
	if root == "" {
		t.Skip("set TAK_UNPACKED_PATH")
	}
	data, err := os.ReadFile(filepath.Join(root, "scripts", "arapal.cob"))
	if err != nil {
		t.Skipf("retail cob: %v", err)
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(cob.SoundNames) == 0 {
		t.Fatal("arapal.cob carries no sound table — v6 parse regressed")
	}
	prog, err := FromCOB(cob)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	for i, want := range cob.SoundNames {
		if got := prog.SoundName(i); got != want {
			t.Fatalf("SoundName(%d) = %q, want %q", i, got, want)
		}
	}
	if prog.SoundName(-1) != "" || prog.SoundName(len(cob.SoundNames)) != "" {
		t.Fatal("out-of-range sound index must resolve to empty")
	}
	t.Logf("sound table (%d): %v", len(cob.SoundNames), cob.SoundNames)
}
