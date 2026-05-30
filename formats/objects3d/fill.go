package objects3d

import (
	"math"
	"sort"
)

// FillOptions controls how missing faces are reconstructed.
type FillOptions struct {
	// MaxLoopVertices skips boundary loops longer than this to avoid
	// capping large, intentionally-open shapes (e.g. a tube). Zero means
	// no limit.
	MaxLoopVertices int
	// PlanarTolerance is the maximum distance (in fixed-point world units)
	// any loop vertex may sit from the loop's best-fit plane before the
	// loop is filled with a centroid fan instead of an ear-clipped cap.
	// Zero falls back to a sensible default.
	PlanarTolerance float64
}

// FillStats summarises the work done by FillModel.
type FillStats struct {
	ObjectsTouched int
	LoopsFilled    int
	FacesAdded     int
	VerticesAdded  int
}

// FillModel reconstructs faces that TA's artists deleted as a fill-rate
// optimisation. For every object it finds the loops of boundary edges
// (edges used by exactly one face) that border a hole and caps each loop
// with synthetic triangles. This closes open box bottoms and makes lone
// single-sided sheets solid from both sides. The model is modified in
// place; added primitives carry Synthetic=true.
func FillModel(m *Model, opts FillOptions) FillStats {
	if opts.MaxLoopVertices == 0 {
		opts.MaxLoopVertices = 64
	}
	if opts.PlanarTolerance == 0 {
		opts.PlanarTolerance = 0.06 * 65536.0
	}
	var stats FillStats
	for _, o := range m.AllObjects {
		loops, faces, verts := fillObject(o, opts)
		if faces > 0 {
			stats.ObjectsTouched++
		}
		stats.LoopsFilled += loops
		stats.FacesAdded += faces
		stats.VerticesAdded += verts
	}
	return stats
}

type vec3 struct{ X, Y, Z float64 }

func (a vec3) sub(b vec3) vec3 { return vec3{a.X - b.X, a.Y - b.Y, a.Z - b.Z} }
func (a vec3) add(b vec3) vec3 { return vec3{a.X + b.X, a.Y + b.Y, a.Z + b.Z} }
func (a vec3) scale(s float64) vec3 {
	return vec3{a.X * s, a.Y * s, a.Z * s}
}
func (a vec3) dot(b vec3) float64 { return a.X*b.X + a.Y*b.Y + a.Z*b.Z }
func (a vec3) cross(b vec3) vec3 {
	return vec3{a.Y*b.Z - a.Z*b.Y, a.Z*b.X - a.X*b.Z, a.X*b.Y - a.Y*b.X}
}
func (a vec3) length() float64 { return math.Sqrt(a.dot(a)) }
func (a vec3) normalize() vec3 {
	l := a.length()
	if l < 1e-9 {
		return vec3{}
	}
	return a.scale(1 / l)
}

func edgeKey(a, b int) [2]int {
	if a < b {
		return [2]int{a, b}
	}
	return [2]int{b, a}
}

// polyFaces returns the indices of primitives that are filled polygons
// (three or more vertices). Points and lines are ignored.
func polyFaces(o *Object) []int {
	var faces []int
	for i := range o.Primitives {
		if len(o.Primitives[i].VertexIndices) >= 3 {
			faces = append(faces, i)
		}
	}
	return faces
}

func fillObject(o *Object, opts FillOptions) (loopsFilled, facesAdded, vertsAdded int) {
	faces := polyFaces(o)
	if len(faces) == 0 {
		return 0, 0, 0
	}

	// Count edge usage and remember one owning face per edge so caps can
	// inherit a neighbour's colour and texture.
	type edgeInfo struct {
		count int
		face  int
	}
	edges := make(map[[2]int]*edgeInfo)
	for _, fi := range faces {
		idx := o.Primitives[fi].VertexIndices
		n := len(idx)
		for k := 0; k < n; k++ {
			a, b := idx[k], idx[(k+1)%n]
			if a == b {
				continue
			}
			key := edgeKey(a, b)
			e := edges[key]
			if e == nil {
				e = &edgeInfo{}
				edges[key] = e
			}
			e.count++
			e.face = fi
		}
	}

	// Boundary edges are used by exactly one face; build an adjacency map
	// over just those edges so we can walk them into closed loops.
	adj := make(map[int][]int)
	boundary := make(map[[2]int]bool)
	for key, e := range edges {
		if e.count != 1 {
			continue
		}
		boundary[key] = true
		adj[key[0]] = append(adj[key[0]], key[1])
		adj[key[1]] = append(adj[key[1]], key[0])
	}
	if len(boundary) == 0 {
		return 0, 0, 0
	}

	objCentroid := objectCentroid(o)

	// Deterministic iteration: sort boundary edges so output is stable.
	keys := make([][2]int, 0, len(boundary))
	for key := range boundary {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i][0] != keys[j][0] {
			return keys[i][0] < keys[j][0]
		}
		return keys[i][1] < keys[j][1]
	})

	for _, start := range keys {
		if !boundary[start] {
			continue
		}
		loop := traceLoop(start, adj, boundary)
		if len(loop) < 3 {
			continue
		}
		if opts.MaxLoopVertices > 0 && len(loop) > opts.MaxLoopVertices {
			continue
		}
		// A loop whose every edge belongs to one single face is a lone flat
		// sheet (e.g. a unit's "ground" shadow plate or a decorative fin),
		// not the rim of an enclosed cavity. Capping it just lays a
		// coincident, z-fighting back-face, so skip it: we only close real
		// holes, where the rim is shared by several faces.
		owners := make(map[int]bool)
		n := len(loop)
		for i := 0; i < n; i++ {
			if e := edges[edgeKey(loop[i], loop[(i+1)%n])]; e != nil {
				owners[e.face] = true
			}
		}
		if len(owners) < 2 {
			continue
		}
		owner := edges[start].face
		added, newVerts := capLoop(o, loop, owner, objCentroid, opts)
		if added > 0 {
			loopsFilled++
			facesAdded += added
			vertsAdded += newVerts
		}
	}
	return loopsFilled, facesAdded, vertsAdded
}

func objectCentroid(o *Object) vec3 {
	if len(o.Vertices) == 0 {
		return vec3{}
	}
	var c vec3
	for _, v := range o.Vertices {
		c = c.add(vec3{float64(v.X), float64(v.Y), float64(v.Z)})
	}
	return c.scale(1 / float64(len(o.Vertices)))
}

// traceLoop walks boundary edges starting from one edge until it returns to
// the origin, consuming each edge it uses. It greedily prefers the neighbour
// that keeps the walk on unused boundary edges.
func traceLoop(start [2]int, adj map[int][]int, boundary map[[2]int]bool) []int {
	a, b := start[0], start[1]
	boundary[edgeKey(a, b)] = false
	loop := []int{a, b}
	prev, cur := a, b
	for cur != a {
		next := -1
		for _, cand := range adj[cur] {
			if cand == prev {
				continue
			}
			if boundary[edgeKey(cur, cand)] {
				next = cand
				break
			}
		}
		if next == -1 {
			// Dead end (non-manifold or degenerate); stop here.
			break
		}
		boundary[edgeKey(cur, next)] = false
		if next == a {
			break
		}
		loop = append(loop, next)
		prev, cur = cur, next
	}
	return loop
}

func vertexOf(o *Object, i int) vec3 {
	v := o.Vertices[i]
	return vec3{float64(v.X), float64(v.Y), float64(v.Z)}
}

// capLoop fills one boundary loop and returns the number of triangles and the
// number of new vertices it appended to the object.
func capLoop(o *Object, loop []int, owner int, objCentroid vec3, opts FillOptions) (int, int) {
	for _, idx := range loop {
		if idx < 0 || idx >= len(o.Vertices) {
			return 0, 0
		}
	}
	color := o.Primitives[owner].ColorIndex
	texture := o.Primitives[owner].TextureName
	colored := o.Primitives[owner].IsColored
	addTri := func(a, b, c int) {
		o.Primitives = append(o.Primitives, Primitive{
			ColorIndex:    color,
			VertexIndices: []int{a, b, c},
			TextureName:   texture,
			IsColored:     colored,
			Synthetic:     true,
		})
	}
	return capRec(o, loop, objCentroid, opts, addTri, 0)
}

// capRec caps one boundary loop. A planar loop is ear-clipped into a flat,
// outward-facing cap. A non-planar loop is one boundary that wraps around a
// fold — a box missing two adjacent faces traces a single L-shaped loop over
// the back + bottom, for instance. Rather than tent it from a centroid (which
// bulges the hole into a cone), we find the chord that splits the loop into the
// two flattest halves and cap each recursively, so the result is the two flat
// faces the artist deleted. Recursion bottoms out because each half is strictly
// shorter; a loop that cannot be flattened falls back to a centroid fan.
func capRec(o *Object, loop []int, objCentroid vec3, opts FillOptions, addTri func(a, b, c int), depth int) (int, int) {
	n := len(loop)
	if n < 3 {
		return 0, 0
	}
	pts := make([]vec3, n)
	for i, idx := range loop {
		pts[i] = vertexOf(o, idx)
	}
	normal, centroid := newellPlane(pts)
	if normal.length() >= 1e-9 && planarDev(pts, normal.normalize(), centroid) <= opts.PlanarTolerance {
		lp := append([]int(nil), loop...)
		pp := append([]vec3(nil), pts...)
		nrm := normal.normalize()
		// Orient the cap so its normal points away from the object's centre,
		// putting the new face on the outside of the shell where it belongs.
		if nrm.dot(centroid.sub(objCentroid)) < 0 {
			for i, j := 0, n-1; i < j; i, j = i+1, j-1 {
				lp[i], lp[j] = lp[j], lp[i]
				pp[i], pp[j] = pp[j], pp[i]
			}
			nrm = nrm.scale(-1)
		}
		if tris, ok := earClip(pp, lp, nrm, opts.PlanarTolerance); ok {
			for _, t := range tris {
				addTri(t[0], t[1], t[2])
			}
			return len(tris), 0
		}
		return fanCap(o, loop, centroid, addTri)
	}

	if depth < 12 {
		if i, j, ok := bestSplit(pts); ok {
			a := subLoop(loop, i, j)
			b := subLoop(loop, j, i)
			ta, va := capRec(o, a, objCentroid, opts, addTri, depth+1)
			tb, vb := capRec(o, b, objCentroid, opts, addTri, depth+1)
			if ta+tb > 0 {
				return ta + tb, va + vb
			}
		}
	}
	return fanCap(o, loop, centroid, addTri)
}

// subLoop returns the vertices of loop walking forward from index i to index j
// inclusive, wrapping past the end. The two halves a split produces, subLoop(i,j)
// and subLoop(j,i), share exactly the chord endpoints loop[i] and loop[j], so the
// caps meet cleanly along that edge with no T-junction.
func subLoop(loop []int, i, j int) []int {
	n := len(loop)
	out := make([]int, 0, n)
	for k := i; ; k = (k + 1) % n {
		out = append(out, loop[k])
		if k == j {
			break
		}
	}
	return out
}

// bestSplit finds the chord (i,j) of a non-planar loop that divides it into the
// two flattest halves. It returns ok only when the split strictly reduces the
// worst half's planar deviation, guaranteeing each recursion makes progress.
func bestSplit(pts []vec3) (int, int, bool) {
	n := len(pts)
	best := planarDevAuto(pts)
	bi, bj, found := 0, 0, false
	for i := 0; i < n; i++ {
		for j := i + 2; j < n; j++ {
			if i == 0 && j == n-1 {
				continue // wrap-adjacent: the other half would be a 2-gon
			}
			a := pts[i : j+1]
			b := append(append([]vec3{}, pts[j:]...), pts[:i+1]...)
			score := math.Max(planarDevAuto(a), planarDevAuto(b))
			if score < best-1e-6 {
				best, bi, bj, found = score, i, j, true
			}
		}
	}
	return bi, bj, found
}

// planarDevAuto fits a plane to pts (Newell) and reports the largest distance
// any point sits from it. A degenerate (collinear/empty) loop reports +Inf so
// bestSplit never chooses a split that creates one.
func planarDevAuto(pts []vec3) float64 {
	if len(pts) < 3 {
		return math.Inf(1)
	}
	normal, centroid := newellPlane(pts)
	if normal.length() < 1e-9 {
		return math.Inf(1)
	}
	return planarDev(pts, normal.normalize(), centroid)
}

// planarDev is the largest absolute distance from any point to the plane
// through centroid with the given unit normal.
func planarDev(pts []vec3, unitNormal, centroid vec3) float64 {
	max := 0.0
	for _, p := range pts {
		if d := math.Abs(p.sub(centroid).dot(unitNormal)); d > max {
			max = d
		}
	}
	return max
}

// fanCap tents a loop from a new centroid vertex. Last-resort path for loops
// that are neither planar nor splittable (genuinely curved or non-simple rims).
func fanCap(o *Object, loop []int, centroid vec3, addTri func(a, b, c int)) (int, int) {
	centerIdx := len(o.Vertices)
	o.Vertices = append(o.Vertices, Vertex{
		X: int32(math.Round(centroid.X)),
		Y: int32(math.Round(centroid.Y)),
		Z: int32(math.Round(centroid.Z)),
	})
	n := len(loop)
	for i := 0; i < n; i++ {
		addTri(centerIdx, loop[i], loop[(i+1)%n])
	}
	return n, 1
}

// newellPlane returns the area-weighted normal (Newell's method) and the
// centroid of a polygon.
func newellPlane(pts []vec3) (vec3, vec3) {
	var n, c vec3
	count := len(pts)
	for i := 0; i < count; i++ {
		cur := pts[i]
		nxt := pts[(i+1)%count]
		n.X += (cur.Y - nxt.Y) * (cur.Z + nxt.Z)
		n.Y += (cur.Z - nxt.Z) * (cur.X + nxt.X)
		n.Z += (cur.X - nxt.X) * (cur.Y + nxt.Y)
		c = c.add(cur)
	}
	return n, c.scale(1 / float64(count))
}

// earClip triangulates a simple polygon assumed roughly planar. It projects
// to the plane defined by normal, then clips ears. It returns false when the
// loop deviates from planar beyond tol or the polygon is not simple, so the
// caller can fall back to a centroid fan.
func earClip(pts []vec3, loop []int, normal vec3, tol float64) ([][3]int, bool) {
	n := len(pts)
	if n < 3 {
		return nil, false
	}
	centroid := vec3{}
	for _, p := range pts {
		centroid = centroid.add(p)
	}
	centroid = centroid.scale(1 / float64(n))
	for _, p := range pts {
		if math.Abs(p.sub(centroid).dot(normal)) > tol {
			return nil, false
		}
	}

	// Build an orthonormal basis on the plane and project to 2D.
	u := normal.cross(vec3{0, 1, 0})
	if u.length() < 1e-6 {
		u = normal.cross(vec3{1, 0, 0})
	}
	u = u.normalize()
	v := normal.cross(u).normalize()
	type pt2 struct{ x, y float64 }
	proj := make([]pt2, n)
	for i, p := range pts {
		d := p.sub(centroid)
		proj[i] = pt2{d.dot(u), d.dot(v)}
	}

	// Signed area decides the winding so the ear test is consistent.
	area := 0.0
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		area += proj[i].x*proj[j].y - proj[j].x*proj[i].y
	}
	ccw := area > 0

	idxs := make([]int, n)
	for i := range idxs {
		idxs[i] = i
	}

	cross2 := func(ax, ay, bx, by, cx, cy float64) float64 {
		return (bx-ax)*(cy-ay) - (by-ay)*(cx-ax)
	}
	inTri := func(px, py, ax, ay, bx, by, cx, cy float64) bool {
		d1 := cross2(ax, ay, bx, by, px, py)
		d2 := cross2(bx, by, cx, cy, px, py)
		d3 := cross2(cx, cy, ax, ay, px, py)
		hasNeg := d1 < 0 || d2 < 0 || d3 < 0
		hasPos := d1 > 0 || d2 > 0 || d3 > 0
		return !hasNeg || !hasPos
	}

	var tris [][3]int
	guard := 0
	for len(idxs) > 3 {
		guard++
		if guard > 4*n {
			return nil, false
		}
		earFound := false
		for i := 0; i < len(idxs); i++ {
			ai := idxs[(i+len(idxs)-1)%len(idxs)]
			bi := idxs[i]
			ci := idxs[(i+1)%len(idxs)]
			a, b, c := proj[ai], proj[bi], proj[ci]
			convex := cross2(a.x, a.y, b.x, b.y, c.x, c.y) > 0
			if ccw != convex {
				continue
			}
			isEar := true
			for _, oi := range idxs {
				if oi == ai || oi == bi || oi == ci {
					continue
				}
				p := proj[oi]
				if inTri(p.x, p.y, a.x, a.y, b.x, b.y, c.x, c.y) {
					isEar = false
					break
				}
			}
			if !isEar {
				continue
			}
			tris = append(tris, [3]int{loop[ai], loop[bi], loop[ci]})
			idxs = append(idxs[:i], idxs[i+1:]...)
			earFound = true
			break
		}
		if !earFound {
			return nil, false
		}
	}
	tris = append(tris, [3]int{loop[idxs[0]], loop[idxs[1]], loop[idxs[2]]})
	return tris, true
}
