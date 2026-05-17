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
