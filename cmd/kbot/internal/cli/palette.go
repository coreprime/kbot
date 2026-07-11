package cli

import (
	"fmt"

	"github.com/coreprime/kbot-io/formats/pal"
	"github.com/coreprime/kbot-io/palettes"
)

// EmbeddedPalette returns the embedded Total Annihilation palette parsed
// through the pal package.  Shared by pal/sct/fnt/tnt commands that need a
// default palette when the caller doesn't supply one.
func EmbeddedPalette() (*pal.Palette, error) {
	p, err := pal.LoadFromBytes(palettes.DefaultPalette)
	if err != nil {
		return nil, fmt.Errorf("load embedded TA palette: %w", err)
	}
	return p, nil
}
