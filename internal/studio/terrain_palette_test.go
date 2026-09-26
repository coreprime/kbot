package studio

import (
	"bytes"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/coreprime/kbot-io/formats/tnt"
)

// TestTerrainPaletteIsOpaque checks the palette the editor's tile pool,
// section previews and map exports use: every entry is opaque (the game
// draws terrain with palette index 0 as black) and none is missing, even
// when palettes/palette.pal is too short to use.
func TestTerrainPaletteIsOpaque(t *testing.T) {
	longPal := make([]byte, 1100)
	longPal[4], longPal[5], longPal[6] = 1, 2, 3
	for name, files := range map[string]map[string][]byte{
		"none":  nil,
		"short": {"palettes/palette.pal": make([]byte, 300)},
		"long":  {"palettes/palette.pal": longPal},
	} {
		sess := looseSession(t, "totala", files)
		pal := sess.loadVFSPalette()
		if len(pal) != 256 {
			t.Fatalf("%s: %d entries", name, len(pal))
		}
		for i, c := range pal {
			if c == nil {
				t.Fatalf("%s: entry %d is nil", name, i)
			}
			if _, _, _, a := c.RGBA(); a != 0xffff {
				t.Fatalf("%s: entry %d alpha %d", name, i, a)
			}
		}
		if name == "long" {
			if r, g, b, _ := pal[1].RGBA(); r>>8 != 1 || g>>8 != 2 || b>>8 != 3 {
				t.Errorf("long palette.pal: entry 1 = %d,%d,%d; want its first 1,024 bytes", r>>8, g>>8, b>>8)
			}
		}
		if got := len(sess.loadPaletteBytes()); got != 1024 {
			t.Errorf("%s: loadPaletteBytes gave %d bytes", name, got)
		}
	}
}

// TestTilePoolDrawsIndexZeroOpaque renders a tile of palette index 0 through
// the editor's tile-pool endpoint and checks it comes back opaque black.
func TestTilePoolDrawsIndexZeroOpaque(t *testing.T) {
	sess := looseSession(t, "totala", map[string][]byte{"palettes/palette.pal": make([]byte, 300)})
	sess.cacheTNT("upload:zero", &tnt.Map{Tiles: [][]byte{make([]byte, 1024)}})
	rec := httptest.NewRecorder()
	sess.handleMapTilePool(rec, httptest.NewRequest(http.MethodGet, "/api/studio/tile-pool/upload:zero", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	img, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if r, g, b, a := img.At(5, 5).RGBA(); a != 0xffff || r|g|b != 0 {
		t.Errorf("index 0 texel = (%d,%d,%d,%d), want opaque black", r, g, b, a)
	}
}

// pcxPalette returns a 1x1 PCX whose palette entry i is (i, 7, 9).
func pcxPalette() []byte {
	data := make([]byte, 128)
	data[0], data[1], data[2], data[3] = 0x0A, 5, 1, 8
	data[65], data[66] = 1, 1
	data = append(data, 0xC1, 0, 0x0C)
	for i := 0; i < 256; i++ {
		data = append(data, byte(i), 7, 9)
	}
	return data
}

// TestTAPalettesLoadLikeTheGame checks the palettes a TA session's game
// adapter hands out (minimaps, sandbox terrain, features, textures, model
// colours): they come from the install's palette loaded as the game loads
// it, so they match the editor's tile pool. A palette.pal longer than 1,024
// bytes gives its first 1,024 bytes, and an empty one falls back to
// palettes/palette.pcx.
func TestTAPalettesLoadLikeTheGame(t *testing.T) {
	longPal := make([]byte, 1100)
	longPal[12], longPal[13], longPal[14] = 3, 7, 9
	for name, files := range map[string]map[string][]byte{
		"long pal":  {"palettes/palette.pal": longPal},
		"empty pal": {"palettes/palette.pal": {}, "palettes/palette.pcx": pcxPalette()},
	} {
		sess := looseSession(t, "totala", files)
		a := sess.palettes()
		want := color.RGBA{3, 7, 9, 255}
		for what, p := range map[string]color.Palette{
			"terrain":      a.TerrainPalette("maps/x.tnt"),
			"model colour": a.ModelColorPalette("armcom"),
			"feature":      a.FeaturePalette("rocks").ColorModel(),
			"texture":      a.TexturePalette("textures/armtex.gaf").ColorModel(),
			"tile pool":    sess.loadVFSPalette(),
		} {
			if got := color.RGBAModel.Convert(p[3]).(color.RGBA); got != want {
				t.Errorf("%s: %s palette entry 3 = %v, want %v", name, what, got, want)
			}
		}
	}
	if _, ok := looseSession(t, "takingdoms", nil).palettes().(*taPalettes); ok {
		t.Error("a TA: Kingdoms session got the TA palette adapter")
	}
}

// TestTAMinimapAndTerrainUseTheGamePalette renders a map's minimap and its
// sandbox terrain texture on an install whose palette.pal is empty: both
// take their colours from palettes/palette.pcx, as the game does.
func TestTAMinimapAndTerrainUseTheGamePalette(t *testing.T) {
	m, features, err := newSession("test", "test", nil, t.TempDir()).buildMap(saveRequest{MapName: "pcxpal", TileW: 16, TileH: 16})
	if err != nil {
		t.Fatal(err)
	}
	for i := range m.Minimap {
		m.Minimap[i] = 3
	}
	for _, tile := range m.Tiles {
		for i := range tile {
			tile[i] = 3
		}
	}
	var buf bytes.Buffer
	if err := m.Save(&buf, features); err != nil {
		t.Fatal(err)
	}
	sess := looseSession(t, "totala", map[string][]byte{
		"palettes/palette.pal": {},
		"palettes/palette.pcx": pcxPalette(),
		"maps/pcxpalette.tnt":  buf.Bytes(),
	})
	want := color.RGBA{3, 7, 9, 255}
	for name, tc := range map[string]struct {
		handler http.HandlerFunc
		url     string
	}{
		"minimap":         {sess.handleMapMinimap, "/api/studio/minimap/maps/pcxpalette.tnt"},
		"sandbox terrain": {sess.handleSandboxMapTexture, "/api/studio/sandbox-map-texture?path=maps/pcxpalette.tnt&max=256"},
	} {
		rec := httptest.NewRecorder()
		tc.handler(rec, httptest.NewRequest(http.MethodGet, tc.url, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d: %s", name, rec.Code, rec.Body.String())
		}
		img, err := png.Decode(bytes.NewReader(rec.Body.Bytes()))
		if err != nil {
			t.Fatal(err)
		}
		if got := color.RGBAModel.Convert(img.At(2, 2)).(color.RGBA); got != want {
			t.Errorf("%s: pixel = %v, want the palette.pcx colour %v", name, got, want)
		}
	}
}
