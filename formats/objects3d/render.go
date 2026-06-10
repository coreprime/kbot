package objects3d

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
)

// Material supplies surface appearance for a 3DO primitive, backed by the host's
// asset store (GAF textures + palette). The rasteriser stays VFS/GAF-agnostic;
// this is the boundary the studio implements against its session.
type Material interface {
	// Texture returns the decoded texture image for a 3DO texture name.
	Texture(name string) (*image.RGBA, bool)
	// PaletteColor returns the RGBA for a colour-keyed primitive's index.
	PaletteColor(index int) (color.RGBA, bool)
}

// RenderOptions controls how a 3DO model is rasterised. Defaults give a TA-style
// steep top-down view at true game scale. Every camera/lighting/scale knob is
// exposed so snapshot angles can be tuned without touching the rasteriser.
type RenderOptions struct {
	Width, Height int
	AzimuthDeg    float64 // rotation about the vertical (Y) axis
	ElevationDeg  float64 // tilt about X; 90 = straight down, 0 = side-on
	Margin        float64 // padding as a fraction of the image (0..0.5)
	Ambient       float64 // ambient light floor (0..1)
	Gain          float64 // brightness multiplier applied after shading
	LightDir      [3]float64
	Background    color.Color // nil = transparent
	Base          color.Color // fallback colour for untextured/unresolved faces
	Material      Material    // optional texture/palette source
	// FitToFrame scales the model to fill the frame (for large hover previews)
	// instead of rendering at true scale.
	FitToFrame bool
	// UnitsPerPixel is the true 3DO-units-per-output-pixel scale (TA native is
	// 65536 units = 1px = 1/16th of a tile). Models render at this true scale,
	// shrinking only if they would otherwise overflow the frame.
	UnitsPerPixel float64
}

// DefaultRenderOptions returns a TA-style steep top-down preview at true scale.
func DefaultRenderOptions() RenderOptions {
	return RenderOptions{
		Width: 128, Height: 128,
		AzimuthDeg: 30, ElevationDeg: 68,
		Margin:        0.08,
		Ambient:       0.55,
		Gain:          1.25,
		LightDir:      [3]float64{-0.3, 0.9, 0.55},
		Background:    nil,
		Base:          color.RGBA{0xb6, 0xbc, 0xc6, 0xff},
		UnitsPerPixel: 65536,
	}
}

// rtri is a renderable triangle: world-space verts, per-vertex UVs, and either a
// texture (sampled per pixel) or a flat colour.
type rtri struct {
	p   [3]vec3
	uv  [3][2]float64
	tex *image.RGBA
	col color.RGBA
}

// RenderPNG rasterises a single still and returns PNG bytes.
func (m *Model) RenderPNG(opts RenderOptions) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, m.RenderImage(opts)); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// RenderImage rasterises a single still at the configured angle.
func (m *Model) RenderImage(opts RenderOptions) *image.RGBA {
	normalizeOpts(&opts)
	tris := m.buildTris(opts)
	c := centroidOf(tris)
	scale := fitScale(tris, c, opts)
	return renderFrame(opts, tris, c, rad(opts.AzimuthDeg), rad(opts.ElevationDeg), scale)
}

// RenderSpinAPNG renders an N-frame 360° spin about the model centre as a
// truecolor animated PNG. Uses the SAME scale/centre as RenderImage so hovering
// from the still into the spin doesn't jump. Falls back to a still when n<=1.
func (m *Model) RenderSpinAPNG(opts RenderOptions, frames, delayMs int) ([]byte, error) {
	normalizeOpts(&opts)
	if frames <= 1 {
		return m.RenderPNG(opts)
	}
	tris := m.buildTris(opts)
	c := centroidOf(tris)
	scale := fitScale(tris, c, opts)
	el := rad(opts.ElevationDeg)
	imgs := make([]*image.RGBA, frames)
	for i := 0; i < frames; i++ {
		az := rad(opts.AzimuthDeg) + 2*math.Pi*float64(i)/float64(frames)
		imgs[i] = renderFrame(opts, tris, c, az, el, scale)
	}
	num := uint16(delayMs)
	if num == 0 {
		num = 90
	}
	return encodeAPNG(imgs, num, 1000)
}

// fitScale returns the true-scale pixels-per-unit, shrunk only if the model's
// bounding sphere wouldn't otherwise fit the frame (rotation-invariant so a spin
// never clips or breathes).
func fitScale(tris []rtri, c vec3, opts RenderOptions) float64 {
	native := 1.0 / opts.UnitsPerPixel
	radius := 0.0
	for _, t := range tris {
		for _, p := range t.p {
			if l := p.sub(c).length(); l > radius {
				radius = l
			}
		}
	}
	if radius <= 0 {
		return native
	}
	avail := 1.0 - 2*opts.Margin
	fit := float64(min2(opts.Width, opts.Height)) * avail / (2 * radius)
	if opts.FitToFrame {
		return fit // fill the frame (large hover preview)
	}
	if fit < native {
		return fit // cap so an oversized model never clips
	}
	return native
}

// renderFrame rasterises one frame: rotate about the centroid, project with the
// fixed scale, per-pixel z-buffer + (textured or flat) shading.
func renderFrame(opts RenderOptions, tris []rtri, c vec3, az, el, scale float64) *image.RGBA {
	W, H := opts.Width, opts.Height
	img := image.NewRGBA(image.Rect(0, 0, W, H))
	if opts.Background != nil {
		bg := toRGBA8(opts.Background, color.RGBA{})
		for i := 0; i < len(img.Pix); i += 4 {
			img.Pix[i+0], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = bg.R, bg.G, bg.B, bg.A
		}
	}
	if len(tris) == 0 {
		return img
	}
	light := vec3{opts.LightDir[0], opts.LightDir[1], opts.LightDir[2]}.normalize()
	zbuf := make([]float64, W*H)
	for i := range zbuf {
		zbuf[i] = math.Inf(-1)
	}
	cxF, cyF := float64(W)/2, float64(H)/2
	for _, t := range tris {
		r0 := rotate(t.p[0].sub(c), az, el)
		r1 := rotate(t.p[1].sub(c), az, el)
		r2 := rotate(t.p[2].sub(c), az, el)
		n := r1.sub(r0).cross(r2.sub(r0))
		if n.length() == 0 {
			continue
		}
		shade := opts.Ambient + (1-opts.Ambient)*math.Abs(n.normalize().dot(light))
		shade *= opts.Gain
		sx0, sy0 := cxF+r0.X*scale, cyF-r0.Y*scale
		sx1, sy1 := cxF+r1.X*scale, cyF-r1.Y*scale
		sx2, sy2 := cxF+r2.X*scale, cyF-r2.Y*scale
		rasterTri(img, zbuf, W, H, t, shade,
			sx0, sy0, r0.Z, sx1, sy1, r1.Z, sx2, sy2, r2.Z)
	}
	return img
}

// buildTris flattens the object hierarchy into renderable triangles: applies
// each object's offset, skips the selection primitive (the in-game selection
// baseplate, not meant to be drawn), assigns the client's UV layout, resolves
// each primitive's texture/colour, and fan-triangulates.
func (m *Model) buildTris(opts RenderOptions) []rtri {
	fallback := toRGBA8(opts.Base, color.RGBA{0xb6, 0xbc, 0xc6, 0xff})
	var tris []rtri
	if m == nil || m.Root == nil {
		return tris
	}
	minY, maxY := m.worldYBounds()
	yh := maxY - minY
	// isBaseplate detects the flat, colour-keyed footprint/selection quad that
	// sits at the model's base (the in-game selection/ground plate). Some 3DOs
	// flag it via SelectionPrim, others don't — this catches both. It also
	// keeps the plate out of the bounding box so sizing reflects the real model.
	isBaseplate := func(wv []vec3, p Primitive) bool {
		if !p.IsColored || len(p.VertexIndices) != 4 {
			return false
		}
		mn, mx := math.Inf(1), math.Inf(-1)
		for _, id := range p.VertexIndices {
			y := wv[id].Y
			mn, mx = math.Min(mn, y), math.Max(mx, y)
		}
		if mx-mn > yh*0.02 { // not flat/horizontal
			return false
		}
		return mx <= minY+yh*0.12 // near the bottom
	}
	var walk func(o *Object, origin vec3)
	walk = func(o *Object, origin vec3) {
		oo := vec3{
			origin.X + float64(o.XFromParent),
			origin.Y + float64(o.YFromParent),
			origin.Z + float64(o.ZFromParent),
		}
		wv := make([]vec3, len(o.Vertices))
		for i, v := range o.Vertices {
			wv[i] = vec3{oo.X + float64(v.X), oo.Y + float64(v.Y), oo.Z + float64(v.Z)}
		}
		for pi, p := range o.Primitives {
			if int32(pi) == o.SelectionPrim || isBaseplate(wv, p) {
				continue // baseplate / selection plate — not drawn
			}
			idx := p.VertexIndices
			if len(idx) < 3 {
				continue
			}
			valid := true
			for _, id := range idx {
				if id < 0 || id >= len(wv) {
					valid = false
					break
				}
			}
			if !valid {
				continue
			}
			uvs := polyUVs(len(idx))
			var tex *image.RGBA
			col := fallback
			if opts.Material != nil {
				if p.IsColored {
					if c, ok := opts.Material.PaletteColor(p.ColorIndex); ok {
						col = c
					}
				} else if p.TextureName != "" {
					if t, ok := opts.Material.Texture(p.TextureName); ok {
						tex = t
					}
				}
			}
			for i := 1; i+1 < len(idx); i++ {
				tris = append(tris, rtri{
					p:   [3]vec3{wv[idx[0]], wv[idx[i]], wv[idx[i+1]]},
					uv:  [3][2]float64{uvs[0], uvs[i], uvs[i+1]},
					tex: tex,
					col: col,
				})
			}
		}
		for _, ch := range o.Children {
			walk(ch, oo)
		}
	}
	walk(m.Root, vec3{})
	return tris
}

// polyUVs mirrors the studio web client's UV layout so server previews texture
// the same way the in-app 3D viewer does.
func polyUVs(count int) [][2]float64 {
	switch count {
	case 3:
		return [][2]float64{{0, 1}, {1, 1}, {1, 0}}
	case 4:
		return [][2]float64{{0, 1}, {1, 1}, {1, 0}, {0, 0}}
	}
	out := make([][2]float64, count)
	for i := 0; i < count; i++ {
		a := float64(i) / float64(count) * 2 * math.Pi
		out[i] = [2]float64{0.5 + 0.5*math.Cos(a), 0.5 + 0.5*math.Sin(a)}
	}
	return out
}

// worldYBounds returns the model's min/max world Y (height), used to detect
// the base-plane footprint quad.
func (m *Model) worldYBounds() (float64, float64) {
	minY, maxY := math.Inf(1), math.Inf(-1)
	var walk func(o *Object, oy float64)
	walk = func(o *Object, oy float64) {
		y0 := oy + float64(o.YFromParent)
		for _, v := range o.Vertices {
			y := y0 + float64(v.Y)
			minY, maxY = math.Min(minY, y), math.Max(maxY, y)
		}
		for _, c := range o.Children {
			walk(c, y0)
		}
	}
	if m.Root != nil {
		walk(m.Root, 0)
	}
	if math.IsInf(minY, 1) {
		return 0, 0
	}
	return minY, maxY
}

func centroidOf(tris []rtri) vec3 {
	if len(tris) == 0 {
		return vec3{}
	}
	mn := vec3{math.Inf(1), math.Inf(1), math.Inf(1)}
	mx := vec3{math.Inf(-1), math.Inf(-1), math.Inf(-1)}
	for _, t := range tris {
		for _, p := range t.p {
			mn.X, mx.X = math.Min(mn.X, p.X), math.Max(mx.X, p.X)
			mn.Y, mx.Y = math.Min(mn.Y, p.Y), math.Max(mx.Y, p.Y)
			mn.Z, mx.Z = math.Min(mn.Z, p.Z), math.Max(mx.Z, p.Z)
		}
	}
	return vec3{(mn.X + mx.X) / 2, (mn.Y + mx.Y) / 2, (mn.Z + mx.Z) / 2}
}

func normalizeOpts(o *RenderOptions) {
	if o.Width <= 0 {
		o.Width = 128
	}
	if o.Height <= 0 {
		o.Height = 128
	}
	if o.Margin < 0 || o.Margin >= 0.5 {
		o.Margin = 0.08
	}
	if o.Ambient < 0 || o.Ambient > 1 {
		o.Ambient = 0.55
	}
	if o.Gain <= 0 {
		o.Gain = 1.25
	}
	if o.UnitsPerPixel <= 0 {
		o.UnitsPerPixel = 65536
	}
	if o.LightDir == [3]float64{} {
		o.LightDir = [3]float64{-0.3, 0.9, 0.55}
	}
}

func rotate(p vec3, az, el float64) vec3 {
	ca, sa := math.Cos(az), math.Sin(az)
	x1 := p.X*ca + p.Z*sa
	z1 := -p.X*sa + p.Z*ca
	ce, se := math.Cos(el), math.Sin(el)
	y2 := p.Y*ce - z1*se
	z2 := p.Y*se + z1*ce
	return vec3{x1, y2, z2}
}

func rad(deg float64) float64 { return deg * math.Pi / 180 }

func min2(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func toRGBA8(c color.Color, def color.RGBA) color.RGBA {
	if c == nil {
		return def
	}
	r, g, b, a := c.RGBA()
	return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
}

// rasterTri rasterises a triangle with per-pixel depth testing. Pixels take the
// texture sample (affine UV — exact under orthographic projection) or the flat
// colour, multiplied by the face shade.
func rasterTri(img *image.RGBA, zbuf []float64, W, H int, t rtri, shade float64,
	x0, y0, z0, x1, y1, z1, x2, y2, z2 float64) {
	minX := int(math.Floor(math.Min(x0, math.Min(x1, x2))))
	maxX := int(math.Ceil(math.Max(x0, math.Max(x1, x2))))
	minY := int(math.Floor(math.Min(y0, math.Min(y1, y2))))
	maxY := int(math.Ceil(math.Max(y0, math.Max(y1, y2))))
	if minX < 0 {
		minX = 0
	}
	if minY < 0 {
		minY = 0
	}
	if maxX >= W {
		maxX = W - 1
	}
	if maxY >= H {
		maxY = H - 1
	}
	area := edge(x0, y0, x1, y1, x2, y2)
	if area == 0 {
		return
	}
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			w0 := edge(x1, y1, x2, y2, px, py)
			w1 := edge(x2, y2, x0, y0, px, py)
			w2 := edge(x0, y0, x1, y1, px, py)
			if !((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
				continue
			}
			l0, l1, l2 := w0/area, w1/area, w2/area
			z := l0*z0 + l1*z1 + l2*z2
			idx := y*W + x
			if z <= zbuf[idx] {
				continue
			}
			var cr, cg, cb uint8
			if t.tex != nil {
				u := l0*t.uv[0][0] + l1*t.uv[1][0] + l2*t.uv[2][0]
				v := l0*t.uv[0][1] + l1*t.uv[1][1] + l2*t.uv[2][1]
				cr, cg, cb = sampleTex(t.tex, u, v)
			} else {
				cr, cg, cb = t.col.R, t.col.G, t.col.B
			}
			zbuf[idx] = z
			o := img.PixOffset(x, y)
			img.Pix[o+0] = shade8(cr, shade)
			img.Pix[o+1] = shade8(cg, shade)
			img.Pix[o+2] = shade8(cb, shade)
			img.Pix[o+3] = 0xff
		}
	}
}

func sampleTex(tex *image.RGBA, u, v float64) (uint8, uint8, uint8) {
	b := tex.Bounds()
	tw, th := b.Dx(), b.Dy()
	if tw == 0 || th == 0 {
		return 0xb6, 0xbc, 0xc6
	}
	u = clamp01(u)
	v = clamp01(v)
	tx := b.Min.X + int(u*float64(tw-1)+0.5)
	ty := b.Min.Y + int(v*float64(th-1)+0.5)
	o := tex.PixOffset(tx, ty)
	return tex.Pix[o], tex.Pix[o+1], tex.Pix[o+2]
}

func clamp01(f float64) float64 {
	if f < 0 {
		return 0
	}
	if f > 1 {
		return 1
	}
	return f
}

func shade8(c uint8, shade float64) uint8 {
	f := float64(c) * shade
	if f > 255 {
		return 255
	}
	if f < 0 {
		return 0
	}
	return uint8(f)
}

func edge(ax, ay, bx, by, cx, cy float64) float64 {
	return (cx-ax)*(by-ay) - (cy-ay)*(bx-ax)
}
