package assets

import (
	_ "embed"
)

// DefaultPalette contains the embedded Total Annihilation color palette (256 colors, RGBA format, 1024 bytes)
//
//go:embed PALETTE.PAL
var DefaultPalette []byte
