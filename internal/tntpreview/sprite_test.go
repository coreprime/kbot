package tntpreview

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/tnt"
	"github.com/coreprime/kbot-io/palettes"
)

// spriteVFS mounts a loose tree holding one feature definition and its GAF.
func spriteVFS(t *testing.T, frame *gaf.Frame) *filesystem.VirtualFileSystem {
	t.Helper()
	root := t.TempDir()
	write := func(rel string, data []byte) {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	if err := gaf.WriteGAF(&buf, []*gaf.Sequence{{Name: "rock", LoopFlags: 1, Frames: []*gaf.Frame{frame}}}); err != nil {
		t.Fatal(err)
	}
	write("anims/rocks.gaf", buf.Bytes())
	write("features/rocks.tdf", []byte("[Rock1]\n{\n\tfilename=rocks;\n\tseqname=rock;\n\tfootprintx=1;\n\tfootprintz=1;\n}\n"))
	vfs, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	return vfs
}

// TestFeatureSpriteKeepsBlackOpaque checks that feature sprites are drawn
// with the game's rule: palette index 0 is opaque black, and only the
// frame's key is transparent.
func TestFeatureSpriteKeepsBlackOpaque(t *testing.T) {
	frame := &gaf.Frame{
		Width: 3, Height: 1, TransparencyIndex: 9, Duration: 1,
		Storage: gaf.StorageRaw, Pixels: []byte{0, 9, 250},
	}
	pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
	if err != nil {
		t.Fatal(err)
	}
	cache := newFeatureSpriteCache(spriteVFS(t, frame), pal, gaf.VariantTA.DefaultRenderOptions())
	sp := cache.sprite("rock1")
	if sp == nil {
		t.Fatal("sprite not resolved")
	}

	// Paint the sprite over white terrain, as the preview does.
	base := image.NewRGBA(image.Rect(0, 0, 3, 1))
	draw.Draw(base, base.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(base, base.Bounds(), sp.img, image.Point{}, draw.Over)

	if got := base.RGBAAt(0, 0); got != (color.RGBA{0, 0, 0, 255}) {
		t.Errorf("index 0 pixel = %v, want opaque black over the terrain", got)
	}
	if got := base.RGBAAt(1, 0); got != (color.RGBA{255, 255, 255, 255}) {
		t.Errorf("key pixel = %v, want the terrain showing through", got)
	}
}

// TestFeatureSpriteKeepsCornerColours checks that a TA frame whose key does
// not occur is drawn whole: the game never guesses a key from the corners.
func TestFeatureSpriteKeepsCornerColours(t *testing.T) {
	frame := &gaf.Frame{
		Width: 2, Height: 2, TransparencyIndex: 9, Duration: 1,
		Storage: gaf.StorageRaw, Pixels: []byte{79, 79, 79, 79},
	}
	pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
	if err != nil {
		t.Fatal(err)
	}
	sp := newFeatureSpriteCache(spriteVFS(t, frame), pal, gaf.VariantTA.DefaultRenderOptions()).sprite("rock1")
	if sp == nil {
		t.Fatal("sprite not resolved")
	}
	for i, idx := range sp.img.Pix {
		if _, _, _, a := sp.img.Palette[idx].RGBA(); a != 0xffff {
			t.Fatalf("pixel %d is transparent; the game draws it", i)
		}
	}
}

// composeOneFeature paints the feature "Rock1" (a 2x2 raw frame of index 79
// whose key, 9, does not occur) on a one-cell map over white terrain,
// through the TA or TA: Kingdoms entry point, and returns the result.
func composeOneFeature(t *testing.T, kingdoms bool) (*image.RGBA, Stats) {
	t.Helper()
	frame := &gaf.Frame{
		Width: 2, Height: 2, TransparencyIndex: 9, Duration: 1,
		Storage: gaf.StorageRaw, Pixels: []byte{79, 79, 79, 79},
	}
	pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
	if err != nil {
		t.Fatal(err)
	}
	vfs := spriteVFS(t, frame)
	features := []tnt.Feature{{Index: 0, Name: "Rock1"}}
	base := image.NewRGBA(image.Rect(0, 0, 32, 32))
	draw.Draw(base, base.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)

	var stats Stats
	if kingdoms {
		m := &tnt.Map{IsTAK: true, TAKW: 1, TAKH: 1, TAKFeatureGrid: []uint16{0}, TAKHeight: []byte{0}}
		m.Header.TileAnims = 1
		stats, err = ComposeTAK(base, m, features, vfs, pal)
	} else {
		m := &tnt.Map{AttrW: 1, AttrH: 1, TileAttr: []tnt.TileAttr{{Feature: 0}}}
		m.Header.TileAnims = 1
		stats, err = ComposeWith(base, m, features, vfs, pal, "", "", Options{})
	}
	if err != nil {
		t.Fatal(err)
	}
	return base, stats
}

// TestComposeDrawsTAFeaturesWithTheGameRule checks the TA preview's choice
// of transparency: the game draws every pixel of a raw frame whose key does
// not occur, even when its corners agree.
func TestComposeDrawsTAFeaturesWithTheGameRule(t *testing.T) {
	pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
	if err != nil {
		t.Fatal(err)
	}
	want := color.RGBAModel.Convert(pal.Colors[79]).(color.RGBA)
	want.A = 255
	img, stats := composeOneFeature(t, false)
	if stats.SpritesPainted != 1 {
		t.Fatalf("painted %d sprites, want 1", stats.SpritesPainted)
	}
	n := 0
	for i := 0; i < len(img.Pix); i += 4 {
		if (color.RGBA{img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3]}) == want {
			n++
		}
	}
	if n != 4 {
		t.Errorf("%d pixels show the sprite colour, want all 4 of the frame", n)
	}
}

// TestComposeTAKGuessesRawKeys checks the TA: Kingdoms preview's choice:
// its raw atlases often store a key that differs from their background, so
// a uniform-cornered raw frame whose key does not occur is drawn with the
// corner colour transparent.
func TestComposeTAKGuessesRawKeys(t *testing.T) {
	img, stats := composeOneFeature(t, true)
	if stats.SpritesPainted != 1 {
		t.Fatalf("painted %d sprites, want 1", stats.SpritesPainted)
	}
	for i := 0; i < len(img.Pix); i += 4 {
		if (color.RGBA{img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3]}) != (color.RGBA{255, 255, 255, 255}) {
			t.Fatalf("pixel %d is not the terrain; the corner colour should be transparent", i/4)
		}
	}
}
