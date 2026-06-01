package assetrender

import (
	"bytes"
	"image/png"
	"testing"

	"github.com/coreprime/kbot/formats/gaf"
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
