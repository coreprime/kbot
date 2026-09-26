package tnt

import (
	"path/filepath"
	"testing"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	"github.com/coreprime/kbot/internal/gamevfs"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// TestScanFeatureRegistryFirstDefinition: kbot tnt lint reads each
// feature's first definition in game order.
func TestScanFeatureRegistryFirstDefinition(t *testing.T) {
	dir := t.TempDir()
	w, err := hpiv1.CreateWriter(filepath.Join(dir, "rev31.gp3"))
	if err != nil {
		t.Fatal(err)
	}
	_ = w.AddFileFromBytes("features/b/rocks.tdf", []byte("[Rock1]\n{\nmetal=5;\n}\n"))
	_ = w.AddFileFromBytes("features/a/rocks.tdf", []byte("[Rock1]\n{\nmetal=50;\n}\n"))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	vfs, err := gamevfs.Open(dir, kbotctx.GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vfs.Close() }()
	if got := scanFeatureRegistry(vfs)["rock1"]; got != 5 {
		t.Errorf("rock1 metal = %d, want 5 from the first definition", got)
	}
}
