// Package gaf implements reading and writing of Total Annihilation and TA:
// Kingdoms GAF (Graphics Animation Format) files.
//
// The on-disk binary layout is identical between both games; only palette
// resolution differs. See variant.go for how callers signal which game an
// asset belongs to.
package gaf

// VersionTA is the standard GAF header version word.
const VersionTA = 0x00010100

// isSupportedGAFVersion reports whether a header version field is recognised.
// Cavedog shipped a handful of stock GAFs (e.g. anims/terrain.gaf,
// anims/vismasks.gaf) with the version field set to zero; original TA tooling
// like Kinboat treats the field as opaque and reads them fine.
func isSupportedGAFVersion(v uint32) bool {
	return v == VersionTA || v == 0
}

// Header represents the GAF file header (12 bytes).
type Header struct {
	Version       uint32 // Always 0x00010100
	SequenceCount uint32 // Number of animation sequences
	Unknown1      uint32 // Always 0
}

// SequenceHeader represents an animation sequence header (40 bytes).
type SequenceHeader struct {
	FrameCount uint16   // Number of frames
	Unknown1   uint16   // Unknown
	Unknown2   uint32   // Unknown
	Name       [32]byte // Sequence name (null-terminated)
}

// FrameListItem describes a frame entry (8 bytes).
type FrameListItem struct {
	PtrFrameInfo uint32 // Pointer to frame info
	Duration     uint32 // Duration in game ticks (1/30th second)
}

// FrameInfo describes frame properties (24 bytes).
type FrameInfo struct {
	Width             uint16 // Frame width
	Height            uint16 // Frame height
	OriginX           int16  // X origin offset
	OriginY           int16  // Y origin offset
	TransparencyIndex uint8  // Transparent color index
	Compressed        uint8  // 0=uncompressed, 1=compressed
	LayerCount        uint16 // Number of subframes (0 for simple frames)
	Unknown2          uint32 // Unknown
	PtrFrameData      uint32 // Pointer to pixel data
	Unknown3          uint32 // Unknown
}

// Sequence represents a complete animation sequence.
type Sequence struct {
	Name   string
	Frames []*Frame
}

// Frame represents a single animation frame.
type Frame struct {
	Width             uint16
	Height            uint16
	OriginX           int16
	OriginY           int16
	TransparencyIndex uint8
	Duration          uint32 // In game ticks (1/30th second)
	Pixels            []byte // Palette indices
}
