package assetrender

import (
	"path/filepath"
	"testing"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	"github.com/coreprime/kbot/internal/gamevfs"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// TestLookupFeatureTDFFirstDefinition: a feature defined twice resolves to
// its first definition in game enumeration order (retail CarScar05: cars2
// before cars in stored order).
func TestLookupFeatureTDFFirstDefinition(t *testing.T) {
	dir := t.TempDir()
	w, err := hpiv1.CreateWriter(filepath.Join(dir, "rev31.gp3"))
	if err != nil {
		t.Fatal(err)
	}
	_ = w.AddFileFromBytes("features/urban/cars2.tdf", []byte("[CarScar05]\n{\nfilename=cars2;\nseqname=carscar05;\n}\n"))
	_ = w.AddFileFromBytes("features/urban/cars.tdf", []byte("[CarScar05]\n{\nfilename=cars;\nseqname=carscar05;\n}\n"))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	vfs, err := gamevfs.Open(dir, kbotctx.GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vfs.Close() }()
	r := New(vfs, Options{})
	if _, _, filename, _ := r.lookupFeatureTDF("carscar05"); filename != "cars2" {
		t.Errorf("CarScar05 filename = %q, want cars2", filename)
	}
}
