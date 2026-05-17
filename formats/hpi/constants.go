package hpi

// HPI file format constants based on TA HPI specification

const (
	// HeaderMarker is the magic number identifying HPI files
	HeaderMarker = 0x49504148 // "HAPI" in little-endian
	
	// ChunkMarker is the magic number for compressed chunks
	ChunkMarker = 0x48535153 // "SQSH" in little-endian

	// HeaderSize is the size of the HPI header in bytes
	HeaderSize = 20

	// DirectoryEntrySize is the size of a directory entry
	DirectoryEntrySize = 9

	// FileEntrySize is the size of a file entry
	FileEntrySize = 9

	// ChunkHeaderSize is the size of a chunk header
	ChunkHeaderSize = 9
)

// Compression types
const (
	CompressionNone = 0 // No compression
	CompressionLZ77 = 1 // LZ77 compression
	CompressionZLib = 2 // ZLib compression
)

// Entry types
const (
	EntryTypeDirectory = 1
	EntryTypeFile      = 0
)

// Decryption key for encrypted HPIs
const DecryptKey = ^byte(0) // XOR with 0xFF

// DefaultHeaderKey is the HeaderKey value Total Annihilation writes into the
// HPI header for the main game archives shipped on disk (totala1/2/4.hpi).
// A value of 0 disables encryption entirely.
const DefaultHeaderKey uint8 = 0xBF

// DefaultTrailer is the 36-byte ASCII signature written at the end of every
// retail TA HPI archive. The game's loader appears to expect it, so the
// writer emits it by default to keep custom archives compatible.
const DefaultTrailer = "Copyright 1997 Cavedog Entertainment"
