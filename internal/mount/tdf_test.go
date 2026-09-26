package mount

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
)

// `kbot mount` describe shows a TDF as the game reads it, with its
// diagnostics.
func TestDescribeTDFUsesTheGameGrammar(t *testing.T) {
	root := t.TempDir()
	text := "[UNITINFO]\n{\n\tUnitName=CORPLAS;\n\tName=Immolator; //c\n\tMaxDamage=842;  /* was 710 */\n\tName=Again;\n}\n"
	if err := os.WriteFile(filepath.Join(root, "corplas.fbi"), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	v, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = v.Close() }()
	prev := vfs
	vfs = v
	defer func() { vfs = prev }()

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := os.Stdout
	os.Stdout = w
	describeTDF("corplas.fbi")
	os.Stdout = stdout
	_ = w.Close()
	outBytes, _ := io.ReadAll(r)
	out := string(outBytes)

	for _, want := range []string{"MaxDamage = 842\n", "Hit Points: 842", "How the game reads unusual text"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "//c") || strings.Contains(out, "was 710") {
		t.Errorf("comment text shown as a value:\n%s", out)
	}
}
