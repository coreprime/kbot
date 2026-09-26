package mcp

import (
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/internal/gamevfs"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// TestFeatureRegistryFirstDefinition: the metal-proximity check reads each
// feature's first definition in game order, even when a later file gives
// the same name a different yield.
func TestFeatureRegistryFirstDefinition(t *testing.T) {
	dir := t.TempDir()
	writeMCPArchive(t, filepath.Join(dir, "rev31.gp3"), false,
		"features/b/rocks.tdf", "[Rock1]\n{\nmetal=5;\n}\n[Dry]\n{\nmetal=0;\n}\n",
		"features/a/rocks.tdf", "[Rock1]\n{\nmetal=50;\n}\n[Dry]\n{\nmetal=30;\n}\n",
	)
	vfs, err := gamevfs.Open(dir, kbotctx.GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vfs.Close() }()
	reg := tntScanFeatureRegistry(vfs)
	if reg["rock1"] != 5 {
		t.Errorf("rock1 metal = %d, want 5 from the first definition", reg["rock1"])
	}
	if _, ok := reg["dry"]; ok {
		t.Errorf("dry's first definition yields no metal: %v", reg)
	}
}
