package studio

import (
	"bytes"
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
