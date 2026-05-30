package tsf

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"image"
	"image/draw"
	_ "image/jpeg" // register JPEG decoder for retail TSF .jpg layers
	"image/png"
	"os"
	"path/filepath"
	"strconv"
)

// ImageResolver loads a layer image referenced by a TSF Filename and returns it
// as a non-premultiplied RGBA image.
type ImageResolver interface {
	Resolve(filename string) (*image.NRGBA, error)
}

// Compile builds a binary TAF from a TSF document, loading each layer image
// through res. The document's first section is treated as the animation.
//
// The per-frame pixel format is taken from a "Format" assignment in the frame
// section (defaulting to ARGB4444), the duration from "Delay", and the
// placement from the layer's "AnchorX"/"AnchorY". A "Flags" assignment, when
// present, restores the preserved frame-info byte so a decompiled animation can
// be recompiled byte-for-byte.
func Compile(doc *Document, res ImageResolver) (*TAF, error) {
	if doc == nil || len(doc.Sections) == 0 {
		return nil, fmt.Errorf("tsf: document has no animation section")
	}
	anim := doc.Sections[0]
	frames := anim.Subsections()
	if len(frames) == 0 {
		return nil, fmt.Errorf("tsf: animation [%s] has no frames", anim.Name)
	}

	taf := &TAF{Name: anim.Name, Frames: make([]*Frame, 0, len(frames))}
	if raw, ok := anim.Get("RawName"); ok {
		decoded, err := hex.DecodeString(raw)
		if err != nil || len(decoded) != nameFieldLen {
			return nil, fmt.Errorf("tsf: invalid RawName %q", raw)
		}
		copy(taf.nameField[:], decoded)
		taf.rawNameSet = true
	}
	for i, fs := range frames {
		frame, err := compileFrame(fs, res)
		if err != nil {
			return nil, fmt.Errorf("tsf: frame %d ([%s]): %w", i, fs.Name, err)
		}
		taf.Frames = append(taf.Frames, frame)
	}
	return taf, nil
}

func compileFrame(fs *Section, res ImageResolver) (*Frame, error) {
	layers := fs.Subsections()
	if len(layers) != 1 {
		return nil, fmt.Errorf("expected exactly one layer, found %d", len(layers))
	}
	layer := layers[0]

	filename, ok := layer.Get("Filename")
	if !ok {
		return nil, fmt.Errorf("layer [%s] has no Filename", layer.Name)
	}
	img, err := res.Resolve(filename)
	if err != nil {
		return nil, fmt.Errorf("resolve %q: %w", filename, err)
	}
	w := img.Rect.Dx()
	h := img.Rect.Dy()
	if w <= 0 || h <= 0 || w > 0xFFFF || h > 0xFFFF {
		return nil, fmt.Errorf("image %q has unusable dimensions %dx%d", filename, w, h)
	}

	format := FormatARGB4444
	if v, ok := fs.Get("Format"); ok {
		format, err = parsePixelFormat(v)
		if err != nil {
			return nil, err
		}
	}

	duration, err := getInt(fs, "Delay", 0)
	if err != nil {
		return nil, err
	}
	originX, err := getInt(layer, "AnchorX", 0)
	if err != nil {
		return nil, err
	}
	originY, err := getInt(layer, "AnchorY", 0)
	if err != nil {
		return nil, err
	}
	flagB, err := getInt(fs, "Flags", 0)
	if err != nil {
		return nil, err
	}

	pixels, err := PixelsFromNRGBA(img, format)
	if err != nil {
		return nil, err
	}

	return &Frame{
		Width:    uint16(w),
		Height:   uint16(h),
		OriginX:  int16(originX),
		OriginY:  int16(originY),
		Format:   format,
		Duration: uint32(duration),
		Pixels:   pixels,
		flagB:    uint8(flagB),
	}, nil
}

func getInt(s *Section, key string, def int) (int, error) {
	v, ok := s.Get(key)
	if !ok {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s = %q: %w", key, v, err)
	}
	return n, nil
}

// MemoryResolver resolves filenames against an in-memory map of PNG bytes.
type MemoryResolver map[string][]byte

// NewMemoryResolver builds a MemoryResolver from decompiled image files.
func NewMemoryResolver(files []ImageFile) MemoryResolver {
	m := make(MemoryResolver, len(files))
	for _, f := range files {
		m[f.Name] = f.Data
	}
	return m
}

// Resolve implements ImageResolver.
func (m MemoryResolver) Resolve(filename string) (*image.NRGBA, error) {
	data, ok := m[filename]
	if !ok {
		return nil, fmt.Errorf("image %q not found", filename)
	}
	return decodeNRGBA(data)
}

// DirResolver resolves filenames against a directory on disk. Lookups are
// case-insensitive to match the game's tolerant filename handling.
type DirResolver string

// Resolve implements ImageResolver.
func (d DirResolver) Resolve(filename string) (*image.NRGBA, error) {
	path := filepath.Join(string(d), filename)
	data, err := os.ReadFile(path)
	if err != nil {
		if alt, ok := findCaseInsensitive(string(d), filename); ok {
			data, err = os.ReadFile(alt)
		}
	}
	if err != nil {
		return nil, err
	}
	return decodeImageFile(filename, data)
}

func findCaseInsensitive(dir, filename string) (string, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if equalFold(e.Name(), filename) {
			return filepath.Join(dir, e.Name()), true
		}
	}
	return "", false
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

// decodeImageFile decodes PNG or JPEG (the formats referenced by retail TSF)
// into a non-premultiplied RGBA image.
func decodeImageFile(filename string, data []byte) (*image.NRGBA, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode %q: %w", filename, err)
	}
	return toNRGBA(img), nil
}

func decodeNRGBA(data []byte) (*image.NRGBA, error) {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	return toNRGBA(img), nil
}

// toNRGBA returns img as *image.NRGBA. When img already is one it is returned
// unchanged, preserving its exact pixel bytes (including color under fully
// transparent pixels).
func toNRGBA(img image.Image) *image.NRGBA {
	if n, ok := img.(*image.NRGBA); ok {
		return n
	}
	b := img.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(out, out.Bounds(), img, b.Min, draw.Src)
	return out
}
