package objects3d

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/png"
)

// encodeAPNG writes a sequence of equally-sized truecolor RGBA frames as an
// animated PNG. Each frame is delayed delayNum/delayDen seconds. Frame image
// data is produced by the stdlib PNG encoder (so compression + filtering match
// a normal PNG); this only wraps it in the APNG chunk structure (acTL / fcTL /
// fdAT). With one frame it degrades to a plain PNG.
func encodeAPNG(frames []*image.RGBA, delayNum, delayDen uint16) ([]byte, error) {
	if len(frames) == 0 {
		return nil, fmt.Errorf("no frames")
	}
	if len(frames) == 1 {
		var buf bytes.Buffer
		if err := png.Encode(&buf, frames[0]); err != nil {
			return nil, err
		}
		return buf.Bytes(), nil
	}

	W := frames[0].Bounds().Dx()
	H := frames[0].Bounds().Dy()

	var out bytes.Buffer
	out.Write([]byte{137, 80, 78, 71, 13, 10, 26, 10}) // PNG signature

	// Frame 0 supplies the IHDR + the default-image IDAT.
	first, err := encodePNGChunks(frames[0])
	if err != nil {
		return nil, err
	}
	writeAPNGChunk(&out, "IHDR", first.ihdr)

	actl := make([]byte, 8)
	binary.BigEndian.PutUint32(actl[0:], uint32(len(frames)))
	binary.BigEndian.PutUint32(actl[4:], 0) // play count: infinite
	writeAPNGChunk(&out, "acTL", actl)

	seq := uint32(0)
	fctl := func(s uint32) {
		b := make([]byte, 26)
		binary.BigEndian.PutUint32(b[0:], s)
		binary.BigEndian.PutUint32(b[4:], uint32(W))
		binary.BigEndian.PutUint32(b[8:], uint32(H))
		// x/y offset: 0 (bytes 12..19)
		binary.BigEndian.PutUint16(b[20:], delayNum)
		binary.BigEndian.PutUint16(b[22:], delayDen)
		b[24] = 1 // dispose_op = APNG_DISPOSE_OP_BACKGROUND
		b[25] = 0 // blend_op   = APNG_BLEND_OP_SOURCE
		writeAPNGChunk(&out, "fcTL", b)
	}

	fctl(seq)
	seq++
	writeAPNGChunk(&out, "IDAT", first.idat)

	for _, fr := range frames[1:] {
		pc, err := encodePNGChunks(fr)
		if err != nil {
			return nil, err
		}
		fctl(seq)
		seq++
		fdat := make([]byte, 4+len(pc.idat))
		binary.BigEndian.PutUint32(fdat[0:], seq)
		seq++
		copy(fdat[4:], pc.idat)
		writeAPNGChunk(&out, "fdAT", fdat)
	}

	writeAPNGChunk(&out, "IEND", nil)
	return out.Bytes(), nil
}

type pngChunks struct {
	ihdr []byte
	idat []byte // concatenated IDAT payload(s)
}

// encodePNGChunks PNG-encodes an image and returns its IHDR bytes + the
// concatenated IDAT payloads.
func encodePNGChunks(img image.Image) (pngChunks, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return pngChunks{}, err
	}
	b := buf.Bytes()
	var pc pngChunks
	i := 8 // skip signature
	for i+8 <= len(b) {
		ln := int(binary.BigEndian.Uint32(b[i:]))
		typ := string(b[i+4 : i+8])
		start := i + 8
		end := start + ln
		if end > len(b) {
			break
		}
		switch typ {
		case "IHDR":
			pc.ihdr = append([]byte(nil), b[start:end]...)
		case "IDAT":
			pc.idat = append(pc.idat, b[start:end]...)
		}
		i = end + 4 // skip CRC
	}
	if pc.ihdr == nil || pc.idat == nil {
		return pngChunks{}, fmt.Errorf("png missing IHDR/IDAT")
	}
	return pc, nil
}

func writeAPNGChunk(w *bytes.Buffer, typ string, data []byte) {
	var l [4]byte
	binary.BigEndian.PutUint32(l[:], uint32(len(data)))
	w.Write(l[:])
	w.WriteString(typ)
	w.Write(data)
	crc := crc32.NewIEEE()
	_, _ = crc.Write([]byte(typ))
	_, _ = crc.Write(data)
	var c [4]byte
	binary.BigEndian.PutUint32(c[:], crc.Sum32())
	w.Write(c[:])
}
