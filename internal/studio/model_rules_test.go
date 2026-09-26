package studio

import (
	"encoding/binary"
	"testing"

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/objects3d"
)

// tdoPrim and tdoObj describe a 3DO model for build3DO.
type tdoPrim struct {
	color, flags int32
	texture      string
	idx          []uint16
}

type tdoObj struct {
	name     string
	sel      int32
	off      [3]int32
	verts    [][3]int32
	prims    []tdoPrim
	children []*tdoObj
}

type tdoWriter struct{ buf []byte }

func (w *tdoWriter) put(at int, v int32) { binary.LittleEndian.PutUint32(w.buf[at:], uint32(v)) }

func (w *tdoWriter) str(s string) int32 {
	at := len(w.buf)
	w.buf = append(append(w.buf, s...), 0)
	return int32(at)
}

// chain writes objects linked as siblings and returns the first header's
// offset.
func (w *tdoWriter) chain(objs []*tdoObj) int32 {
	offs := make([]int32, len(objs))
	for i, o := range objs {
		offs[i] = w.object(o)
	}
	for i := 0; i+1 < len(offs); i++ {
		w.put(int(offs[i])+11*4, offs[i+1])
	}
	return offs[0]
}

func (w *tdoWriter) object(o *tdoObj) int32 {
	at := len(w.buf)
	w.buf = append(w.buf, make([]byte, 52)...)
	w.put(at, 1)
	w.put(at+4, int32(len(o.verts)))
	w.put(at+8, int32(len(o.prims)))
	w.put(at+12, o.sel)
	for i, v := range o.off {
		w.put(at+16+4*i, v)
	}
	w.put(at+28, w.str(o.name))
	if len(o.verts) > 0 {
		w.put(at+36, int32(len(w.buf)))
		for _, v := range o.verts {
			for _, c := range v {
				w.buf = binary.LittleEndian.AppendUint32(w.buf, uint32(c))
			}
		}
	}
	if len(o.prims) > 0 {
		primAt := len(w.buf)
		w.put(at+40, int32(primAt))
		w.buf = append(w.buf, make([]byte, 32*len(o.prims))...)
		for i, p := range o.prims {
			rec := primAt + 32*i
			w.put(rec, p.color)
			w.put(rec+4, int32(len(p.idx)))
			w.put(rec+12, int32(len(w.buf)))
			for _, ix := range p.idx {
				w.buf = binary.LittleEndian.AppendUint16(w.buf, ix)
			}
			if p.texture != "" {
				w.put(rec+16, w.str(p.texture))
			}
			w.put(rec+28, p.flags)
		}
	}
	if len(o.children) > 0 {
		w.put(at+48, w.chain(o.children))
	}
	return int32(at)
}

func build3DO(root *tdoObj, siblings ...*tdoObj) []byte {
	w := &tdoWriter{}
	w.chain(append([]*tdoObj{root}, siblings...))
	return w.buf
}

func quadVerts() [][3]int32 {
	return [][3]int32{{0, 0, 0}, {65536, 0, 0}, {65536, 0, 65536}, {0, 0, 65536}}
}

// modelSession mounts a model and a texture GAF holding the sequence "tex1".
func modelSession(t *testing.T, game string, model []byte) *Session {
	t.Helper()
	tex := gafBytes(t, &gaf.Sequence{Name: "tex1", LoopFlags: 1, Frames: []*gaf.Frame{{
		Width: 1, Height: 1, Storage: gaf.StorageRaw, Pixels: []byte{3},
	}}})
	return looseSession(t, game, map[string][]byte{
		"objects3d/testunit.3do": model,
		"textures/tex.gaf":       tex,
	})
}

// TestModelJSONFollowsTheGame checks the unit viewer's model JSON: root
// siblings are carried, faces are styled by the game's rules, faces the game
// never draws are left out, and the selection primitive is flagged hidden.
func TestModelJSONFollowsTheGame(t *testing.T) {
	quad := []uint16{0, 1, 2, 3}
	root := &tdoObj{
		name: "base", sel: 5, off: [3]int32{65536, 0, 0}, verts: quadVerts(),
		prims: []tdoPrim{
			{texture: "TEX1", idx: quad},              // 0: textured (name resolves case-insensitively)
			{texture: "nosuch", idx: quad},            // 1: missing texture: filled with 0xd1
			{color: 0x1234, flags: 0x3, idx: quad},    // 2: coloured by bit 0; colour is the low byte
			{color: 7, flags: 0x2, idx: quad},         // 3: bit 0 clear, no texture: not drawn
			{texture: "tex1", idx: []uint16{0, 1, 2}}, // 4: textured triangle: not drawn in TA
			{color: 9, flags: 1, idx: quad},           // 5: selection primitive: hidden
			{color: 4, flags: 1, idx: []uint16{0, 1}}, // 6: a line: not drawn
		},
		children: []*tdoObj{{name: "turret", off: [3]int32{0, 65536, 0}}},
	}
	sibling := &tdoObj{
		name: "floater", off: [3]int32{5 * 65536, 0, 0}, verts: quadVerts(),
		prims:    []tdoPrim{{color: 1, flags: 1, idx: quad}},
		children: []*tdoObj{{name: "floatkid", off: [3]int32{65536, 0, 0}}},
	}
	sess := modelSession(t, "totala", build3DO(root, sibling))

	out, err := sess.buildModelJSON(modelEntry{Name: "testunit", Path: "objects3d/testunit.3do"}, false)
	if err != nil {
		t.Fatal(err)
	}
	prims := out.Root.Primitives
	if len(prims) != 4 {
		t.Fatalf("root has %d primitives, want 4 (textured, missing, coloured, hidden): %+v", len(prims), prims)
	}
	if prims[0].Style != "textured" || prims[0].Texture != "TEX1" {
		t.Errorf("prim 0 = %+v, want textured TEX1", prims[0])
	}
	pal := sess.palettes().ModelColorPalette("testunit")
	wantRGB := func(i int) [3]int {
		r, g, b, _ := pal[i].RGBA()
		return [3]int{int(r >> 8), int(g >> 8), int(b >> 8)}
	}
	if p := prims[1]; p.Style != "filled" || p.FillIndex != objects3d.MissingTextureColor || p.ColorRGB == nil || *p.ColorRGB != wantRGB(0xd1) {
		t.Errorf("missing-texture face = %+v, want filled with palette 0xd1", p)
	}
	if p := prims[2]; !p.IsColored || p.ColorIndex != 0x34 || p.FillIndex != 0x34 || p.ColorRGB == nil || *p.ColorRGB != wantRGB(0x34) {
		t.Errorf("coloured face = %+v, want isColored, colour 0x34", p)
	}
	if !prims[3].Hidden || out.Root.SelectionPrim != 3 {
		t.Errorf("selection primitive: hidden=%v selectionPrim=%d, want the kept primitive 3", prims[3].Hidden, out.Root.SelectionPrim)
	}
	for i, p := range prims[:3] {
		if p.Hidden {
			t.Errorf("prim %d is flagged hidden", i)
		}
	}
	if out.Root.Children[0].SelectionPrim != -1 {
		t.Errorf("piece without primitives has selectionPrim %d", out.Root.Children[0].SelectionPrim)
	}

	if len(out.RootSiblings) != 1 || out.RootSiblings[0].Name != "floater" {
		t.Fatalf("root siblings = %+v", out.RootSiblings)
	}
	sib := out.RootSiblings[0]
	if sib.Origin != [3]float32{} || sib.Children[0].Origin != [3]float32{} {
		t.Errorf("root sibling origins = %v, %v; the game applies no piece offsets to them", sib.Origin, sib.Children[0].Origin)
	}
	want := []string{"base", "turret", "floater", "floatkid"}
	if len(out.Pieces) != len(want) {
		t.Fatalf("pieces = %v, want %v", out.Pieces, want)
	}
	for i := range want {
		if out.Pieces[i] != want[i] {
			t.Fatalf("pieces = %v, want %v", out.Pieces, want)
		}
	}
	if out.Bounds.Max[0] < 1 {
		t.Errorf("bounds %v leave out the root sibling", out.Bounds)
	}
}

// TestModelJSONTexturesKingdomsTriangles checks that TA: Kingdoms models keep
// their textured triangles.
func TestModelJSONTexturesKingdomsTriangles(t *testing.T) {
	root := &tdoObj{name: "base", sel: -1, verts: quadVerts(), prims: []tdoPrim{
		{texture: "tex1", idx: []uint16{0, 1, 2}},
	}}
	sess := modelSession(t, "takingdoms", build3DO(root))
	out, err := sess.buildModelJSON(modelEntry{Name: "testunit", Path: "objects3d/testunit.3do"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Root.Primitives) != 1 || out.Root.Primitives[0].Style != "textured" {
		t.Errorf("TA: Kingdoms triangle = %+v, want textured", out.Root.Primitives)
	}
}

// TestObjectPreviewFollowsTheGame checks the feature drawer's 3DO object
// previews: a face whose texture does not resolve is drawn (filled with
// palette index 0xd1), an uncoloured face without a texture is not, and TA:
// Kingdoms models get the Kingdoms render options.
func TestObjectPreviewFollowsTheGame(t *testing.T) {
	// Both windings, so one of each pair faces the camera.
	both := func(p tdoPrim) []tdoPrim {
		q := p
		q.idx = []uint16{3, 2, 1, 0}
		p.idx = []uint16{0, 1, 2, 3}
		return []tdoPrim{p, q}
	}
	drawn := func(sess *Session) int {
		model, err := sess.loadObjectModel("testunit")
		if err != nil {
			t.Fatal(err)
		}
		img := model.RenderImage(sess.objectStillOptions("testunit"))
		n := 0
		for i := 3; i < len(img.Pix); i += 4 {
			if img.Pix[i] != 0 {
				n++
			}
		}
		return n
	}
	big := [][3]int32{{-16 << 16, 0, -16 << 16}, {16 << 16, 0, -16 << 16}, {16 << 16, 0, 16 << 16}, {-16 << 16, 0, 16 << 16}}
	missing := build3DO(&tdoObj{name: "base", sel: -1, verts: big, prims: both(tdoPrim{texture: "nosuch"})})
	if drawn(modelSession(t, "totala", missing)) == 0 {
		t.Error("a face with a missing texture was not drawn; the game fills it with palette 0xd1")
	}
	blank := build3DO(&tdoObj{name: "base", sel: -1, verts: big, prims: both(tdoPrim{flags: 2})})
	if n := drawn(modelSession(t, "totala", blank)); n != 0 {
		t.Errorf("an uncoloured face without a texture drew %d pixels; the game draws nothing", n)
	}

	mat := &objectMaterial{pal: modelSession(t, "totala", blank).palettes().ModelColorPalette("testunit")}
	if _, ok := mat.PaletteColor(objects3d.MissingTextureColor); !ok {
		t.Error("the material cannot supply palette index 0xd1")
	}
	if o := modelSession(t, "totala", blank).objectStillOptions("testunit"); !o.CullBackFaces || o.TexturePolygons || o.KeyedTextures {
		t.Errorf("TA options = cull %v, polygons %v, keyed %v; want the game's TA rules", o.CullBackFaces, o.TexturePolygons, o.KeyedTextures)
	}
	if o := modelSession(t, "takingdoms", blank).objectStillOptions("testunit"); !o.TexturePolygons || !o.KeyedTextures {
		t.Error("TA: Kingdoms previews do not use the Kingdoms render options")
	}
}
