package tsf

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"image/png"
	"strconv"
	"strings"
)

// ImageFile is a layer image produced when decompiling a TAF. Name is the
// filename referenced from the TSF document; Data is the encoded PNG.
type ImageFile struct {
	Name string
	Data []byte
}

// Decompile converts a binary TAF into an equivalent TSF document plus one PNG
// per frame. The document records every detail needed to recompile the exact
// original bytes: per-frame pixel format, placement, duration and the
// preserved frame flag. Compiling the returned document with an ImageResolver
// backed by the returned images reproduces the original TAF byte-for-byte.
//
// baseName is used to derive image filenames (baseName_<frame>.png). When
// empty, the TAF's sequence name is used, falling back to "frame".
func Decompile(t *TAF, baseName string) (*Document, []ImageFile, error) {
	if len(t.Frames) == 0 {
		return nil, nil, fmt.Errorf("tsf: cannot decompile an empty animation")
	}
	base := sanitizeBase(baseName)
	if base == "" {
		base = sanitizeBase(t.Name)
	}
	if base == "" {
		base = "frame"
	}

	anim := &Section{Name: t.Name}
	anim.Body = append(anim.Body, &Assignment{Key: "Looping", Value: "0"})

	// Preserve the exact name field when it carries buffer remnants past the
	// terminating null, so a recompile reproduces the original bytes.
	if t.rawNameSet {
		var canonical [nameFieldLen]byte
		writeName(canonical[:], t.Name)
		if t.nameField != canonical {
			anim.Body = append(anim.Body, &Assignment{
				Key:   "RawName",
				Value: hex.EncodeToString(t.nameField[:]),
			})
		}
	}

	images := make([]ImageFile, 0, len(t.Frames))
	for i, f := range t.Frames {
		img, err := f.ToNRGBA()
		if err != nil {
			return nil, nil, fmt.Errorf("tsf: frame %d: %w", i, err)
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			return nil, nil, fmt.Errorf("tsf: frame %d: encode png: %w", i, err)
		}
		filename := fmt.Sprintf("%s_%d.png", base, i)
		images = append(images, ImageFile{Name: filename, Data: buf.Bytes()})

		frame := &Section{Name: fmt.Sprintf("Frame%d", i)}
		frame.Body = append(frame.Body,
			&Assignment{Key: "Delay", Value: strconv.FormatUint(uint64(f.Duration), 10)},
			&Assignment{Key: "Format", Value: f.Format.String()},
		)
		if f.flagB != 0 {
			frame.Body = append(frame.Body, &Assignment{Key: "Flags", Value: strconv.FormatUint(uint64(f.flagB), 10)})
		}

		layer := &Section{Name: "Layer0"}
		layer.Body = append(layer.Body,
			&Assignment{Key: "AnchorX", Value: strconv.FormatInt(int64(f.OriginX), 10)},
			&Assignment{Key: "AnchorY", Value: strconv.FormatInt(int64(f.OriginY), 10)},
			&Assignment{Key: "Filename", Value: filename},
		)
		frame.Body = append(frame.Body, layer)
		anim.Body = append(anim.Body, frame)
	}

	doc := &Document{
		Leading:    []string{"/* TA: Kingdoms animation decompiled by kbot. */", ""},
		Sections:   []*Section{anim},
		LineEnding: "\r\n",
	}
	return doc, images, nil
}

// sanitizeBase reduces a sequence name to a filesystem-friendly base.
func sanitizeBase(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_', r == '-', r == '.':
			b.WriteRune(r)
		case r == ' ':
			b.WriteByte('_')
		}
	}
	return b.String()
}
