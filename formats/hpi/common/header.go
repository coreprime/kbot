package common

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Header represents the fixed 20-byte HPI v1 header. The v2 reader populates
// only Marker and Version (the supplemental v2 header is read separately), so
// the remaining fields are zero for TA: Kingdoms archives.
type Header struct {
	Marker        uint32 // Should be 0x49504148 ("HAPI")
	Version       uint32 // HPI version (VersionV1 or VersionV2)
	DirectorySize uint32 // Size of directory section in bytes
	DecryptKey    uint32 // Decryption key
	Offset        uint32 // Offset to directory start
}

// ReadHeader reads and validates an HPI header from a reader.
func ReadHeader(r io.Reader) (*Header, error) {
	h := &Header{}

	if err := binary.Read(r, binary.LittleEndian, h); err != nil {
		return nil, fmt.Errorf("failed to read header: %w", err)
	}

	if h.Marker != HeaderMarker {
		return nil, fmt.Errorf("invalid HPI marker: 0x%X (expected 0x%X)", h.Marker, HeaderMarker)
	}

	return h, nil
}

// WriteHeader writes an HPI header to a writer.
func (h *Header) WriteHeader(w io.Writer) error {
	if err := binary.Write(w, binary.LittleEndian, h); err != nil {
		return fmt.Errorf("failed to write header: %w", err)
	}
	return nil
}
