package hpi

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Header represents the HPI file header
type Header struct {
	Marker         uint32 // Should be 0x49504148 ("HAPI")
	Version        uint32 // HPI version (usually 0x00010000)
	DirectorySize  uint32 // Size of directory section in bytes
	DecryptKey     uint32 // Decryption key
	Offset         uint32 // Offset to directory start
}

// ReadHeader reads and validates an HPI header from a reader
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

// WriteHeader writes an HPI header to a writer
func (h *Header) WriteHeader(w io.Writer) error {
	if err := binary.Write(w, binary.LittleEndian, h); err != nil {
		return fmt.Errorf("failed to write header: %w", err)
	}
	return nil
}

// Size returns the size of the header in bytes
func (h *Header) Size() int {
	return HeaderSize
}
