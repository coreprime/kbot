package gaf

import (
	"encoding/binary"
	"fmt"
)

// The roundtrip check compares the header fields the game reads straight
// from the bytes of two GAF files, so that a re-encode which keeps every
// pixel but loses the loop byte or changes a frame's storage is caught.

// rawSequence holds the fields of one sequence header the game reads.
type rawSequence struct {
	Name      string
	LoopFlags uint16 // +2: the game loops the sequence when the low byte is set
	Unknown4  uint32 // +4
	Frames    []rawFrame
}

// rawFrame holds the fields of one frame header the game reads.
type rawFrame struct {
	Duration   uint16 // low 16 bits of the frame-list duration word
	Width      uint16
	Height     uint16
	OriginX    int16
	OriginY    int16
	Key        uint8
	Compressed bool  // +9 non-zero: row-compressed, zero: raw
	LayerCount uint8 // +10
	Blend      uint8 // +11
	Layers     []rawFrame
}

// rawLimits bound the walk over a file that has already been read once, so
// a damaged file cannot make the check loop or allocate without end.
const (
	rawMaxSequences = 32767
	rawMaxFrames    = 1 << 20
)

// readRawFields walks a GAF file's headers the way the game does.
func readRawFields(data []byte) ([]rawSequence, error) {
	u16 := func(off int) (uint16, error) {
		if off < 0 || off+2 > len(data) {
			return 0, fmt.Errorf("offset 0x%X past end of file", off)
		}
		return binary.LittleEndian.Uint16(data[off:]), nil
	}
	u32 := func(off int) (uint32, error) {
		if off < 0 || off+4 > len(data) {
			return 0, fmt.Errorf("offset 0x%X past end of file", off)
		}
		return binary.LittleEndian.Uint32(data[off:]), nil
	}

	countWord, err := u32(4)
	if err != nil {
		return nil, err
	}
	count := int(int16(countWord & 0xFFFF))
	if count <= 0 {
		return nil, nil
	}
	if count > rawMaxSequences {
		count = rawMaxSequences
	}

	frames := 0
	var readFrame func(off int, layer bool) (rawFrame, error)
	readFrame = func(off int, layer bool) (rawFrame, error) {
		frames++
		if frames > rawMaxFrames {
			return rawFrame{}, fmt.Errorf("more than %d frame headers", rawMaxFrames)
		}
		if off < 0 || off+24 > len(data) {
			return rawFrame{}, fmt.Errorf("frame header at 0x%X past end of file", off)
		}
		h := data[off : off+24]
		f := rawFrame{
			Width:      binary.LittleEndian.Uint16(h[0:]),
			Height:     binary.LittleEndian.Uint16(h[2:]),
			OriginX:    int16(binary.LittleEndian.Uint16(h[4:])),
			OriginY:    int16(binary.LittleEndian.Uint16(h[6:])),
			Key:        h[8],
			Compressed: h[9] != 0,
			LayerCount: h[10],
			Blend:      h[11],
		}
		if f.LayerCount == 0 || layer {
			return f, nil
		}
		table := int(binary.LittleEndian.Uint32(h[16:]))
		for i := 0; i < int(f.LayerCount); i++ {
			p, err := u32(table + 4*i)
			if err != nil {
				return f, fmt.Errorf("layer %d: %w", i, err)
			}
			if int(p) == off {
				continue // a frame listing itself as a layer is not drawn
			}
			lf, err := readFrame(int(p), true)
			if err != nil {
				return f, fmt.Errorf("layer %d: %w", i, err)
			}
			f.Layers = append(f.Layers, lf)
		}
		return f, nil
	}

	seqs := make([]rawSequence, 0, count)
	for si := 0; si < count; si++ {
		p, err := u32(12 + 4*si)
		if err != nil {
			return nil, fmt.Errorf("sequence %d: %w", si, err)
		}
		off := int(p)
		if off < 0 || off+40 > len(data) {
			return nil, fmt.Errorf("sequence %d: header at 0x%X past end of file", si, off)
		}
		frameCount, _ := u16(off)
		seq := rawSequence{
			LoopFlags: binary.LittleEndian.Uint16(data[off+2:]),
			Unknown4:  binary.LittleEndian.Uint32(data[off+4:]),
			Name:      cString(data[off+8 : off+40]),
		}
		for fi := 0; fi < int(frameCount); fi++ {
			item := off + 40 + 8*fi
			ptr, err := u32(item)
			if err != nil {
				return nil, fmt.Errorf("sequence %d frame %d: %w", si, fi, err)
			}
			dur, err := u32(item + 4)
			if err != nil {
				return nil, fmt.Errorf("sequence %d frame %d: %w", si, fi, err)
			}
			f, err := readFrame(int(ptr), false)
			if err != nil {
				return nil, fmt.Errorf("sequence %d frame %d: %w", si, fi, err)
			}
			f.Duration = uint16(dur)
			seq.Frames = append(seq.Frames, f)
		}
		seqs = append(seqs, seq)
	}
	return seqs, nil
}

func cString(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

// rawCompareOptions selects what compareRawFields checks.
type rawCompareOptions struct {
	// Flattened accepts composite frames written as simple frames: their
	// layer count and layers are not compared. The dump folder format
	// stores each frame as one image, so a dump/build cycle flattens them.
	Flattened bool
}

// compareRawFields returns "" when b keeps every header field of a that the
// game reads (the sequence loop and +4 words, and each frame's size, origin,
// key, storage, layer count, +11 byte and duration), otherwise a
// description of the first difference.
func compareRawFields(a, b []rawSequence, opts rawCompareOptions) string {
	if len(a) != len(b) {
		return fmt.Sprintf("sequence count %d → %d", len(a), len(b))
	}
	for i := range a {
		sa, sb := a[i], b[i]
		switch {
		case sa.Name != sb.Name:
			return fmt.Sprintf("seq[%d] name %q → %q", i, sa.Name, sb.Name)
		case sa.LoopFlags != sb.LoopFlags:
			return fmt.Sprintf("seq[%d] loop word (+2) 0x%04X → 0x%04X", i, sa.LoopFlags, sb.LoopFlags)
		case sa.Unknown4 != sb.Unknown4:
			return fmt.Sprintf("seq[%d] +4 word 0x%08X → 0x%08X", i, sa.Unknown4, sb.Unknown4)
		case len(sa.Frames) != len(sb.Frames):
			return fmt.Sprintf("seq[%d] frame count %d → %d", i, len(sa.Frames), len(sb.Frames))
		}
		for fi := range sa.Frames {
			fa, fb := sa.Frames[fi], sb.Frames[fi]
			if fa.Duration != fb.Duration {
				return fmt.Sprintf("seq[%d] frame[%d] duration %d → %d ticks", i, fi, fa.Duration, fb.Duration)
			}
			if d := compareRawFrame(fa, fb, opts); d != "" {
				return fmt.Sprintf("seq[%d] frame[%d] %s", i, fi, d)
			}
		}
	}
	return ""
}

func compareRawFrame(a, b rawFrame, opts rawCompareOptions) string {
	switch {
	case a.Width != b.Width || a.Height != b.Height:
		return fmt.Sprintf("size %dx%d → %dx%d", a.Width, a.Height, b.Width, b.Height)
	case a.OriginX != b.OriginX || a.OriginY != b.OriginY:
		return fmt.Sprintf("origin (%d,%d) → (%d,%d)", a.OriginX, a.OriginY, b.OriginX, b.OriginY)
	case a.Key != b.Key:
		return fmt.Sprintf("key %d → %d", a.Key, b.Key)
	case a.Compressed != b.Compressed:
		return fmt.Sprintf("storage %s → %s", storageWord(a.Compressed), storageWord(b.Compressed))
	case a.Blend != b.Blend:
		return fmt.Sprintf("+11 byte %d → %d", a.Blend, b.Blend)
	}
	if opts.Flattened && a.LayerCount > 0 {
		return ""
	}
	if a.LayerCount != b.LayerCount || len(a.Layers) != len(b.Layers) {
		return fmt.Sprintf("layer count (+10) %d → %d", a.LayerCount, b.LayerCount)
	}
	for li := range a.Layers {
		if d := compareRawFrame(a.Layers[li], b.Layers[li], opts); d != "" {
			return fmt.Sprintf("layer[%d] %s", li, d)
		}
	}
	return ""
}

func storageWord(compressed bool) string {
	if compressed {
		return "compressed"
	}
	return "raw"
}

// countComposites returns how many top-level frames are composites.
func countComposites(seqs []rawSequence) int {
	n := 0
	for _, s := range seqs {
		for _, f := range s.Frames {
			if f.LayerCount > 0 {
				n++
			}
		}
	}
	return n
}
