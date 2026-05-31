package gaf

// Variant identifies which game's colouring rules apply to a GAF's indexed
// pixels.
//
// The on-disk GAF binary format is identical between Total Annihilation and
// TA: Kingdoms: the same version word, the same sequence/frame layout, and the
// same row RLE encoding. The games differ only in how the palette indices are
// coloured:
//
//   - Total Annihilation uses a single shared 256-colour palette
//     (palettes/PALETTE.PAL).
//   - TA: Kingdoms stores palettes externally. Interface GAFs pair with a
//     sibling .pcx of the same base name; unit and feature GAFs use a
//     side-specific palette (Aramon, Taros, Veruna, Zhon).
//
// Because the bytes are identical, the variant cannot be detected from a GAF
// file alone — callers supply it from context (which game or directory the
// asset came from). This type exists to make that decision explicit at call
// sites rather than leaving it implicit in whichever palette happens to be
// passed to the renderer.
type Variant int

const (
	// VariantUnknown is the zero value: the caller has not stated which game
	// the asset belongs to. Rendering still works; it simply uses whatever
	// palette is supplied.
	VariantUnknown Variant = iota
	// VariantTA is Total Annihilation (shared palette).
	VariantTA
	// VariantTAK is TA: Kingdoms (external / side-specific palette).
	VariantTAK
)

// String returns a short human-readable name for the variant.
func (v Variant) String() string {
	switch v {
	case VariantTA:
		return "ta"
	case VariantTAK:
		return "tak"
	default:
		return "unknown"
	}
}

// DefaultRenderOptions returns the transparency policy that best matches a
// variant's authored assets.
//
// TA: Kingdoms texture-atlas GAFs frequently carry a TransparencyIndex that
// does not match the pixel value the artist used for the transparent fill, so
// the corner-detect heuristic (TransparencyModeAuto) gives the most faithful
// result. Total Annihilation assets store an honest TransparencyIndex, which
// the same Auto mode also handles, so both currently resolve to Auto; keeping
// the choice behind this helper lets the policies diverge later without
// touching call sites.
func (v Variant) DefaultRenderOptions() RenderOptions {
	return RenderOptions{Mode: TransparencyModeAuto}
}
