package tntpreview

import (
	"github.com/coreprime/kbot-io/formats/gaf"
	"os"
	"path/filepath"
	"testing"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	"github.com/coreprime/kbot/internal/gamevfs"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// TestFeatureIndexKeepsFirstDefinition mirrors retail CarScar05: defined in
// features/urban/cars2.tdf and again in cars.tdf, stored in that order in
// the archive. The game takes the first definition, so the preview must
// draw from cars2.gaf, not the later cars.gaf.
func TestFeatureIndexKeepsFirstDefinition(t *testing.T) {
	dir := t.TempDir()
	w, err := hpiv1.CreateWriter(filepath.Join(dir, "rev31.gp3"))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range [][2]string{
		{"features/urban/cars2.tdf", "[CarScar05]\n{\nfilename=cars2;\nseqname=carscar05;\nfootprintx=2;\n}\n[NoSprite]\n{\ndescription=first;\n}\n"},
		{"features/urban/cars.tdf", "[CarScar05]\n{\nfilename=cars;\nseqname=carscar05;\n}\n[NoSprite]\n{\nfilename=late;\n}\n"},
	} {
		if err := w.AddFileFromBytes(f[0], []byte(f[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	// A loose definition beats every archive.
	if err := os.MkdirAll(filepath.Join(dir, "features", "misc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "features", "misc", "rocks.tdf"), []byte("[Rock1]\n{\nfilename=looserocks;\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	w, err = hpiv1.CreateWriter(filepath.Join(dir, "totala1.hpi"))
	if err != nil {
		t.Fatal(err)
	}
	_ = w.AddFileFromBytes("features/misc/rocks2.tdf", []byte("[Rock1]\n{\nfilename=archiverocks;\n}\n"))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	vfs, err := gamevfs.Open(dir, kbotctx.GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = vfs.Close() }()

	c := newFeatureSpriteCache(vfs, nil, gaf.VariantTA.DefaultRenderOptions())
	c.loadTDFIndex()
	if got := c.tdfIndex["carscar05"]; got.gafName != "cars2" || got.footprintX != 2 || got.footprintZ != 1 {
		t.Errorf("CarScar05 = %+v, want the cars2.tdf definition", got)
	}
	if got := c.tdfIndex["rock1"].gafName; got != "looserocks" {
		t.Errorf("Rock1 filename = %q, want the loose definition", got)
	}
	if got, ok := c.tdfIndex["nosprite"]; !ok || got.gafName != "" {
		t.Errorf("NoSprite = %+v, %v; the first definition (no filename) must win", got, ok)
	}
	if sp := c.sprite("NoSprite"); sp != nil {
		t.Errorf("a feature whose first definition has no filename has no sprite")
	}
}
