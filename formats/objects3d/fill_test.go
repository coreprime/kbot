package objects3d

import "testing"

func boxVertices() []Vertex {
	return []Vertex{
		{-100, -100, -100}, // 0
		{100, -100, -100},  // 1
		{100, -100, 100},   // 2
		{-100, -100, 100},  // 3
		{-100, 100, -100},  // 4
		{100, 100, -100},   // 5
		{100, 100, 100},    // 6
		{-100, 100, 100},   // 7
	}
}

func quad(a, b, c, d int) Primitive {
	return Primitive{VertexIndices: []int{a, b, c, d}}
}

// sides + top, omitting the bottom (y=-100) quad.
func openBottomBox() *Object {
	return &Object{
		Vertices: boxVertices(),
		Primitives: []Primitive{
			quad(4, 5, 6, 7), // top
			quad(3, 2, 6, 7), // front
			quad(0, 1, 5, 4), // back
			quad(0, 3, 7, 4), // left
			quad(1, 2, 6, 5), // right
		},
	}
}

func modelOf(o *Object) *Model {
	return &Model{Root: o, AllObjects: []*Object{o}}
}

func countSynthetic(o *Object) int {
	n := 0
	for _, p := range o.Primitives {
		if p.Synthetic {
			n++
		}
	}
	return n
}

func TestFillOpenBottomBox(t *testing.T) {
	o := openBottomBox()
	stats := FillModel(modelOf(o), FillOptions{})
	if stats.LoopsFilled != 1 {
		t.Fatalf("LoopsFilled = %d, want 1", stats.LoopsFilled)
	}
	if stats.FacesAdded != 2 {
		t.Fatalf("FacesAdded = %d, want 2 (quad bottom -> 2 tris)", stats.FacesAdded)
	}
	if got := countSynthetic(o); got != 2 {
		t.Fatalf("synthetic primitives = %d, want 2", got)
	}
	if stats.VerticesAdded != 0 {
		t.Fatalf("VerticesAdded = %d, want 0 (planar quad needs no centroid)", stats.VerticesAdded)
	}
}

func TestFillClosedBoxIsNoop(t *testing.T) {
	o := openBottomBox()
	o.Primitives = append(o.Primitives, quad(0, 1, 2, 3)) // add bottom
	stats := FillModel(modelOf(o), FillOptions{})
	if stats.FacesAdded != 0 {
		t.Fatalf("FacesAdded = %d, want 0 for a closed box", stats.FacesAdded)
	}
}

// A lone flat sheet (single face, no shared rim) must be left untouched:
// capping it only lays a coincident, z-fighting back-face. This is what
// keeps a unit's flat "ground" shadow plate from being doubled.
func TestFillLoneSheetIsSkipped(t *testing.T) {
	o := &Object{
		Vertices:   boxVertices()[:4],
		Primitives: []Primitive{quad(0, 1, 2, 3)},
	}
	stats := FillModel(modelOf(o), FillOptions{})
	if stats.FacesAdded != 0 {
		t.Fatalf("FacesAdded = %d, want 0 (lone sheet must not be back-faced)", stats.FacesAdded)
	}
}

// Two coplanar quads sharing an edge form a real rim across two faces, so the
// open perimeter should still be capped.
func TestFillSharedRimIsCapped(t *testing.T) {
	o := &Object{
		Vertices: []Vertex{
			{0, 0, 0}, {100, 0, 0}, {100, 0, 100}, {0, 0, 100}, // 0..3
			{200, 0, 0}, {200, 0, 100}, // 4,5
		},
		Primitives: []Primitive{
			quad(0, 1, 2, 3), // left quad
			quad(1, 4, 5, 2), // right quad, shares edge 1-2
		},
	}
	stats := FillModel(modelOf(o), FillOptions{})
	if stats.FacesAdded == 0 {
		t.Fatal("FacesAdded = 0, want the shared-rim perimeter to be capped")
	}
}

func TestFillCapInheritsColorAndTexture(t *testing.T) {
	o := openBottomBox()
	for i := range o.Primitives {
		o.Primitives[i].ColorIndex = 9
		o.Primitives[i].TextureName = "armpw"
		o.Primitives[i].IsColored = true
	}
	FillModel(modelOf(o), FillOptions{})
	for _, p := range o.Primitives {
		if !p.Synthetic {
			continue
		}
		if p.ColorIndex != 9 || p.TextureName != "armpw" || !p.IsColored {
			t.Fatalf("synthetic cap did not inherit neighbour appearance: %+v", p)
		}
	}
}
