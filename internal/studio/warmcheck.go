package studio

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"path"
	"strings"

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/smacker"
)

// warmSizeCheck compares the counts and offsets a file's header promises with
// the file's size before the background warm-up parses it. A header that
// needs more bytes than the file holds is damaged or crafted (a GAF claiming
// 32767 sequences in 16 bytes, a 65536x65536 section); such a file is left to
// on-demand rendering, where the user asked for it and sees the error, rather
// than costing the warm-up memory and time. It reads only the header and, for
// a GAF, the sequence pointer table.
func warmSizeCheck(fileType, vpath string, data []byte) error {
	size := uint64(len(data))
	u32 := func(off int) uint64 {
		if off+4 > len(data) {
			return 0
		}
		return uint64(binary.LittleEndian.Uint32(data[off:]))
	}
	fits := func(what string, off, n uint64) error {
		if off > size || n > size-off {
			return fmt.Errorf("%s (%d bytes at 0x%X) runs past the end of the %d-byte file", what, n, off, size)
		}
		return nil
	}

	switch fileType {
	case "gaf":
		if size < 12 {
			return fmt.Errorf("%d bytes is shorter than a GAF header", size)
		}
		n := uint64(gaf.Header{SequenceCount: uint32(u32(4))}.EffectiveSequenceCount())
		if err := fits("sequence table", 12, n*4); err != nil {
			return err
		}
		for i := uint64(0); i < n; i++ {
			if err := fits(fmt.Sprintf("sequence %d header", i), u32(12+int(i)*4), 40); err != nil {
				return err
			}
		}
	case "sct":
		if size < 28 {
			return fmt.Errorf("%d bytes is shorter than an SCT header", size)
		}
		version, tiles, ptrTiles, w, h, ptrData := u32(0), u32(8), u32(12), u32(16), u32(20), u32(24)
		entry := uint64(4)
		switch version {
		case 2:
			entry = 8
		case 3:
		default:
			return fmt.Errorf("SCT version %d", version)
		}
		cells := w * h
		if err := fits("tile graphics", ptrTiles, tiles*32*32); err != nil {
			return err
		}
		if err := fits("tile map and height table", ptrData, cells*2+cells*4*entry); err != nil {
			return err
		}
	case "tnt":
		if size < 64 {
			return fmt.Errorf("%d bytes is shorter than a TNT header", size)
		}
		version, w, h := u32(0), u32(4), u32(8)
		switch version {
		case 0x2000, 0x1020:
			if err := fits("attribute grid", u32(16), w*h*4); err != nil {
				return err
			}
			if err := fits("tile graphics", u32(20), u32(24)*32*32); err != nil {
				return err
			}
		case 0x4000:
			if err := fits("height map", u32(16), w*h); err != nil {
				return err
			}
		default:
			return fmt.Errorf("TNT version 0x%X", version)
		}
	case "video":
		ext := strings.ToLower(path.Ext(vpath))
		if ext != ".smk" && ext != ".zrb" {
			return nil
		}
		r, err := smacker.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return err
		}
		return r.Validate(smacker.DefaultLimits())
	}
	return nil
}
