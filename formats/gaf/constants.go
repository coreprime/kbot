package gaf

const (
	// HeaderSize is the size of the GAF header in bytes
	HeaderSize = 8

	// EntryHeaderSize is the size of a GAF entry header
	EntryHeaderSize = 32

	// FrameDataHeaderSize is the size of frame data header
	FrameDataHeaderSize = 32
)

// GAF file format structure:
// - Header (8 bytes): version, num_entries
// - Entry headers array (32 bytes each)
// - Frame data (variable size, compressed)
