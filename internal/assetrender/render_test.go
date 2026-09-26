package assetrender

import (
	"bytes"
	"image/png"
	"testing"

	"github.com/coreprime/kbot-io/formats/gaf"
)

// buildGAF encodes a tiny two-frame sequence so the render paths have real
// bytes to chew on without depending on game assets.
func buildGAF(t *testing.T) []byte {
	t.Helper()
	seq := &gaf.Sequence{
		Name: "stand",
		Frames: []*gaf.Frame{
			{Width: 2, Height: 2, TransparencyIndex: 9, Duration: 10, Pixels: []byte{1, 2, 3, 9}},
			{Width: 2, Height: 2, TransparencyIndex: 9, Duration: 10, Pixels: []byte{9, 3, 2, 1}},
		},
	}
	var buf bytes.Buffer
	if err := gaf.WriteGAF(&buf, []*gaf.Sequence{seq}); err != nil {
		t.Fatalf("WriteGAF: %v", err)
	}
	return buf.Bytes()
}

func TestRenderGAFFrameFormats(t *testing.T) {
	r := newTestRenderer(t)
	data := buildGAF(t)

	cases := []struct {
		format string
		wantCT string
		decode bool // PNG-decodable result
	}{
		{"png", "image/png", true},
		{"jpg", "image/jpeg", false},
		{"gif", "image/gif", false},
		{"apng", "image/apng", true},
	}
	for _, c := range cases {
		out, err := r.Render("anims/test.gaf", data, RenderRequest{Sequence: 0, Frame: 0, Format: c.format})
		if err != nil {
			t.Fatalf("render frame %s: %v", c.format, err)
		}
		if out.ContentType != c.wantCT {
			t.Errorf("%s content-type = %q, want %q", c.format, out.ContentType, c.wantCT)
		}
		if len(out.Body) == 0 {
			t.Errorf("%s produced empty body", c.format)
		}
		if c.decode {
			if _, err := png.Decode(bytes.NewReader(out.Body)); err != nil {
				t.Errorf("%s body is not a valid PNG: %v", c.format, err)
			}
		}
	}
}

func TestRenderGAFWholeSequence(t *testing.T) {
	r := newTestRenderer(t)
	data := buildGAF(t)

	apng, err := r.Render("anims/test.gaf", data, RenderRequest{Sequence: 0, Frame: -1, Format: "apng"})
	if err != nil {
		t.Fatalf("render apng sequence: %v", err)
	}
	if apng.ContentType != "image/apng" || len(apng.Body) == 0 {
		t.Errorf("apng sequence wrong: ct=%q len=%d", apng.ContentType, len(apng.Body))
	}

	gif, err := r.Render("anims/test.gaf", data, RenderRequest{Sequence: 0, Frame: -1, Format: "gif"})
	if err != nil {
		t.Fatalf("render gif sequence: %v", err)
	}
	if gif.ContentType != "image/gif" || len(gif.Body) == 0 {
		t.Errorf("gif sequence wrong: ct=%q len=%d", gif.ContentType, len(gif.Body))
	}
}

func TestRenderGAFBySequenceName(t *testing.T) {
	r := newTestRenderer(t)
	data := buildGAF(t)

	if _, err := r.Render("anims/test.gaf", data, RenderRequest{Sequence: -1, SequenceName: "stand", Frame: 0, Format: "png"}); err != nil {
		t.Errorf("render by name: %v", err)
	}
	if _, err := r.Render("anims/test.gaf", data, RenderRequest{Sequence: -1, SequenceName: "missing", Frame: 0, Format: "png"}); err == nil {
		t.Error("expected error for unknown sequence name")
	}
}

// TestRenderCachingRoundtrips a render twice; the second call must hit the disk
// cache and return identical bytes.
func TestRenderCaching(t *testing.T) {
	r := newTestRenderer(t)
	data := buildGAF(t)
	req := RenderRequest{Sequence: 0, Frame: 0, Format: "png"}

	first, err := r.Render("anims/test.gaf", data, req)
	if err != nil {
		t.Fatalf("first render: %v", err)
	}
	second, err := r.Render("anims/test.gaf", data, req)
	if err != nil {
		t.Fatalf("second render: %v", err)
	}
	if !bytes.Equal(first.Body, second.Body) {
		t.Error("cached render differs from fresh render")
	}
}

func TestRenderPALSwatch(t *testing.T) {
	r := newTestRenderer(t)
	// A .pal is 256 RGBA entries; a ramp is enough to exercise the swatch.
	data := make([]byte, 256*4)
	for i := 0; i < 256; i++ {
		data[i*4] = byte(i)
		data[i*4+1] = byte(255 - i)
		data[i*4+2] = byte(i / 2)
		data[i*4+3] = 255
	}
	out, err := r.Render("palettes/test.pal", data, RenderRequest{Format: "png"})
	if err != nil {
		t.Fatalf("render pal: %v", err)
	}
	if out.ContentType != "image/png" {
		t.Errorf("content-type = %q, want image/png", out.ContentType)
	}
	if _, err := png.Decode(bytes.NewReader(out.Body)); err != nil {
		t.Errorf("swatch is not a valid PNG: %v", err)
	}
}

func TestRenderUnsupportedExtension(t *testing.T) {
	r := newTestRenderer(t)
	if _, err := r.Render("docs/readme.txt", []byte("hi"), RenderRequest{Format: "png"}); err == nil {
		t.Error("expected error rendering an unsupported extension")
	}
}

// TestRenderGAFUsesGameRuleByDefault checks the explorer's default GAF
// renders: palette index 0 is opaque black, only the key is transparent,
// and an animation plays once when its loop byte is 0, with each frame
// shown for its ticks/30 s.
func TestRenderGAFUsesGameRuleByDefault(t *testing.T) {
	seq := &gaf.Sequence{Name: "burn", Frames: []*gaf.Frame{
		{Width: 2, Height: 1, TransparencyIndex: 9, Duration: 2, Storage: gaf.StorageRaw, Pixels: []byte{0, 9}},
		{Width: 2, Height: 1, TransparencyIndex: 9, Duration: 3, Storage: gaf.StorageRaw, Pixels: []byte{9, 0}},
	}}
	var buf bytes.Buffer
	if err := gaf.WriteGAF(&buf, []*gaf.Sequence{seq}); err != nil {
		t.Fatal(err)
	}
	r := newTestRenderer(t)

	out, err := r.Render("anims/fx.gaf", buf.Bytes(), RenderRequest{Format: "png", Sequence: 0, Frame: 0})
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(out.Body))
	if err != nil {
		t.Fatal(err)
	}
	if r, g, b, a := img.At(0, 0).RGBA(); a != 0xffff || r|g|b != 0 {
		t.Errorf("index 0 pixel = (%d,%d,%d,%d), want opaque black", r, g, b, a)
	}
	if _, _, _, a := img.At(1, 0).RGBA(); a != 0 {
		t.Error("key pixel is drawn")
	}

	out, err = r.Render("anims/fx.gaf", buf.Bytes(), RenderRequest{Format: "apng", Sequence: 0, Frame: -1})
	if err != nil {
		t.Fatal(err)
	}
	plays, delays := -1, [][2]uint16{}
	data := out.Body
	for p := 8; p+8 <= len(data); {
		n := int(uint32(data[p])<<24 | uint32(data[p+1])<<16 | uint32(data[p+2])<<8 | uint32(data[p+3]))
		body := data[p+8 : p+8+n]
		switch string(data[p+4 : p+8]) {
		case "acTL":
			plays = int(uint32(body[4])<<24 | uint32(body[5])<<16 | uint32(body[6])<<8 | uint32(body[7]))
		case "fcTL":
			delays = append(delays, [2]uint16{uint16(body[20])<<8 | uint16(body[21]), uint16(body[22])<<8 | uint16(body[23])})
		}
		p += 12 + n
	}
	if plays != 1 {
		t.Errorf("num_plays = %d, want 1: the game plays a sequence with loop byte 0 once", plays)
	}
	if len(delays) != 2 || delays[0] != [2]uint16{2, 30} || delays[1] != [2]uint16{3, 30} {
		t.Errorf("frame delays = %v, want [2/30 3/30]", delays)
	}
}

// TestDescribePCXReportsGameCompat checks the compatibility report behind
// the asset explorer's PCX badge.
func TestDescribePCXReportsGameCompat(t *testing.T) {
	// 3x1 image whose BytesPerLine is padded to 4: the game ignores
	// BytesPerLine and reads 3 bytes per row.
	data := make([]byte, 128)
	data[0], data[1], data[2], data[3] = 0x0A, 5, 1, 8
	data[8] = 2 // XMax
	data[65], data[66] = 1, 4
	data = append(data, 0xC1, 1, 0xC1, 2, 0xC1, 3, 0xC1, 0, 0x0C)
	data = append(data, make([]byte, 768)...)

	r := newTestRenderer(t)
	out, ok := r.Describe("bitmaps/pad.pcx", data)
	if !ok {
		t.Fatal("PCX not described")
	}
	c, ok := out["gameCompat"].(pcxCompat)
	if !ok {
		t.Fatalf("gameCompat = %#v", out["gameCompat"])
	}
	if !c.Loads || c.OK || len(c.Issues) == 0 || c.Issues[0].Code != "bytes-per-line" {
		t.Errorf("gameCompat = %+v, want a bytes-per-line warning on a loadable file", c)
	}
}
