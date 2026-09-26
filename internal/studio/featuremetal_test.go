package studio

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
)

// TestFeatureMetalAsTheGameStores checks the studio's feature drawer (and
// the Quality Checker's metal registry built from it) and the pack read a
// feature's metal the way the game stores it: a whole number kept to 16
// bits, the first definition of a name winning.
func TestFeatureMetalAsTheGameStores(t *testing.T) {
	root := t.TempDir()
	write := func(rel, body string) {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("features/corpses/arm.tdf", "[armfrt_dead]\n{\nworld=all worlds;\nmetal=56.8;\nenergy=12.9;\n}\n")
	write("features/rocks/big.tdf", "[BigRock]\n{\nmetal=70000;\nindestructible=1;\n}\n")
	write("features/rocks/dup.tdf", "[ARMFRT_DEAD]\n{\nmetal=9;\n}\n")
	vfs, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	sess := newSession("test", "test", vfs, t.TempDir())

	_, byName := sess.scanFeatures()
	if got := byName["armfrt_dead"].Metal; got != 56 {
		t.Errorf("drawer metal for armfrt_dead = %d, want 56", got)
	}
	if got := byName["bigrock"].Metal; got != 4464 {
		t.Errorf("drawer metal for BigRock = %d, want 4464 (70000 kept to 16 bits)", got)
	}
	in := sess.buildMaplintInput(nil, saveRequest{}, nil)
	if in.FeatureRegistry["armfrt_dead"] != 56 {
		t.Errorf("quality registry = %v, want armfrt_dead 56", in.FeatureRegistry)
	}

	catalog, _ := sess.buildPackFeatureCatalog()
	if f := catalog["armfrt_dead"]; f.Metal != 56 || f.Energy != 12 {
		t.Errorf("pack armfrt_dead metal/energy = %v/%v, want 56/12", f.Metal, f.Energy)
	}
}
