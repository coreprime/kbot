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
	"path"
	"strings"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/formats/tnt"
)

// Stats summarises what the preview compositor did so callers can surface
// counts to users / MCP results.
type Stats struct {
	SpritesPainted int
	SpritesMissing int
	StartPositions int
	HasSisterOTA   bool
}

// Compose paints feature sprites and start position markers onto base.
//
// vfs is required for sprite resolution.  When otaText is empty, the sister
// .ota is looked up in vfs by tntBasename (the filename without extension).
// spritePalette is used to decode GAF frames.
func Compose(base *image.RGBA, m *tnt.Map, features []tnt.Feature, vfs *filesystem.VirtualFileSystem, spritePalette *gaf.Palette, tntBasename, otaText string) (Stats, error) {
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
	if otaText != "" {
		stats.HasSisterOTA = true
		starts := ExtractStartPositions(otaText)
		drawStartPositionCircles(base, starts, m.TileW*32, m.TileH*32)
		stats.StartPositions = len(starts)
	}
	return stats, nil
}

// StartPos holds one player start position in map pixel coordinates.
type StartPos struct {
	Number int
	X, Y   int
}

// ExtractStartPositions pulls the StartPos entries out of an .ota's
// GlobalHeader / Schema 0 / specials section.
func ExtractStartPositions(otaText string) []StartPos {
	doc, err := tdf.ParseString(otaText)
	if err != nil {
		return nil
	}
	global := doc.Section("GlobalHeader")
	if global == nil {
		return nil
	}
	var schema0 *tdf.Section
	for _, s := range global.Sections() {
		if strings.EqualFold(s.Name(), "Schema 0") {
			schema0 = s
			break
		}
	}
	if schema0 == nil {
		return nil
	}
	var specials *tdf.Section
	for _, s := range schema0.Sections() {
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
	gafName string
	seqName string
}

type gafFile struct {
	sequences []*gaf.Sequence
	byName    map[string]int
}

type spriteImage struct {
	img     *image.Paletted
	originX int
	originY int
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
				gafName: sec.String("filename"),
				seqName: sec.String("seqname"),
			}
			if ref.gafName == "" {
				continue
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
		img:     frame.ToImage(c.palette),
		originX: int(frame.OriginX),
		originY: int(frame.OriginY),
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
		dstX := p.PixelX - sp.originX
		dstY := p.PixelY - sp.originY
		dstRect := image.Rect(dstX, dstY, dstX+sp.img.Bounds().Dx(), dstY+sp.img.Bounds().Dy())
		draw.Draw(base, dstRect, sp.img, image.Point{}, draw.Over)
		painted++
	}
	return
}

// drawStartPositionCircles draws each StartPos as a filled white disc with a
// black ring and a centred digit at the player number.  Marker size scales
// with the map's longest side so a 332-tile map gets visibly large markers
// without overwhelming a small 16-tile mission map.  Coordinates outside the
// map are clipped to its edge so any misconfigured OTA still shows up.
func drawStartPositionCircles(base *image.RGBA, starts []StartPos, mapW, mapH int) {
	longest := mapW
	if mapH > longest {
		longest = mapH
	}
	radius := longest / 64
	if radius < 18 {
		radius = 18
	}
	ringThickness := radius / 6
	if ringThickness < 2 {
		ringThickness = 2
	}
	fontScale := radius / 6
	if fontScale < 3 {
		fontScale = 3
	}
	white := color.RGBA{255, 255, 255, 255}
	black := color.RGBA{0, 0, 0, 255}
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
		drawFilledDisc(base, cx, cy, radius, black)
		drawFilledDisc(base, cx, cy, radius-ringThickness, white)
		drawCenteredNumber(base, cx, cy, s.Number, black, fontScale)
	}
}

func drawFilledDisc(img *image.RGBA, cx, cy, r int, c color.Color) {
	r2 := r * r
	b := img.Bounds()
	for dy := -r; dy <= r; dy++ {
		y := cy + dy
		if y < b.Min.Y || y >= b.Max.Y {
			continue
		}
		for dx := -r; dx <= r; dx++ {
			x := cx + dx
			if x < b.Min.X || x >= b.Max.X {
				continue
			}
			if dx*dx+dy*dy <= r2 {
				img.Set(x, y, c)
			}
		}
	}
}

// digitFont3x5 holds 3-wide, 5-tall bitmaps for '0'..'9'.  Each entry is 5
// rows; bit 2 is leftmost.
var digitFont3x5 = map[rune][5]byte{
	'0': {0b111, 0b101, 0b101, 0b101, 0b111},
	'1': {0b010, 0b110, 0b010, 0b010, 0b111},
	'2': {0b111, 0b001, 0b111, 0b100, 0b111},
	'3': {0b111, 0b001, 0b111, 0b001, 0b111},
	'4': {0b101, 0b101, 0b111, 0b001, 0b001},
	'5': {0b111, 0b100, 0b111, 0b001, 0b111},
	'6': {0b111, 0b100, 0b111, 0b101, 0b111},
	'7': {0b111, 0b001, 0b010, 0b010, 0b010},
	'8': {0b111, 0b101, 0b111, 0b101, 0b111},
	'9': {0b111, 0b101, 0b111, 0b001, 0b111},
}

func drawCenteredNumber(img *image.RGBA, cx, cy, n int, c color.Color, scale int) {
	if scale < 1 {
		scale = 1
	}
	const glyphW, glyphH = 3, 5
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
		glyph, ok := digitFont3x5[r]
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
