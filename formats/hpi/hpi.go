// Package hpi provides version-agnostic reading of Total Annihilation and
// TA: Kingdoms HPI archives.
//
// Reading is transparent: OpenReader peeks the version word and returns an
// Archive backed by either the v1 (TA) or v2 (TA: Kingdoms) reader, so callers
// such as the VFS never need to know which game an archive came from.
//
// Writing is version-specific. There is no generic writer here; callers must
// import the concrete sub-package (hpi/v1 for Total Annihilation) and use its
// CreateWriter. This keeps the write path explicit about the on-disk format it
// produces.
//
// Shared on-disk primitives (the entry tree, header, LZ77, chunk decoding, and
// the XOR cipher) live in hpi/common. The v1 and v2 sub-packages build their
// readers and writers on top of it.
package hpi

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"

	"github.com/coreprime/kbot/formats/hpi/common"
	"github.com/coreprime/kbot/formats/hpi/v1"
	"github.com/coreprime/kbot/formats/hpi/v2"
)

// Entry is a file or directory node in an archive. It is shared by every
// version so callers can walk either tree with the same type.
type Entry = common.Entry

// Header is the archive header. v1 archives populate every field; v2 archives
// populate only Marker and Version.
type Header = common.Header

// Re-exported format constants so callers do not have to import hpi/common for
// the common cases.
const (
	CompressionNone = common.CompressionNone
	CompressionLZ77 = common.CompressionLZ77
	CompressionZLib = common.CompressionZLib

	VersionV1 = common.VersionV1
	VersionV2 = common.VersionV2

	HeaderMarker = common.HeaderMarker
	ChunkMarker  = common.ChunkMarker

	DefaultHeaderKey = common.DefaultHeaderKey
	DefaultTrailer   = common.DefaultTrailer
)

// Archive is the version-agnostic read interface over an HPI archive. Both the
// v1 and v2 readers satisfy it, so OpenReader can hand back either behind this
// single type.
type Archive interface {
	// Version reports the on-disk HPI version (VersionV1 or VersionV2).
	Version() uint32

	// Close releases the underlying file handle.
	Close() error

	// Header returns the archive header.
	Header() *Header

	// Root returns the root directory entry.
	Root() *Entry

	// List returns the full paths of every file in the archive.
	List() []string

	// Walk traverses every entry depth-first.
	Walk(fn func(*Entry) error) error

	// Find locates an entry by path, or returns nil.
	Find(path string) *Entry

	// Open opens a file from the archive by path.
	Open(path string) (io.ReadCloser, error)

	// OpenEntry opens a previously located file entry.
	OpenEntry(entry *Entry) (io.ReadCloser, error)
}

// OpenReader opens an HPI archive for reading, auto-detecting the on-disk
// version and returning the matching reader behind the Archive interface.
func OpenReader(path string) (Archive, error) {
	version, err := detectVersion(path)
	if err != nil {
		return nil, err
	}

	switch version {
	case common.VersionV1:
		return v1.Open(path)
	case common.VersionV2:
		return v2.Open(path)
	default:
		return nil, fmt.Errorf("unsupported HPI version: 0x%X", version)
	}
}

// detectVersion reads the 8-byte marker+version prologue and validates the
// marker before reporting the version word.
func detectVersion(path string) (uint32, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer func() { _ = file.Close() }()

	var marker, version uint32
	if err := binary.Read(file, binary.LittleEndian, &marker); err != nil {
		return 0, fmt.Errorf("reading HPI marker: %w", err)
	}
	if err := binary.Read(file, binary.LittleEndian, &version); err != nil {
		return 0, fmt.Errorf("reading HPI version: %w", err)
	}
	if marker != common.HeaderMarker {
		return 0, fmt.Errorf("invalid HPI marker: 0x%X", marker)
	}
	return version, nil
}
