package main

import (
	"fmt"
	"image/color"

	"github.com/coreprime/kbot/formats/gaf"
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
