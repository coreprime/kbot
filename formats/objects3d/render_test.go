package objects3d

import "testing"

func TestRenderImageCube(t *testing.T) {
	// A unit cube centred at the origin: 8 verts, 6 quad faces.
	s := int32(1000)
	root := &Object{
		Vertices: []Vertex{
			{-s, -s, -s}, {s, -s, -s}, {s, s, -s}, {-s, s, -s},
			{-s, -s, s}, {s, -s, s}, {s, s, s}, {-s, s, s},
		},
		Primitives: []Primitive{
			{VertexIndices: []int{0, 1, 2, 3}},
			{VertexIndices: []int{4, 5, 6, 7}},
			{VertexIndices: []int{0, 1, 5, 4}},
			{VertexIndices: []int{2, 3, 7, 6}},
			{VertexIndices: []int{1, 2, 6, 5}},
			{VertexIndices: []int{0, 3, 7, 4}},
		},
	}
	m := &Model{Root: root, AllObjects: []*Object{root}}

	opts := DefaultRenderOptions()
	opts.UnitsPerPixel = 1 // fill the frame for the test
	img := m.RenderImage(opts)
	if img.Bounds().Dx() != 128 || img.Bounds().Dy() != 128 {
		t.Fatalf("unexpected size %v", img.Bounds())
	}
	opaque := 0
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] == 0xff {
			opaque++
		}
	}
	// A cube filling ~76% of the frame should cover a large chunk of pixels.
	if opaque < 2000 {
		t.Fatalf("expected the cube to fill many pixels, got %d opaque", opaque)
	}

	b, err := m.RenderPNG(opts)
	if err != nil || len(b) < 8 || string(b[1:4]) != "PNG" {
		t.Fatalf("RenderPNG bad output: err=%v len=%d", err, len(b))
	}
}

func TestRenderEmptyModel(t *testing.T) {
	img := (&Model{}).RenderImage(DefaultRenderOptions())
	if img == nil || img.Bounds().Dx() != 128 {
		t.Fatal("empty model should still return a blank 128px image")
	}
}

func TestRenderSpinAPNG(t *testing.T) {
	s := int32(1000)
	root := &Object{
		Vertices: []Vertex{
			{-s, -s, -s}, {s, -s, -s}, {s, s, -s}, {-s, s, -s},
			{-s, -s, s}, {s, -s, s}, {s, s, s}, {-s, s, s},
		},
		Primitives: []Primitive{
			{VertexIndices: []int{0, 1, 2, 3}}, {VertexIndices: []int{4, 5, 6, 7}},
			{VertexIndices: []int{0, 1, 5, 4}}, {VertexIndices: []int{2, 3, 7, 6}},
			{VertexIndices: []int{1, 2, 6, 5}}, {VertexIndices: []int{0, 3, 7, 4}},
		},
	}
	m := &Model{Root: root, AllObjects: []*Object{root}}
	so := DefaultRenderOptions()
	so.UnitsPerPixel = 1
	b, err := m.RenderSpinAPNG(so, 12, 90)
	if err != nil {
		t.Fatalf("RenderSpinAPNG: %v", err)
	}
	// APNG starts with the PNG signature and must carry an acTL chunk.
	if len(b) < 8 || string(b[1:4]) != "PNG" {
		t.Fatalf("not a PNG/APNG (len=%d)", len(b))
	}
	if !bytesContains(b, []byte("acTL")) || !bytesContains(b, []byte("fcTL")) {
		t.Fatalf("missing APNG animation chunks")
	}
}

func bytesContains(h, n []byte) bool {
	for i := 0; i+len(n) <= len(h); i++ {
		if string(h[i:i+len(n)]) == string(n) {
			return true
		}
	}
	return false
}
