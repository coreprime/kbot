package gaf

// TransparencyMode selects how a frame's transparency index is resolved at
// render time. The zero value is TransparencyModeAuto, which preserves the
// historical behavior callers got from Frame.TransparencyIndex.
type TransparencyMode int

const (
	// TransparencyModeAuto uses EffectiveTransparencyIndex (corner-detect
	// heuristic for TAK uncompressed frames, metadata otherwise).
	TransparencyModeAuto TransparencyMode = iota
	// TransparencyModeMetadata forces use of Frame.TransparencyIndex
	// exactly as stored on disk, bypassing the heuristic.
	TransparencyModeMetadata
	// TransparencyModeNone disables transparency for the render — every
	// palette entry stays opaque.
	TransparencyModeNone
	// TransparencyModeIndex uses a caller-supplied palette index.
	TransparencyModeIndex
)

// RenderOptions controls per-render transparency choices. A zero-valued
// RenderOptions resolves to TransparencyModeAuto.
type RenderOptions struct {
	Mode  TransparencyMode
	Index uint8 // honored when Mode == TransparencyModeIndex
}

// resolveTransparency returns the palette index to make transparent and
// whether transparency should be applied at all.
func (f *Frame) resolveTransparency(opts RenderOptions) (uint8, bool) {
	switch opts.Mode {
	case TransparencyModeMetadata:
		return f.TransparencyIndex, true
	case TransparencyModeNone:
		return 0, false
	case TransparencyModeIndex:
		return opts.Index, true
	default:
		return f.EffectiveTransparencyIndex(), true
	}
}

// EffectiveTransparencyIndex returns the palette index that should be treated
// as transparent when this frame is rendered.
//
// Most TA assets store an honest TransparencyIndex in the frame header — the
// artist used that exact palette index for transparent pixels and the
// renderer simply makes palette[TI] transparent. TA: Kingdoms texture-atlas
// GAFs frequently carry a TransparencyIndex that doesn't match the actual
// pixel value the artist used as the transparent fill (e.g. metadata claims
// 9, the on-disk pixels are 5). In that case TA-style rendering shows the
// background as an opaque dark teal rather than transparent.
//
// The heuristic:
//
//  1. If TransparencyIndex appears anywhere in the pixel data, trust it.
//     This is the common case — the decompressor's "transparent run" opcode
//     fills with TI, and TA assets where TI is correctly authored also have
//     TI-valued pixels in the data.
//
//  2. Otherwise sample the four corners; if they all agree on a value, use
//     that. This rescues TAK uncompressed frames where TI is bogus but the
//     artist painted a uniform border (the canonical "background" pixels).
//
//  3. Otherwise fall back to TransparencyIndex.
//
// The on-disk TransparencyIndex value is never overwritten — round-trip
// writers still see the original byte.
func (f *Frame) EffectiveTransparencyIndex() uint8 {
	if f == nil || len(f.Pixels) == 0 || f.Width == 0 || f.Height == 0 {
		return f.TransparencyIndex
	}
	// Cheap scan: if metadata TI is present in the pixel data, prefer it.
	for _, p := range f.Pixels {
		if p == f.TransparencyIndex {
			return f.TransparencyIndex
		}
	}
	w := int(f.Width)
	h := int(f.Height)
	if w*h != len(f.Pixels) {
		// Mismatched pixel buffer (corrupt frame) — fall back to metadata
		// rather than indexing out of range.
		return f.TransparencyIndex
	}
	tl := f.Pixels[0]
	tr := f.Pixels[w-1]
	bl := f.Pixels[(h-1)*w]
	br := f.Pixels[h*w-1]
	if tl == tr && tr == bl && bl == br {
		return tl
	}
	return f.TransparencyIndex
}
