package main

import (
	"fmt"

	"github.com/coreprime/kbot/formats/pal"
	"github.com/coreprime/kbot/internal/assets"
)

// embeddedPalette returns the embedded Total Annihilation palette parsed
// through the pal package.  Shared by pal/sct/fnt/tnt commands that need a
// default palette when the caller doesn't supply one.
func embeddedPalette() (*pal.Palette, error) {
	p, err := pal.LoadFromBytes(assets.DefaultPalette)
	if err != nil {
		return nil, fmt.Errorf("load embedded TA palette: %w", err)
	}
	return p, nil
}
