// Package tntpreview composites the "preview" view of a Total Annihilation
// TNT map: the base tile-grid render with feature sprites painted on top and
// numbered start-position markers drawn from the sister .ota.
//
// It is shared between the kbot CLI (kbot tnt preview) and the MCP server
// (tnt_preview tool).  All inputs are explicit parameters — the package has
// no global state and reads no on-disk paths directly.
package tntpreview

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"math"
	"path"
	"strings"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/tdf"
	"github.com/coreprime/kbot-io/formats/tnt"
)

// Stats summarises what the preview compositor did so callers can surface
// counts to users / MCP results.
type Stats struct {
	SpritesPainted int
	SpritesMissing int
	StartPositions int
	HasSisterOTA   bool
}

// Options tunes Compose.  The zero value is the previous default: Schema 0,
// auto-resolved sister .ota.
type Options struct {
	// SchemaIndex picks which schema's StartPos entries get drawn (0-based).
	// Values out of range fall back to schema 0 — the historical default,
	// equivalent to the CLI / MCP behaviour before the per-schema selector
	// existed.
	SchemaIndex int

	// HideStartPositions suppresses the numbered StartPos marker circles, so
	// the render shows only terrain + feature sprites (used when the markers
	// would be noise, e.g. compositing assets for review).
	HideStartPositions bool
}

// Compose paints feature sprites and start position markers onto base using
// the default Options (Schema 0).  Retained for callers that don't care
// about which schema they get.
func Compose(base *image.RGBA, m *tnt.Map, features []tnt.Feature, vfs *filesystem.VirtualFileSystem, spritePalette *gaf.Palette, tntBasename, otaText string) (Stats, error) {
	return ComposeWith(base, m, features, vfs, spritePalette, tntBasename, otaText, Options{})
}

// ComposeWith paints feature sprites and start position markers onto base
// using the supplied Options.
//
// vfs is required for sprite resolution.  When otaText is empty, the sister
// .ota is looked up in vfs by tntBasename (the filename without extension).
// spritePalette is used to decode GAF frames.
func ComposeWith(base *image.RGBA, m *tnt.Map, features []tnt.Feature, vfs *filesystem.VirtualFileSystem, spritePalette *gaf.Palette, tntBasename, otaText string, opts Options) (Stats, error) {
	if base == nil {
		return Stats{}, fmt.Errorf("base image is nil")
	}
	if vfs == nil {
		return Stats{}, fmt.Errorf("vfs is required")
	}

	cache := newFeatureSpriteCache(vfs, spritePalette)
	painted, missing := compositeFeatureSprites(base, m, features, cache)

	stats := Stats{SpritesPainted: painted, SpritesMissing: missing}

	if otaText == "" && tntBasename != "" {
		if t, ok := loadSisterOTAFromVFS(tntBasename, vfs); ok {
			otaText = t
		}
	}
	if otaText != "" && !opts.HideStartPositions {
		stats.HasSisterOTA = true
		starts := ExtractStartPositionsForSchema(otaText, opts.SchemaIndex)
		drawStartPositionCircles(base, starts, m.TileW*32, m.TileH*32)
		stats.StartPositions = len(starts)
	}
	return stats, nil
}

// ComposeTAK paints TA: Kingdoms feature sprites onto base, which must be the
// map's full-resolution terrain render (see tnt.Map.RenderTAKTerrain).  Each
// placement carries a full-resolution terrain pixel (its DataUnit cell scaled
// by 16), so the sprite is anchored at that coordinate using the GAF frame's
// hotspot (falling back to bottom-centre when the frame carries no origin).
//
// vfs resolves feature TDFs (features/**.tdf) and their GAFs (anims/*.gaf);
// spritePalette is the map's per-kingdom feature palette used to decode frames.
// Placements are walked in grid (top-to-bottom) order so nearer features paint
// over farther ones.
func ComposeTAK(base *image.RGBA, m *tnt.Map, features []tnt.Feature, vfs *filesystem.VirtualFileSystem, spritePalette *gaf.Palette) (Stats, error) {
	if base == nil {
		return Stats{}, fmt.Errorf("base image is nil")
	}
	if vfs == nil {
		return Stats{}, fmt.Errorf("vfs is required")
	}
	cache := newFeatureSpriteCache(vfs, spritePalette)
	painted, missing := compositeTAKFeatureSprites(base, m, features, cache)
	return Stats{SpritesPainted: painted, SpritesMissing: missing}, nil
}

// compositeTAKFeatureSprites paints each TA:K placement's sprite anchored at the
// centre of its footprint, mirroring the TA path's featureAnchorWorld math.  The
// feature grid stores the top-left DataUnit cell of a feature's footprint, so
// the world anchor is that cell's pixel plus half the footprint
// (footprintX/Z are in 16px DataUnits, verified: footprint*16 ≈ sprite extent).
// The anchor is then lifted north by half the terrain height at the cell: the
// game's tilted camera projects raised ground up-screen, so a feature on a
// highland sits higher than its flat top-down footprint — the same height>>1
// trick TA uses.  The GAF frame's OriginX/OriginY hotspot — which sits at the
// footprint centre — is placed on that anchor; a zero origin falls back to
// bottom-centre so a sprite still sits on its base.
func compositeTAKFeatureSprites(base *image.RGBA, m *tnt.Map, features []tnt.Feature, cache *featureSpriteCache) (painted, missing int) {
	for _, p := range m.TAKFeaturePlacements() {
		if p.FeatureIdx < 0 || p.FeatureIdx >= len(features) {
			missing++
			continue
		}
		sp := cache.sprite(features[p.FeatureIdx].Name)
		if sp == nil {
			missing++
			continue
		}

		fw, fh := sp.footprintX, sp.footprintZ
		if fw <= 0 {
			fw = 1
		}
		if fh <= 0 {
			fh = 1
		}
		var terrainH int
		if p.AttrX >= 0 && p.AttrY >= 0 && p.AttrX < m.TAKW && p.AttrY < m.TAKH {
			terrainH = int(m.TAKHeight[p.AttrY*m.TAKW+p.AttrX])
		}
		anchorX := p.PixelX + fw*(tnt.TAKDataUnit/2)
		anchorY := p.PixelY + fh*(tnt.TAKDataUnit/2) - (terrainH >> 1)

		dx, dy := sp.originX, sp.originY
		if dx == 0 && dy == 0 {
			dx = sp.img.Bounds().Dx() / 2
			dy = sp.img.Bounds().Dy()
		}
		dstX := anchorX - dx
		dstY := anchorY - dy
		dstRect := image.Rect(dstX, dstY, dstX+sp.img.Bounds().Dx(), dstY+sp.img.Bounds().Dy())
		draw.Draw(base, dstRect, sp.img, image.Point{}, draw.Over)
		painted++
	}
	return
}

// StartPos holds one player start position in map pixel coordinates.
type StartPos struct {
	Number int
	X, Y   int
}

// ExtractStartPositions pulls Schema 0's StartPos entries — kept for
// callers that don't care which schema they get.  Equivalent to
// ExtractStartPositionsForSchema(otaText, 0).
func ExtractStartPositions(otaText string) []StartPos {
	return ExtractStartPositionsForSchema(otaText, 0)
}

// ExtractStartPositionsForSchema pulls the StartPos entries out of an
// .ota's GlobalHeader / Schema <n> / specials section.  When the
// requested schema doesn't exist (or the .ota's schema list is empty),
// returns nil — drawing zero markers is the right behaviour rather
// than silently falling back to a different schema's positions.
func ExtractStartPositionsForSchema(otaText string, schemaIndex int) []StartPos {
	doc, err := tdf.ParseString(otaText)
	if err != nil {
		return nil
	}
	global := doc.Section("GlobalHeader")
	if global == nil {
		return nil
	}
	wanted := fmt.Sprintf("schema %d", schemaIndex)
	var schema *tdf.Section
	for _, s := range global.Sections() {
		if strings.EqualFold(s.Name(), wanted) {
			schema = s
			break
		}
	}
	if schema == nil {
		return nil
	}
	var specials *tdf.Section
	for _, s := range schema.Sections() {
		if strings.EqualFold(s.Name(), "specials") {
			specials = s
			break
		}
	}
	if specials == nil {
		return nil
	}
	var out []StartPos
	for _, sp := range specials.Sections() {
		what := sp.String("specialwhat")
		if !strings.HasPrefix(what, "StartPos") {
			continue
		}
		num := 0
		_, _ = fmt.Sscanf(strings.TrimPrefix(what, "StartPos"), "%d", &num)
		out = append(out, StartPos{Number: num, X: sp.Int("XPos"), Y: sp.Int("ZPos")})
	}
	return out
}

// loadSisterOTAFromVFS returns the .ota text whose stem matches the .tnt's
// basename (case-insensitive), searching the entire VFS.
func loadSisterOTAFromVFS(tntBasename string, vfs *filesystem.VirtualFileSystem) (string, bool) {
	want := strings.ToLower(tntBasename)
	for _, p := range vfs.List() {
		if !strings.EqualFold(path.Ext(p), ".ota") {
			continue
		}
		stem := strings.TrimSuffix(path.Base(p), path.Ext(p))
		if strings.ToLower(stem) != want {
			continue
		}
		if b, err := vfs.ReadFile(p); err == nil {
			return string(b), true
		}
	}
	return "", false
}

// featureSpriteCache resolves feature names to renderable sprite images by
// chaining feature-name -> TDF lookup -> GAF load -> sequence index -> frame.
// Results (including misses) are memoised so the per-placement loop is cheap.
type featureSpriteCache struct {
	vfs       *filesystem.VirtualFileSystem
	palette   *gaf.Palette
	tdfIndex  map[string]featureRef
	tdfLoaded bool
	gafCache  map[string]*gafFile
	sprites   map[string]*spriteImage
}

type featureRef struct {
	gafName    string
	seqName    string
	footprintX int
	footprintZ int
}

type gafFile struct {
	sequences []*gaf.Sequence
	byName    map[string]int
}

type spriteImage struct {
	img        *image.Paletted
	originX    int
	originY    int
	footprintX int // attribute cells, X
	footprintZ int // attribute cells, Y
}

func newFeatureSpriteCache(vfs *filesystem.VirtualFileSystem, palette *gaf.Palette) *featureSpriteCache {
	return &featureSpriteCache{
		vfs:      vfs,
		palette:  palette,
		tdfIndex: make(map[string]featureRef),
		gafCache: make(map[string]*gafFile),
		sprites:  make(map[string]*spriteImage),
	}
}

func (c *featureSpriteCache) loadTDFIndex() {
	if c.tdfLoaded {
		return
	}
	c.tdfLoaded = true
	for _, p := range c.vfs.List() {
		lp := strings.ToLower(p)
		if !strings.HasPrefix(lp, "features/") || !strings.HasSuffix(lp, ".tdf") {
			continue
		}
		data, err := c.vfs.ReadFile(p)
		if err != nil {
			continue
		}
		doc, err := tdf.ParseString(string(data))
		if err != nil {
			continue
		}
		for _, sec := range doc.Sections() {
			ref := featureRef{
				gafName:    sec.String("filename"),
				seqName:    sec.String("seqname"),
				footprintX: sec.Int("footprintx"),
				footprintZ: sec.Int("footprintz"),
			}
			if ref.gafName == "" {
				continue
			}
			// Empty / missing footprint defaults to 1×1 — matches the
			// studio's featureAnchorWorld fallback (footprintX || 1).
			if ref.footprintX <= 0 {
				ref.footprintX = 1
			}
			if ref.footprintZ <= 0 {
				ref.footprintZ = 1
			}
			c.tdfIndex[strings.ToLower(sec.Name())] = ref
		}
	}
}

func (c *featureSpriteCache) sprite(name string) *spriteImage {
	key := strings.ToLower(name)
	if sp, ok := c.sprites[key]; ok {
		return sp
	}
	c.loadTDFIndex()
	ref, ok := c.tdfIndex[key]
	if !ok {
		c.sprites[key] = nil
		return nil
	}
	gf := c.loadGAF(ref.gafName)
	if gf == nil {
		c.sprites[key] = nil
		return nil
	}
	seqIdx := 0
	if idx, ok := gf.byName[strings.ToLower(ref.seqName)]; ok {
		seqIdx = idx
	}
	if seqIdx >= len(gf.sequences) {
		c.sprites[key] = nil
		return nil
	}
	seq := gf.sequences[seqIdx]
	if seq == nil || len(seq.Frames) == 0 {
		c.sprites[key] = nil
		return nil
	}
	frame := seq.Frames[0]
	sp := &spriteImage{
		img:        frame.ToImage(c.palette),
		originX:    int(frame.OriginX),
		originY:    int(frame.OriginY),
		footprintX: ref.footprintX,
		footprintZ: ref.footprintZ,
	}
	c.sprites[key] = sp
	return sp
}

func (c *featureSpriteCache) loadGAF(name string) *gafFile {
	key := strings.ToLower(name)
	if gf, ok := c.gafCache[key]; ok {
		return gf
	}
	c.gafCache[key] = nil
	gafPath := "anims/" + key + ".gaf"
	data, err := c.vfs.ReadFile(gafPath)
	if err != nil {
		return nil
	}
	r, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	seqs, err := r.ReadSequences()
	if err != nil {
		return nil
	}
	byName := make(map[string]int, len(seqs))
	for i, s := range seqs {
		if s == nil {
			continue
		}
		byName[strings.ToLower(s.Name)] = i
	}
	gf := &gafFile{sequences: seqs, byName: byName}
	c.gafCache[key] = gf
	return gf
}

// compositeFeatureSprites paints each placed feature's sprite onto base
// using the same offset math the studio canvas uses in
// featureAnchorWorld / featureAnchorOffset.  Anchor logic in game-pixel
// units (16 px per attribute cell, matching the base image's 32-px-per-
// tile render):
//
//   anchorX = AttrX*16 + (FootprintX*8)
//   anchorY = AttrY*16 + (FootprintZ*8) - (Height/2)
//
// The Height/2 lift is the same trick Cavedog used in TA's renderer
// (see Kinboat's classTAMap.cls:3340) — without it, every feature
// sitting on raised terrain renders too low.
//
// Sprite anchor (where on the sprite image lands at anchor coords)
// uses the GAF frame's OriginX/OriginY when supplied; falls back to a
// bottom-centred anchor (matches the studio canvas' featureAnchorOffset
// fallback) when the GAF carries zero origin.
func compositeFeatureSprites(base *image.RGBA, m *tnt.Map, features []tnt.Feature, cache *featureSpriteCache) (painted, missing int) {
	for _, p := range m.GetFeaturePlacements() {
		if p.FeatureIdx < 0 || p.FeatureIdx >= len(features) {
			missing++
			continue
		}
		sp := cache.sprite(features[p.FeatureIdx].Name)
		if sp == nil {
			missing++
			continue
		}

		fw := sp.footprintX
		fh := sp.footprintZ
		if fw <= 0 {
			fw = 1
		}
		if fh <= 0 {
			fh = 1
		}

		// Read the terrain height at the feature's anchor cell so we
		// can lift the sprite by Height/2.  Out-of-bounds cells are
		// possible on orphaned features (the feature table can keep
		// names for placements no cell references); fall back to 0
		// rather than crashing.
		var h int
		if p.AttrX >= 0 && p.AttrY >= 0 && p.AttrX < m.AttrW && p.AttrY < m.AttrH {
			h = int(m.TileAttr[p.AttrY*m.AttrW+p.AttrX].Height)
		}

		anchorX := p.AttrX*16 + fw*8
		anchorY := p.AttrY*16 + fh*8 - (h >> 1)

		// Origin inside the sprite — GAF hotspot when present (non-zero
		// for at least one axis), else bottom-centred.
		dx, dy := sp.originX, sp.originY
		if dx == 0 && dy == 0 {
			dx = sp.img.Bounds().Dx() / 2
			dy = sp.img.Bounds().Dy()
		}

		dstX := anchorX - dx
		dstY := anchorY - dy
		dstRect := image.Rect(dstX, dstY, dstX+sp.img.Bounds().Dx(), dstY+sp.img.Bounds().Dy())
		draw.Draw(base, dstRect, sp.img, image.Point{}, draw.Over)
		painted++
	}
	return
}

// drawStartPositionCircles paints each StartPos as a layered badge:
// a soft drop shadow, a dark-navy outer ring, a warm-amber accent
// band, a white inner disc, and the player number in a chunky 5×7
// glyph.  Marker size scales with the map's longest side so a
// 332-tile map gets visibly large markers without overwhelming a
// small 16-tile mission map.  Coordinates outside the map are
// clipped to its edge so any misconfigured OTA still shows up.
//
// Anti-aliased disc edges (alpha-blended within ±0.5 px of the
// boundary) keep the marker from looking jaggy at smaller scales —
// the original render was a hard binary fill.
func drawStartPositionCircles(base *image.RGBA, starts []StartPos, mapW, mapH int) {
	longest := mapW
	if mapH > longest {
		longest = mapH
	}
	radius := longest / 64
	if radius < 18 {
		radius = 18
	}
	// Band thicknesses sized to keep the white centre comfortably
	// readable at a glance.  Layered: shadow → outer → accent → inner.
	outerR := radius
	accentR := radius - max1(radius/9, 2)
	innerR := accentR - max1(radius/5, 3)
	if innerR < 4 {
		innerR = 4
	}
	fontScale := innerR / 4
	if fontScale < 2 {
		fontScale = 2
	}

	shadow := color.RGBA{0, 0, 0, 0x55}
	outer := color.RGBA{0x18, 0x22, 0x33, 0xff}
	accent := color.RGBA{0xe8, 0xc1, 0x4a, 0xff}
	inner := color.RGBA{0xff, 0xff, 0xff, 0xff}
	digit := color.RGBA{0x18, 0x22, 0x33, 0xff}

	// Shadow offset proportional to the marker — keeps the drop the
	// same visual depth at both small and large radii.
	shadowDX := max1(outerR/8, 1)
	shadowDY := max1(outerR/6, 2)

	for _, s := range starts {
		cx, cy := s.X, s.Y
		if cx < 0 {
			cx = 0
		} else if cx >= mapW {
			cx = mapW - 1
		}
		if cy < 0 {
			cy = 0
		} else if cy >= mapH {
			cy = mapH - 1
		}
		drawAADisc(base, cx+shadowDX, cy+shadowDY, float64(outerR)+0.5, shadow)
		drawAADisc(base, cx, cy, float64(outerR), outer)
		drawAADisc(base, cx, cy, float64(accentR), accent)
		drawAADisc(base, cx, cy, float64(innerR), inner)
		drawCenteredNumber(base, cx, cy, s.Number, digit, fontScale)
	}
}

func max1(v, lo int) int {
	if v < lo {
		return lo
	}
	return v
}

// drawAADisc paints an anti-aliased filled disc of radius r centred at
// (cx, cy).  Pixels whose centres lie within (r-0.5) units of the
// origin are written fully; pixels in the (r-0.5, r+0.5) band are
// alpha-blended by their fractional coverage.  Outer pixels are left
// alone.  Blending is straight source-over against the existing RGBA
// — keeps the layered ring + drop-shadow composition correct.
func drawAADisc(img *image.RGBA, cx, cy int, r float64, c color.RGBA) {
	if r <= 0 {
		return
	}
	b := img.Bounds()
	ir := int(r + 1)
	for dy := -ir; dy <= ir; dy++ {
		y := cy + dy
		if y < b.Min.Y || y >= b.Max.Y {
			continue
		}
		for dx := -ir; dx <= ir; dx++ {
			x := cx + dx
			if x < b.Min.X || x >= b.Max.X {
				continue
			}
			d := mathHypot(float64(dx), float64(dy))
			cov := r + 0.5 - d
			if cov <= 0 {
				continue
			}
			if cov > 1 {
				cov = 1
			}
			alpha := uint16(c.A) * uint16(cov*255+0.5) / 255
			if alpha == 0 {
				continue
			}
			blendOver(img, x, y, c, uint8(alpha))
		}
	}
}

func mathHypot(x, y float64) float64 {
	return math.Sqrt(x*x + y*y)
}

// blendOver performs straight source-over alpha compositing of src
// (with effective alpha `a` overriding src.A) onto img at (x, y).
// Skips entirely transparent writes so the disc passes don't bleed
// across already-painted layers.
func blendOver(img *image.RGBA, x, y int, src color.RGBA, a uint8) {
	if a == 0 {
		return
	}
	i := img.PixOffset(x, y)
	dst := img.Pix[i : i+4 : i+4]
	srcR, srcG, srcB := uint32(src.R), uint32(src.G), uint32(src.B)
	srcA := uint32(a)
	dstR, dstG, dstB, dstA := uint32(dst[0]), uint32(dst[1]), uint32(dst[2]), uint32(dst[3])
	outA := srcA + dstA*(255-srcA)/255
	if outA == 0 {
		return
	}
	dst[0] = uint8((srcR*srcA + dstR*dstA*(255-srcA)/255) / outA)
	dst[1] = uint8((srcG*srcA + dstG*dstA*(255-srcA)/255) / outA)
	dst[2] = uint8((srcB*srcA + dstB*dstA*(255-srcA)/255) / outA)
	dst[3] = uint8(outA)
}

// digitFont5x7 holds 5-wide, 7-tall bitmaps for '0'..'9'.  Reads cleaner
// than the 3×5 bitmap the previous renderer used — the slightly chunky
// strokes survive scale-down better and keep digits distinguishable at
// small marker radii (Schema 9 vs Schema 6 etc.).  Each entry is 7
// rows; bit 4 is leftmost.
var digitFont5x7 = map[rune][7]byte{
	'0': {0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110},
	'1': {0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110},
	'2': {0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111},
	'3': {0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110},
	'4': {0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010},
	'5': {0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110},
	'6': {0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110},
	'7': {0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000},
	'8': {0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110},
	'9': {0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100},
}

func drawCenteredNumber(img *image.RGBA, cx, cy, n int, c color.Color, scale int) {
	if scale < 1 {
		scale = 1
	}
	const glyphW, glyphH = 5, 7
	const gap = 1
	text := ""
	if n < 0 {
		text = "-"
		n = -n
	}
	if n == 0 {
		text += "0"
	} else {
		digits := ""
		for n > 0 {
			digits = string('0'+rune(n%10)) + digits
			n /= 10
		}
		text += digits
	}
	totalW := len(text)*glyphW*scale + (len(text)-1)*gap*scale
	totalH := glyphH * scale
	startX := cx - totalW/2
	startY := cy - totalH/2
	for i, r := range text {
		glyph, ok := digitFont5x7[r]
		if !ok {
			continue
		}
		gx := startX + i*(glyphW+gap)*scale
		for row := 0; row < glyphH; row++ {
			bits := glyph[row]
			for col := 0; col < glyphW; col++ {
				if bits&(1<<(glyphW-1-col)) == 0 {
					continue
				}
				px := gx + col*scale
				py := startY + row*scale
				for dy := 0; dy < scale; dy++ {
					for dx := 0; dx < scale; dx++ {
						img.Set(px+dx, py+dy, c)
					}
				}
			}
		}
	}
}
