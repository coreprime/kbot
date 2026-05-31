package main

import (
	"bytes"
	"fmt"
	"image/color"
	"path/filepath"
	"strings"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/internal/assets"
)

// tntPalette returns the embedded TA palette as a color.Palette.
func tntPalette() (color.Palette, error) {
	pal, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	if err != nil {
		return nil, fmt.Errorf("load TA palette: %w", err)
	}
	return pal.ColorModel(), nil
}

// takKingdomPalette returns the embedded TA: Kingdoms terrain/minimap palette
// for a kingdom name (aramon, taros, veruna, zhon, creon). TA:K bakes its
// minimap with the per-kingdom texture palette rather than a single global one.
func takKingdomPalette(kingdom string) (color.Palette, error) {
	raw, ok := assets.TAKPalettes[strings.ToLower(strings.TrimSpace(kingdom))]
	if !ok {
		return nil, fmt.Errorf("unknown TA:K kingdom %q (want aramon, taros, veruna, zhon, or creon)", kingdom)
	}
	pal, err := gaf.LoadPaletteFromBytes(raw)
	if err != nil {
		return nil, fmt.Errorf("load TA:K %s palette: %w", kingdom, err)
	}
	return pal.ColorModel(), nil
}

// takPaletteForTNT resolves the palette for a TA:K map: an explicit kingdom
// override wins, else the kingdom is read from the sibling .ota. Returns a
// clear error when neither is available.
func takPaletteForTNT(tntPath, kingdomOverride string) (color.Palette, error) {
	k := kingdomOverride
	if k == "" {
		k = takKingdomForTNT(tntPath)
	}
	if k == "" {
		return nil, fmt.Errorf("TA:K render needs a kingdom palette: no sibling .ota found; pass --kingdom (aramon|taros|veruna|zhon|creon)")
	}
	return takKingdomPalette(k)
}

// takFeaturePalette loads a TA:K kingdom's feature sprite palette from a VFS
// root. Feature GAFs are indexed against the palette embedded in
// palettes/<kingdom>_features.pcx — the sibling .pal carries a different
// (wrong-for-sprites) table, so the .pcx is authoritative here.
func takFeaturePalette(kingdom string, vfs *filesystem.VirtualFileSystem) (*gaf.Palette, error) {
	k := strings.ToLower(strings.TrimSpace(kingdom))
	if k == "" {
		return nil, fmt.Errorf("TA:K feature palette needs a kingdom")
	}
	name := "palettes/" + k + "_features.pcx"
	data, err := vfs.ReadFile(name)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	r, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", name, err)
	}
	pal := r.EmbeddedPalette()
	if pal == nil {
		return nil, fmt.Errorf("%s has no embedded palette", name)
	}
	return pal, nil
}

// takKingdomForTNT reads the kingdom affinity from a TA:K map's sibling .ota
// (same directory, same base name). Returns "" if the .ota is absent or has no
// kingdom field — the caller decides how to handle an unknown kingdom.
func takKingdomForTNT(tntPath string) string {
	ota := strings.TrimSuffix(tntPath, filepath.Ext(tntPath)) + ".ota"
	doc, err := tdf.ParseFile(ota)
	if err != nil {
		return ""
	}
	gh := doc.Section("GlobalHeader")
	if gh == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(gh.String("kingdom")))
}
