package assetrender

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/tnt"
	"github.com/coreprime/kbot-io/palettes"
	"github.com/coreprime/kbot-io/testutil"
)

// writeTestMap saves a blank TA map of tileW×tileH tiles with a minimap
// built the game's way, plus the given .ota, as maps/test.{tnt,ota} under a
// new mounted root, and returns a renderer over it and the TNT bytes.
func writeTestMap(t *testing.T, tileW, tileH int, ota string) (*Renderer, []byte) {
	t.Helper()
	m := &tnt.Map{
		Header: tnt.Header{IDVersion: tnt.VersionTA},
		TileW:  tileW, TileH: tileH, AttrW: tileW * 2, AttrH: tileH * 2,
		TileMap:  make([]uint16, tileW*tileH),
		TileAttr: make([]tnt.TileAttr, tileW*tileH*4),
		Tiles:    [][]byte{bytes.Repeat([]byte{0x20}, tnt.TileGfxSize)},
	}
	for i := range m.TileAttr {
		m.TileAttr[i].Feature = tnt.FeatureNone
	}
	pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.BuildMinimap(pal.ColorModel()); err != nil {
		t.Fatalf("BuildMinimap: %v", err)
	}
	var buf bytes.Buffer
	if err := m.Save(&buf, nil); err != nil {
		t.Fatalf("Save: %v", err)
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "maps"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "maps", "test.tnt"), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "maps", "test.ota"), []byte(ota), 0o644); err != nil {
		t.Fatal(err)
	}
	vfs, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	return New(vfs, Options{CacheDir: t.TempDir()}), buf.Bytes()
}

// TestDescribeTNTStartMarkersUseMapRegion checks the asset explorer puts
// StartPos markers inside the minimap's map region, sized from the map
// (longer side 252, the visible map's aspect), not across the whole
// minimap, and takes them from the schema a multiplayer game uses.
func TestDescribeTNTStartMarkersUseMapRegion(t *testing.T) {
	// 64×32 tiles: the visible map is 2048-32 by 1024-128 = 2016×896 px,
	// so the region is 252×112 on the 252×252 minimap.
	ota := `[GlobalHeader]
{
	[Schema 0] { Type=Easy; [specials] { [special0] { specialwhat=StartPos1; XPos=1; ZPos=1; } } }
	[Schema 1]
	{
		Type=Network 1;
		[specials]
		{
			[special0] { specialwhat=StartPos2; XPos=2016; ZPos=896; }
			[special1] { specialwhat=StartPos1; XPos=1008; ZPos=448; }
		}
	}
}`
	r, data := writeTestMap(t, 64, 32, ota)
	out := map[string]any{}
	describeTNT(r, "maps/test.tnt", data, out)
	frame, ok := out["minimapFrame"].(map[string]int)
	if !ok || frame["contentW"] != 252 || frame["contentH"] != 112 || frame["visibleW"] != 2016 || frame["visibleH"] != 896 {
		t.Fatalf("minimapFrame = %v, want content 252x112 of visible 2016x896", out["minimapFrame"])
	}
	starts, _ := out["startPositions"].([]startPosition)
	if len(starts) != 2 {
		t.Fatalf("startPositions = %+v, want the Network 1 schema's two", out["startPositions"])
	}
	near := func(a, b float64) bool { return math.Abs(a-b) < 0.01 }
	if s := starts[0]; s.Number != 1 || s.Slot != 0 || !near(s.PctX, 50) || !near(s.PctY, 100*56.0/252) {
		t.Errorf("StartPos1 = %+v, want slot 0 at 50%% x %.2f%%", s, 100*56.0/252)
	}
	if s := starts[1]; !near(s.PctX, 100) || !near(s.PctY, 100*112.0/252) {
		t.Errorf("StartPos2 = %+v, want the region's far corner (100%%, %.2f%%)", s, 100*112.0/252)
	}
}

// TestDescribeTNTRetailRegion checks a retail map whose minimap has no
// padding still gets its region from the map's size: ac04 (128×96 tiles)
// is 252×182, not the stored 252×256.
func TestDescribeTNTRetailRegion(t *testing.T) {
	data, err := os.ReadFile(testutil.UnpackedFile(t, "maps", "ac04.tnt"))
	if err != nil {
		t.Fatalf("read ac04: %v", err)
	}
	out := map[string]any{}
	describeTNT(newTestRenderer(t), "maps/ac04.tnt", data, out)
	frame, ok := out["minimapFrame"].(map[string]int)
	if !ok || frame["contentW"] != 252 || frame["contentH"] != 182 {
		t.Fatalf("ac04 minimapFrame = %v, want content 252x182", out["minimapFrame"])
	}
}
