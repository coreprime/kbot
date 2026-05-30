package tsf

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"testing"
)

// makeTestFrame builds a frame of the given size whose pixels vary by position
// so encode/decode paths exercise real values.
func makeTestFrame(w, h int, format PixelFormat) *Frame {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{
				R: uint8(x * 16),
				G: uint8(y * 16),
				B: 0x80,
				A: 0xFF,
			})
		}
	}
	pixels, _ := PixelsFromNRGBA(img, format)
	return &Frame{
		Width:    uint16(w),
		Height:   uint16(h),
		Format:   format,
		Duration: 6,
		Pixels:   pixels,
	}
}

func makeTestTAF(frames int, w, h int) *TAF {
	t := &TAF{Name: "test"}
	for i := 0; i < frames; i++ {
		t.Frames = append(t.Frames, makeTestFrame(w, h, FormatARGB4444))
	}
	return t
}

func TestRenderSheetDimensions(t *testing.T) {
	taf := makeTestTAF(3, 4, 4)
	sheet, err := taf.RenderSheet(2, color.NRGBA{0, 0, 0, 0})
	if err != nil {
		t.Fatalf("RenderSheet: %v", err)
	}
	// 3 frames, 2 cols → 2 rows; cell 4x4 → sheet 8x8.
	if got := sheet.Bounds().Dx(); got != 8 {
		t.Errorf("sheet width: got %d want 8", got)
	}
	if got := sheet.Bounds().Dy(); got != 8 {
		t.Errorf("sheet height: got %d want 8", got)
	}
}

func TestToGIFFrameCount(t *testing.T) {
	taf := makeTestTAF(4, 8, 8)
	g, err := taf.ToGIF()
	if err != nil {
		t.Fatalf("ToGIF: %v", err)
	}
	if len(g.Image) != 4 {
		t.Fatalf("gif frames: got %d want 4", len(g.Image))
	}
	if len(g.Delay) != len(g.Image) {
		t.Fatalf("delay count %d != image count %d", len(g.Delay), len(g.Image))
	}
	// Must encode cleanly.
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		t.Fatalf("encode gif: %v", err)
	}
	if _, err := gif.DecodeAll(bytes.NewReader(buf.Bytes())); err != nil {
		t.Fatalf("decode gif: %v", err)
	}
}

func TestToAPNGEncodes(t *testing.T) {
	taf := makeTestTAF(3, 8, 8)
	var buf bytes.Buffer
	if err := taf.ToAPNG(&buf); err != nil {
		t.Fatalf("ToAPNG: %v", err)
	}
	// First frame must be a valid PNG that image/png can read.
	img, err := png.Decode(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("decode apng first frame: %v", err)
	}
	if img.Bounds().Dx() != 8 || img.Bounds().Dy() != 8 {
		t.Fatalf("apng dims: got %v want 8x8", img.Bounds())
	}
}

func TestSingleFrameAPNGIsPNG(t *testing.T) {
	taf := makeTestTAF(1, 6, 6)
	var buf bytes.Buffer
	if err := taf.ToAPNG(&buf); err != nil {
		t.Fatalf("ToAPNG: %v", err)
	}
	if !bytes.Equal(buf.Bytes()[:8], pngSignature) {
		t.Fatalf("missing PNG signature")
	}
	if bytes.Contains(buf.Bytes(), []byte("acTL")) {
		t.Fatalf("single-frame output should not be animated")
	}
}

func TestFromSheetRoundTripsFrameData(t *testing.T) {
	taf := makeTestTAF(4, 4, 4)
	sheet, err := taf.RenderSheet(2, nil)
	if err != nil {
		t.Fatalf("RenderSheet: %v", err)
	}
	got, err := FromSheet(sheet, 4, 4, 4, FormatARGB4444, "rt", 6)
	if err != nil {
		t.Fatalf("FromSheet: %v", err)
	}
	if len(got.Frames) != 4 {
		t.Fatalf("frame count: got %d want 4", len(got.Frames))
	}
	for i := range got.Frames {
		if !bytes.Equal(got.Frames[i].Pixels, taf.Frames[i].Pixels) {
			t.Fatalf("frame %d pixels differ after sheet round-trip", i)
		}
	}
}

func TestFromGIFFrameCount(t *testing.T) {
	pal := color.Palette{color.Transparent, color.NRGBA{255, 0, 0, 255}, color.NRGBA{0, 255, 0, 255}}
	g := &gif.GIF{Config: image.Config{Width: 4, Height: 4}}
	for i := 0; i < 3; i++ {
		p := image.NewPaletted(image.Rect(0, 0, 4, 4), pal)
		for j := range p.Pix {
			p.Pix[j] = uint8(1 + (i % 2))
		}
		g.Image = append(g.Image, p)
		g.Delay = append(g.Delay, 10)
		g.Disposal = append(g.Disposal, gif.DisposalNone)
	}
	taf, err := FromGIF(g, FormatARGB4444, "fromgif")
	if err != nil {
		t.Fatalf("FromGIF: %v", err)
	}
	if len(taf.Frames) != 3 {
		t.Fatalf("frame count: got %d want 3", len(taf.Frames))
	}
	if taf.Frames[0].Width != 4 || taf.Frames[0].Height != 4 {
		t.Fatalf("frame dims: got %dx%d want 4x4", taf.Frames[0].Width, taf.Frames[0].Height)
	}
	// 10 centiseconds → 3 ticks.
	if taf.Frames[0].Duration != 3 {
		t.Fatalf("duration: got %d want 3 ticks", taf.Frames[0].Duration)
	}
}

func TestLintCleanFrame(t *testing.T) {
	taf := makeTestTAF(2, 4, 4)
	if d := taf.Lint(); len(d) != 0 {
		t.Fatalf("expected clean lint, got %v", d)
	}
}

func TestLintCatchesBadPixelBuffer(t *testing.T) {
	taf := makeTestTAF(1, 4, 4)
	taf.Frames[0].Pixels = taf.Frames[0].Pixels[:4] // truncate
	diags := taf.Lint()
	found := false
	for _, d := range diags {
		if d.Level == LintError {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected an error diagnostic for truncated pixels, got %v", diags)
	}
}
