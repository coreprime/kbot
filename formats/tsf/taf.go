// Package tsf implements reading, writing, compiling and decompiling of
// Total Annihilation: Kingdoms truecolor animation files.
//
// TA: Kingdoms stores animations in two related forms:
//
//   - TAF: a compiled binary container. It reuses the Total Annihilation GAF
//     layout (version 0x00010100, an entry-pointer table, per-frame info
//     records and a frame list) but stores 16-bit truecolor pixels instead of
//     8-bit palette indices. Each frame carries a pixel-format flag selecting
//     ARGB4444 or ARGB1555.
//
//   - TSF: the human-readable text form of the same data. It is a brace
//     delimited, INI-like document describing an animation as a tree of
//     frames and layers, where each layer references an external image file.
//     The game's GUI loader consumes TSF directly for menu backgrounds.
//
// This package can parse and re-emit both forms byte-for-byte, decompile a
// binary TAF into a TSF document plus extracted layer images, and compile a
// TSF document plus its images back into a binary TAF.
package tsf

import (
	"encoding/binary"
	"fmt"
	"io"
	"strings"
)

// Version is the format version stored in every TA: Kingdoms TAF header. It is
// identical to the Total Annihilation GAF version.
const Version uint32 = 0x00010100

const (
	headerSize        = 12
	sequenceHeaderLen = 40
	frameListItemSize = 8
	frameInfoSize     = 24
	nameFieldLen      = 32
)

// PixelFormat selects the 16-bit encoding used for a frame's pixels.
type PixelFormat uint8

const (
	// FormatARGB4444 packs each pixel as 4 bits of alpha, red, green and blue.
	FormatARGB4444 PixelFormat = 4
	// FormatARGB1555 packs each pixel as 1 bit of alpha and 5 bits each of
	// red, green and blue.
	FormatARGB1555 PixelFormat = 5
)

// String returns a stable textual name for the pixel format, used in TSF
// documents.
func (p PixelFormat) String() string {
	switch p {
	case FormatARGB4444:
		return "ARGB4444"
	case FormatARGB1555:
		return "ARGB1555"
	default:
		return fmt.Sprintf("Unknown(%d)", uint8(p))
	}
}

// parsePixelFormat maps a TSF format name back to its enum value.
func parsePixelFormat(s string) (PixelFormat, error) {
	switch s {
	case "ARGB4444", "4444":
		return FormatARGB4444, nil
	case "ARGB1555", "1555":
		return FormatARGB1555, nil
	default:
		return 0, fmt.Errorf("unknown pixel format %q", s)
	}
}

// ParsePixelFormat maps a case-insensitive format name ("ARGB4444"/"4444" or
// "ARGB1555"/"1555") to its PixelFormat. It is the public entry point used by
// import tooling.
func ParsePixelFormat(s string) (PixelFormat, error) {
	return parsePixelFormat(strings.ToUpper(strings.TrimSpace(s)))
}

// BytesPerPixel is always 2 for the truecolor TAF formats.
func (p PixelFormat) BytesPerPixel() int { return 2 }

// TAF is a parsed TA: Kingdoms animation file. Every retail TAF contains a
// single animation sequence, which this type models directly.
type TAF struct {
	// Name is the sequence name as stored in the 32-byte name field.
	Name string
	// Frames holds the animation frames in playback order.
	Frames []*Frame

	// nameField preserves the raw 32-byte name field. Several retail TAFs
	// carry uninitialized buffer remnants after the terminating null; keeping
	// the exact bytes makes re-serialization byte-identical. It is only
	// honored when rawNameSet is true.
	nameField  [nameFieldLen]byte
	rawNameSet bool
}

// encodedName returns the 32-byte name field to write. It reuses the preserved
// raw field when available, otherwise it encodes Name with null padding.
func (t *TAF) encodedName() [nameFieldLen]byte {
	if t.rawNameSet {
		return t.nameField
	}
	var field [nameFieldLen]byte
	writeName(field[:], t.Name)
	return field
}

// Frame is a single animation frame: a rectangle of 16-bit truecolor pixels
// plus placement and timing metadata.
type Frame struct {
	Width    uint16
	Height   uint16
	OriginX  int16
	OriginY  int16
	Format   PixelFormat
	Duration uint32 // playback duration in game ticks (1/30th second)

	// Pixels holds Width*Height little-endian 16-bit values in the frame's
	// PixelFormat.
	Pixels []byte

	// flagB preserves the frame-info byte at offset 0x0B, observed as either 0
	// or 0xFF across the retail asset set. Its meaning is unconfirmed; it is
	// kept so re-serialization is byte-exact.
	flagB uint8
}

// FlagByte returns the preserved frame-info byte at offset 0x0B (0x00 or 0xFF
// across the retail asset set). Its meaning is unconfirmed; it is exposed for
// inspection and lint tooling.
func (f *Frame) FlagByte() uint8 { return f.flagB }

// ParseTAF parses a TAF file from a byte slice. The format is pointer-based,
// so the whole file must be available.
func ParseTAF(data []byte) (*TAF, error) {
	if len(data) < headerSize+4 {
		return nil, fmt.Errorf("taf: file too small (%d bytes)", len(data))
	}

	version := binary.LittleEndian.Uint32(data[0:])
	if version != Version {
		return nil, fmt.Errorf("taf: unsupported version 0x%08X (expected 0x%08X)", version, Version)
	}
	entryCount := binary.LittleEndian.Uint32(data[4:])
	if entryCount != 1 {
		return nil, fmt.Errorf("taf: expected exactly one sequence, found %d", entryCount)
	}
	if w := binary.LittleEndian.Uint32(data[8:]); w != 0 {
		return nil, fmt.Errorf("taf: unexpected header word 0x%08X", w)
	}

	entryPtr := binary.LittleEndian.Uint32(data[12:])
	taf, err := parseSequence(data, entryPtr)
	if err != nil {
		return nil, err
	}
	return taf, nil
}

// ReadTAF reads and parses a TAF from r.
func ReadTAF(r io.Reader) (*TAF, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("taf: read: %w", err)
	}
	return ParseTAF(data)
}

func parseSequence(data []byte, off uint32) (*TAF, error) {
	if int(off)+sequenceHeaderLen > len(data) {
		return nil, fmt.Errorf("taf: sequence header out of range at 0x%X", off)
	}
	frameCount := binary.LittleEndian.Uint16(data[off:])
	if u := binary.LittleEndian.Uint16(data[off+2:]); u != 1 {
		return nil, fmt.Errorf("taf: unexpected sequence field 0x%04X", u)
	}
	if u := binary.LittleEndian.Uint32(data[off+4:]); u != 0 {
		return nil, fmt.Errorf("taf: unexpected sequence field 0x%08X", u)
	}
	name := nullTerminated(data[off+8 : off+8+nameFieldLen])

	taf := &TAF{Name: name, Frames: make([]*Frame, 0, frameCount), rawNameSet: true}
	copy(taf.nameField[:], data[off+8:off+8+nameFieldLen])

	listOff := off + sequenceHeaderLen
	for i := uint16(0); i < frameCount; i++ {
		itemOff := listOff + uint32(i)*frameListItemSize
		if int(itemOff)+frameListItemSize > len(data) {
			return nil, fmt.Errorf("taf: frame list item %d out of range", i)
		}
		infoPtr := binary.LittleEndian.Uint32(data[itemOff:])
		duration := binary.LittleEndian.Uint32(data[itemOff+4:])

		frame, err := parseFrame(data, infoPtr, duration)
		if err != nil {
			return nil, fmt.Errorf("taf: frame %d: %w", i, err)
		}
		taf.Frames = append(taf.Frames, frame)
	}
	return taf, nil
}

func parseFrame(data []byte, off, duration uint32) (*Frame, error) {
	if int(off)+frameInfoSize > len(data) {
		return nil, fmt.Errorf("frame info out of range at 0x%X", off)
	}
	width := binary.LittleEndian.Uint16(data[off:])
	height := binary.LittleEndian.Uint16(data[off+2:])
	originX := int16(binary.LittleEndian.Uint16(data[off+4:]))
	originY := int16(binary.LittleEndian.Uint16(data[off+6:]))
	transparency := data[off+8]
	format := PixelFormat(data[off+9])
	layerCount := data[off+10]
	flagB := data[off+11]
	unknown2 := binary.LittleEndian.Uint32(data[off+12:])
	pixelPtr := binary.LittleEndian.Uint32(data[off+16:])
	unknown3 := binary.LittleEndian.Uint32(data[off+20:])

	if transparency != 0 || layerCount != 0 || unknown2 != 0 || unknown3 != 0 {
		return nil, fmt.Errorf("unsupported frame metadata (ti=%d layers=%d)", transparency, layerCount)
	}
	if format != FormatARGB4444 && format != FormatARGB1555 {
		return nil, fmt.Errorf("unknown pixel format byte 0x%02X", uint8(format))
	}

	size := int(width) * int(height) * format.BytesPerPixel()
	if int(pixelPtr)+size > len(data) {
		return nil, fmt.Errorf("pixel data out of range at 0x%X (%d bytes)", pixelPtr, size)
	}
	pixels := make([]byte, size)
	copy(pixels, data[pixelPtr:int(pixelPtr)+size])

	return &Frame{
		Width:    width,
		Height:   height,
		OriginX:  originX,
		OriginY:  originY,
		Format:   format,
		Duration: duration,
		Pixels:   pixels,
		flagB:    flagB,
	}, nil
}

// Bytes serializes the TAF back into its binary form. For any TAF produced by
// ParseTAF the result is byte-identical to the original file.
func (t *TAF) Bytes() ([]byte, error) {
	if len(t.Frames) == 0 {
		return nil, fmt.Errorf("taf: cannot serialize an empty animation")
	}
	if len(t.Frames) > 0xFFFF {
		return nil, fmt.Errorf("taf: too many frames (%d)", len(t.Frames))
	}
	for i, f := range t.Frames {
		if err := f.validate(); err != nil {
			return nil, fmt.Errorf("taf: frame %d: %w", i, err)
		}
	}

	frameCount := len(t.Frames)

	// Layout: header | entry pointer | sequence header | frame list |
	// frame info records | pixel data. This mirrors the retail layout exactly.
	entryPtr := uint32(headerSize + 4)
	listOff := entryPtr + sequenceHeaderLen
	infoOff := listOff + uint32(frameCount*frameListItemSize)
	pixOff := infoOff + uint32(frameCount*frameInfoSize)

	total := pixOff
	for _, f := range t.Frames {
		total += uint32(len(f.Pixels))
	}

	out := make([]byte, total)
	binary.LittleEndian.PutUint32(out[0:], Version)
	binary.LittleEndian.PutUint32(out[4:], 1)
	// out[8:12] header word stays zero.
	binary.LittleEndian.PutUint32(out[12:], entryPtr)

	binary.LittleEndian.PutUint16(out[entryPtr:], uint16(frameCount))
	binary.LittleEndian.PutUint16(out[entryPtr+2:], 1)
	// sequence unknown dword at entryPtr+4 stays zero.
	field := t.encodedName()
	copy(out[entryPtr+8:entryPtr+8+nameFieldLen], field[:])

	pixCursor := pixOff
	for i, f := range t.Frames {
		itemOff := listOff + uint32(i)*frameListItemSize
		recOff := infoOff + uint32(i)*frameInfoSize

		binary.LittleEndian.PutUint32(out[itemOff:], recOff)
		binary.LittleEndian.PutUint32(out[itemOff+4:], f.Duration)

		binary.LittleEndian.PutUint16(out[recOff:], f.Width)
		binary.LittleEndian.PutUint16(out[recOff+2:], f.Height)
		binary.LittleEndian.PutUint16(out[recOff+4:], uint16(f.OriginX))
		binary.LittleEndian.PutUint16(out[recOff+6:], uint16(f.OriginY))
		// recOff+8 transparency index stays zero.
		out[recOff+9] = uint8(f.Format)
		// recOff+10 layer count stays zero.
		out[recOff+11] = f.flagB
		// recOff+12 unknown dword stays zero.
		binary.LittleEndian.PutUint32(out[recOff+16:], pixCursor)
		// recOff+20 unknown dword stays zero.

		copy(out[pixCursor:], f.Pixels)
		pixCursor += uint32(len(f.Pixels))
	}

	return out, nil
}

func (f *Frame) validate() error {
	if f.Format != FormatARGB4444 && f.Format != FormatARGB1555 {
		return fmt.Errorf("invalid pixel format 0x%02X", uint8(f.Format))
	}
	want := int(f.Width) * int(f.Height) * f.Format.BytesPerPixel()
	if len(f.Pixels) != want {
		return fmt.Errorf("pixel buffer is %d bytes, expected %d for %dx%d %s",
			len(f.Pixels), want, f.Width, f.Height, f.Format)
	}
	return nil
}

func nullTerminated(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

// writeName copies name into dst (already zero-filled), truncating to leave at
// least one terminating null.
func writeName(dst []byte, name string) {
	n := len(name)
	if n > len(dst)-1 {
		n = len(dst) - 1
	}
	copy(dst[:n], name[:n])
}
