package smacker

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
)

// Smacker file header constants
const (
	SignatureSMK2 = 0x324B4D53 // "SMK2" as little-endian uint32
	SignatureSMK4 = 0x344B4D53 // "SMK4" as little-endian uint32
	HeaderSize    = 104        // Minimum header size
)

// Header represents a Smacker video file header
type Header struct {
	Signature     uint32 // Should be "SMK2" or "SMK4"
	Width         uint32
	Height        uint32
	Frames        uint32
	FrameRate     int32 // Microseconds per frame (negative = frames per second)
	Flags         uint32
	AudioSize     [7]uint32
	TreesSize     uint32
	MMapSize      uint32
	MClrSize      uint32
	FullSize      uint32
	TypeSize      uint32
	AudioRate     [7]uint32
	AudioFlags    [7]uint32 // Lower 2 bytes: format, upper: channels
	FrameSizes    []uint32  // Array of frame sizes
	FrameTypes    []byte    // Array of frame types
	HuffmanTrees  []byte    // Huffman trees data
	RingFrame     uint32
}

// Reader wraps a Smacker video file for reading
type Reader struct {
	file   *os.File
	header *Header
}

// OpenReader opens a Smacker video file for reading
func OpenReader(path string) (*Reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open file: %w", err)
	}

	header, err := readHeader(f)
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("failed to read header: %w", err)
	}

	return &Reader{
		file:   f,
		header: header,
	}, nil
}

// Close closes the reader
func (r *Reader) Close() error {
	if r.file != nil {
		return r.file.Close()
	}
	return nil
}

// Header returns the video header
func (r *Reader) Header() *Header {
	return r.header
}

// Width returns video width
func (r *Reader) Width() int {
	return int(r.header.Width)
}

// Height returns video height
func (r *Reader) Height() int {
	return int(r.header.Height)
}

// FrameCount returns total number of frames
func (r *Reader) FrameCount() int {
	return int(r.header.Frames)
}

// FrameRate returns frames per second
func (r *Reader) FrameRate() float64 {
	if r.header.FrameRate < 0 {
		// Negative values appear to be stored as: -(100000 / fps)
		// For 30 fps: -(100000/30) = -3333.33 ≈ -3333
		// So to get fps: 100000 / abs(value)
		fps := 100000.0 / float64(-r.header.FrameRate)
		return fps
	}
	if r.header.FrameRate == 0 {
		return 15.0 // Default fallback
	}
	
	// Positive means microseconds per frame
	return 1000000.0 / float64(r.header.FrameRate)
}

// Duration returns video duration in seconds
func (r *Reader) Duration() float64 {
	return float64(r.header.Frames) / r.FrameRate()
}

// HasAudio returns true if the video has any audio tracks
func (r *Reader) HasAudio() bool {
	for i := 0; i < 7; i++ {
		if r.header.AudioFlags[i] != 0 {
			return true
		}
	}
	return false
}

// readHeader reads and parses the Smacker header
func readHeader(f *os.File) (*Header, error) {
	h := &Header{}

	// Read signature
	if err := binary.Read(f, binary.LittleEndian, &h.Signature); err != nil {
		return nil, err
	}

	// Verify signature
	if h.Signature != SignatureSMK2 && h.Signature != SignatureSMK4 {
		return nil, fmt.Errorf("invalid signature: 0x%08X (expected SMK2 or SMK4)", h.Signature)
	}

	// Read basic header fields
	if err := binary.Read(f, binary.LittleEndian, &h.Width); err != nil {
		return nil, err
	}
	if err := binary.Read(f, binary.LittleEndian, &h.Height); err != nil {
		return nil, err
	}
	if err := binary.Read(f, binary.LittleEndian, &h.Frames); err != nil {
		return nil, err
	}
	if err := binary.Read(f, binary.LittleEndian, &h.FrameRate); err != nil {
		return nil, err
	}
	if err := binary.Read(f, binary.LittleEndian, &h.Flags); err != nil {
		return nil, err
	}

	// Read audio info
	for i := 0; i < 7; i++ {
		if err := binary.Read(f, binary.LittleEndian, &h.AudioSize[i]); err != nil {
			return nil, err
		}
	}

	// Read tree sizes
	if err := binary.Read(f, binary.LittleEndian, &h.TreesSize); err != nil {
		return nil, err
	}
	if err := binary.Read(f, binary.LittleEndian, &h.MMapSize); err != nil {
		return nil, err
	}
	if err := binary.Read(f, binary.LittleEndian, &h.MClrSize); err != nil {
		return nil, err
	}
	if err := binary.Read(f, binary.LittleEndian, &h.FullSize); err != nil {
		return nil, err
	}
	if err := binary.Read(f, binary.LittleEndian, &h.TypeSize); err != nil {
		return nil, err
	}

	// Read audio rates and flags
	for i := 0; i < 7; i++ {
		if err := binary.Read(f, binary.LittleEndian, &h.AudioRate[i]); err != nil {
			return nil, err
		}
	}

	// Dummy field (4 bytes)
	var dummy uint32
	if err := binary.Read(f, binary.LittleEndian, &dummy); err != nil {
		return nil, err
	}

	for i := 0; i < 7; i++ {
		if err := binary.Read(f, binary.LittleEndian, &h.AudioFlags[i]); err != nil {
			return nil, err
		}
	}

	// Read frame sizes
	h.FrameSizes = make([]uint32, h.Frames)
	for i := uint32(0); i < h.Frames; i++ {
		if err := binary.Read(f, binary.LittleEndian, &h.FrameSizes[i]); err != nil {
			return nil, err
		}
	}

	// Read frame types
	h.FrameTypes = make([]byte, h.Frames)
	if _, err := io.ReadFull(f, h.FrameTypes); err != nil {
		return nil, err
	}

	// Read Huffman trees
	if h.TreesSize > 0 {
		h.HuffmanTrees = make([]byte, h.TreesSize)
		if _, err := io.ReadFull(f, h.HuffmanTrees); err != nil {
			return nil, err
		}
	}

	return h, nil
}

// Info returns a formatted string with video information
func (r *Reader) Info() string {
	info := "Smacker Video File\n"
	info += fmt.Sprintf("  Signature: %c%c%c%c\n",
		byte(r.header.Signature),
		byte(r.header.Signature>>8),
		byte(r.header.Signature>>16),
		byte(r.header.Signature>>24))
	info += fmt.Sprintf("  Resolution: %dx%d\n", r.Width(), r.Height())
	info += fmt.Sprintf("  Frames: %d\n", r.FrameCount())
	info += fmt.Sprintf("  Frame Rate: %.2f fps\n", r.FrameRate())
	info += fmt.Sprintf("  Duration: %.2f seconds\n", r.Duration())
	info += fmt.Sprintf("  Has Audio: %v\n", r.HasAudio())

	if r.HasAudio() {
		info += "  Audio Tracks:\n"
		for i := 0; i < 7; i++ {
			if r.header.AudioFlags[i] != 0 {
				channels := (r.header.AudioFlags[i] >> 16) & 0xFF
				if channels == 0 {
					channels = 1
				}
				info += fmt.Sprintf("    Track %d: %d Hz, %d channels\n",
					i, r.header.AudioRate[i], channels)
			}
		}
	}

	return info
}
