// Package tnt implements reading of Total Annihilation TNT map files.
package tnt

import (
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"io"
	"strings"

	"github.com/coreprime/kbot/formats/tnt/tak"
)

// TNT IDVersion words. TA writes 0x2000; TA: Kingdoms reuses the TNT
// container with a bumped version word and a different field layout.
const (
	VersionTA  = 8192  // 0x2000 — Total Annihilation
	VersionTAK = 16384 // 0x4000 — Total Annihilation: Kingdoms
)

// Header is the 64-byte TNT file header.
//
// The field names describe the Total Annihilation (0x2000) layout. TA:
// Kingdoms (0x4000) keeps the same 64-byte size but moves several fields:
// notably its minimap pointer lands in the Unknown1 slot (offset 0x2c).
type Header struct {
	IDVersion   uint32 // 0x2000 (TA) or 0x4000 (TA:K)
	Width       uint32 // TA: width in 16px attribute cells (tiles = Width/2). TA:K: width in 16px DataUnits.
	Height      uint32 // TA: height in 16px attribute cells (tiles = Height/2). TA:K: height in 16px DataUnits.
	PTRMapData  uint32 // TA: tile index array. TA:K: sea level.
	PTRMapAttr  uint32 // TA: attribute array. TA:K: heightmap (Width×Height bytes).
	PTRTileGfx  uint32 // TA: tile graphics. TA:K: attribute/feature grid (Width×Height uint16).
	Tiles       uint32 // TA: number of unique tiles. TA:K: feature name table offset.
	TileAnims   uint32 // TA: number of feature entries. TA:K: feature count.
	PTRTileAnim uint32 // TA: feature structures. TA:K: terrain-name table (guW×guH uint32).
	SeaLevel    uint32 // TA: sea level. TA:K: U-mapping table (guW×guH bytes).
	PTRMinimap  uint32 // TA: minimap (252×252). TA:K: V-mapping table (guW×guH bytes).
	Unknown1    uint32 // TA:K: minimap pointer (126×126 block at offset 0x2c).
	Pad1        uint32
	Pad2        uint32
	Pad3        uint32
	Pad4        uint32
}

// The TA: Kingdoms meaning of each repurposed header slot (sea level, heightmap,
// feature grid + name table, terrain-name table, U/V maps, minimap) lives in the
// formats/tnt/tak subpackage, which owns the 0x4000 read/write variance.

// takNoFeature is the threshold at or above which a feature-grid cell holds a
// sentinel (e.g. 0xFFFF, 0xFFFB) rather than a feature index.
const takNoFeature = 0xFF00

// TileAttr is the per-cell attribute (4 bytes).
// There is one attribute per 16×16 pixel cell — 4 per 32×32 tile.
type TileAttr struct {
	Height  uint8  // Elevation at this cell
	Feature uint16 // Feature index (0xFFFF = none)
	Pad     uint8
}

// Map is a parsed TNT file.
type Map struct {
	Header Header
	IsTAK  bool // true when the file is a TA: Kingdoms TNT (IDVersion 0x4000)

	TileW    int        // Tile grid width (Header.Width / 2)
	TileH    int        // Tile grid height (Header.Height / 2)
	AttrW    int        // Attribute grid width (Header.Width)
	AttrH    int        // Attribute grid height (Header.Height)
	TileMap  []uint16   // TileW × TileH tile indices
	TileAttr []TileAttr // AttrW × AttrH attributes (16px resolution)
	Tiles    [][]byte   // Tile graphics, each 1024 bytes
	Minimap  []byte     // Minimap palette indices (or nil)
	MinimapW int
	MinimapH int

	// TA: Kingdoms data. TA:K does not store a TA-style tile mosaic. Terrain is
	// texture-mapped: a grid of 32px Graphic Units, each naming a JPG texture
	// plus a U/V offset into it. A separate heightmap and feature grid sit at
	// DataUnit (16px) resolution. These are populated only when IsTAK is true.
	TAKW            int      // Width in 16px DataUnits (Header.Width)
	TAKH            int      // Height in 16px DataUnits (Header.Height)
	TAKGUW          int      // Graphic-Unit grid width  (TAKW/2; 32px units)
	TAKGUH          int      // Graphic-Unit grid height (TAKH/2; 32px units)
	TAKHeight       []byte   // TAKW×TAKH heightmap (one byte per DataUnit)
	TAKFeatureGrid  []uint16 // TAKW×TAKH feature indices (>=takNoFeature = none)
	TAKTerrainNames []uint32 // TAKGUW×TAKGUH terrain texture names ("%08X.JPG")
	TAKUMap         []byte   // TAKGUW×TAKGUH texture column offsets (32px units)
	TAKVMap         []byte   // TAKGUW×TAKGUH texture row offsets (32px units)
	// TAKFeatureTableRaw is the feature-name table captured verbatim (its
	// internal layout isn't modelled). SaveTAK writes it back unchanged so a
	// map with features round-trips; the entry count lives in Header.TileAnims.
	TAKFeatureTableRaw []byte

	// MapDataPad preserves any padding bytes between the end of the
	// tile-index array and the start of the attribute array.  Cavedog's
	// authoring tools pad the mapdata block to a 16-byte boundary (with
	// scratch memory), so we capture it verbatim for byte-perfect
	// round-trip.  May be empty.
	MapDataPad []byte
}

// LoadFromReader parses a TNT file.
func LoadFromReader(r io.ReadSeeker) (*Map, error) {
	m := &Map{}

	if err := binary.Read(r, binary.LittleEndian, &m.Header); err != nil {
		return nil, fmt.Errorf("failed to read TNT header: %w", err)
	}

	switch m.Header.IDVersion {
	case VersionTA:
		// Full TA parse below.
	case VersionTAK:
		// TA: Kingdoms reuses the TNT container but repurposes the header
		// pointers: no tile mosaic, instead a texture-mapped Graphic-Unit
		// grid plus DataUnit-resolution heightmap and feature grid.  The
		// tak subpackage owns that layout.
		return loadTAK(r, m)
	default:
		return nil, fmt.Errorf("unsupported TNT version: %d (expected %d for TA or %d for TA:K)",
			m.Header.IDVersion, VersionTA, VersionTAK)
	}

	m.TileW = int(m.Header.Width) / 2
	m.TileH = int(m.Header.Height) / 2
	m.AttrW = int(m.Header.Width)
	m.AttrH = int(m.Header.Height)

	// Read tile index map (TileW × TileH uint16 entries).
	if _, err := r.Seek(int64(m.Header.PTRMapData), io.SeekStart); err != nil {
		return nil, fmt.Errorf("failed to seek to map data: %w", err)
	}
	tileCount := m.TileW * m.TileH
	m.TileMap = make([]uint16, tileCount)
	if err := binary.Read(r, binary.LittleEndian, m.TileMap); err != nil {
		return nil, fmt.Errorf("failed to read tile map: %w", err)
	}

	// Capture any padding between the tile-index block and the attribute block.
	mapDataEnd := int64(m.Header.PTRMapData) + int64(tileCount*2)
	if int64(m.Header.PTRMapAttr) > mapDataEnd {
		gap := int(int64(m.Header.PTRMapAttr) - mapDataEnd)
		m.MapDataPad = make([]byte, gap)
		if _, err := io.ReadFull(r, m.MapDataPad); err != nil {
			return nil, fmt.Errorf("failed to read mapdata padding: %w", err)
		}
	}

	// Read tile attributes (AttrW × AttrH entries at 16px resolution).
	if _, err := r.Seek(int64(m.Header.PTRMapAttr), io.SeekStart); err != nil {
		return nil, fmt.Errorf("failed to seek to map attr: %w", err)
	}
	attrCount := m.AttrW * m.AttrH
	m.TileAttr = make([]TileAttr, attrCount)
	for i := 0; i < attrCount; i++ {
		var a TileAttr
		a.Height = readByte(r)
		a.Feature = readUint16(r)
		a.Pad = readByte(r)
		m.TileAttr[i] = a
	}

	// Read tile graphics.
	if _, err := r.Seek(int64(m.Header.PTRTileGfx), io.SeekStart); err != nil {
		return nil, fmt.Errorf("failed to seek to tile gfx: %w", err)
	}
	m.Tiles = make([][]byte, m.Header.Tiles)
	for i := uint32(0); i < m.Header.Tiles; i++ {
		tile := make([]byte, 1024)
		if _, err := io.ReadFull(r, tile); err != nil {
			return nil, fmt.Errorf("failed to read tile %d: %w", i, err)
		}
		m.Tiles[i] = tile
	}

	// Read minimap.
	if m.Header.PTRMinimap > 0 {
		if _, err := r.Seek(int64(m.Header.PTRMinimap), io.SeekStart); err == nil {
			var mmW, mmH uint32
			if err := binary.Read(r, binary.LittleEndian, &mmW); err == nil {
				if err := binary.Read(r, binary.LittleEndian, &mmH); err == nil {
					if mmW > 0 && mmH > 0 && mmW <= 1024 && mmH <= 1024 {
						pixels := make([]byte, mmW*mmH)
						if _, err := io.ReadFull(r, pixels); err == nil {
							m.Minimap = pixels
							m.MinimapW = int(mmW)
							m.MinimapH = int(mmH)
						}
					}
				}
			}
		}
	}

	return m, nil
}

// loadTAK parses a TA: Kingdoms TNT. TA:K reuses the TNT container but stores
// Width/Height in 16px DataUnits and renders terrain by texture-mapping a grid
// of 32px Graphic Units: each unit names a JPG texture (0x20) plus a U/V offset
// (0x24/0x28) into it. A DataUnit-resolution heightmap (0x10) and feature grid
// (0x14) accompany a feature name table (0x18 / count 0x1c) and an embedded
// minimap (0x2c). Every section is read by its own header pointer and length.
func loadTAK(r io.ReadSeeker, m *Map) (*Map, error) {
	// The 0x4000 read/write variance lives in the tak subpackage; copy its
	// decoded sections onto the shared Map so existing consumers (rendering,
	// studio backdrop, save) keep working against Map's TAK* fields.
	tm, err := tak.Decode(r)
	if err != nil {
		return nil, err
	}
	m.IsTAK = true
	m.TAKW, m.TAKH = tm.W, tm.H
	m.TAKGUW, m.TAKGUH = tm.GUW, tm.GUH
	m.TAKHeight = tm.Height
	m.TAKFeatureGrid = tm.FeatureGrid
	m.TAKTerrainNames = tm.TerrainNames
	m.TAKUMap = tm.UMap
	m.TAKVMap = tm.VMap
	m.TAKFeatureTableRaw = tm.FeatureTableRaw
	m.Minimap = tm.Minimap
	m.MinimapW, m.MinimapH = tm.MinimapW, tm.MinimapH
	return m, nil
}

func readByte(r io.Reader) uint8 {
	var b [1]byte
	_, _ = io.ReadFull(r, b[:])
	return b[0]
}

func readUint16(r io.Reader) uint16 {
	var b [2]byte
	_, _ = io.ReadFull(r, b[:])
	return binary.LittleEndian.Uint16(b[:])
}

// RenderTileMap renders the full map as an RGBA image.
func (m *Map) RenderTileMap(palette color.Palette) *image.RGBA {
	w := m.TileW * 32
	h := m.TileH * 32
	img := image.NewRGBA(image.Rect(0, 0, w, h))

	for ty := 0; ty < m.TileH; ty++ {
		for tx := 0; tx < m.TileW; tx++ {
			tileIdx := m.TileMap[ty*m.TileW+tx]
			if int(tileIdx) >= len(m.Tiles) {
				continue
			}
			tile := m.Tiles[tileIdx]
			ox, oy := tx*32, ty*32
			for py := 0; py < 32; py++ {
				for px := 0; px < 32; px++ {
					palIdx := tile[py*32+px]
					c := color.RGBA{0, 0, 0, 255}
					if int(palIdx) < len(palette) {
						r, g, b, a := palette[palIdx].RGBA()
						c = color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
					}
					img.Set(ox+px, oy+py, c)
				}
			}
		}
	}
	return img
}

// RenderHeightMap renders elevation data as a normalized greyscale image.
// The image is AttrW × AttrH (16px resolution, 2× the tile grid). TA:K maps
// render from their DataUnit heightmap at the same 16px resolution.
func (m *Map) RenderHeightMap() *image.Gray {
	if m.IsTAK {
		return m.RenderTAKHeightmap()
	}
	if m.TileAttr == nil {
		return nil
	}
	img := image.NewGray(image.Rect(0, 0, m.AttrW, m.AttrH))

	minH, maxH := uint8(255), uint8(0)
	for _, a := range m.TileAttr {
		if a.Height < minH {
			minH = a.Height
		}
		if a.Height > maxH {
			maxH = a.Height
		}
	}

	for ay := 0; ay < m.AttrH; ay++ {
		for ax := 0; ax < m.AttrW; ax++ {
			h := m.TileAttr[ay*m.AttrW+ax].Height
			v := uint8(0)
			if maxH > minH {
				v = uint8(uint16(h-minH) * 255 / uint16(maxH-minH))
			}
			img.SetGray(ax, ay, color.Gray{v})
		}
	}
	return img
}

// MinimapVoidByte is the palette index used for minimap padding (outside map area).
const MinimapVoidByte = 0x64

// MinimapContentBounds returns the actual content area within the minimap,
// excluding the void padding (palette index 0x64) on the right and bottom.
func (m *Map) MinimapContentBounds() (contentW, contentH int) {
	if m.Minimap == nil {
		return 0, 0
	}
	// Scan from right on first row.
	contentW = 0
	for x := m.MinimapW - 1; x >= 0; x-- {
		if m.Minimap[x] != MinimapVoidByte {
			contentW = x + 1
			break
		}
	}
	// Scan from bottom on first column.
	contentH = 0
	for y := m.MinimapH - 1; y >= 0; y-- {
		if m.Minimap[y*m.MinimapW] != MinimapVoidByte {
			contentH = y + 1
			break
		}
	}
	return contentW, contentH
}

// RenderMinimap renders the minimap as an RGBA image.
// Void pixels (palette index 0x64) are rendered as transparent.
func (m *Map) RenderMinimap(palette color.Palette) *image.RGBA {
	if m.Minimap == nil {
		return nil
	}
	img := image.NewRGBA(image.Rect(0, 0, m.MinimapW, m.MinimapH))
	for y := 0; y < m.MinimapH; y++ {
		for x := 0; x < m.MinimapW; x++ {
			palIdx := m.Minimap[y*m.MinimapW+x]
			if palIdx == MinimapVoidByte {
				// Void/padding — transparent.
				continue
			}
			c := color.RGBA{0, 0, 0, 255}
			if int(palIdx) < len(palette) {
				r, g, b, a := palette[palIdx].RGBA()
				c = color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
			}
			img.Set(x, y, c)
		}
	}
	return img
}

// Feature is a named feature type from the TileAnim table.  Raw preserves
// the full 128-byte name buffer including any uninitialised scratch memory
// past the null terminator, so the table can round-trip byte-for-byte.  When
// Raw is empty the writer falls back to writing Name zero-padded.
type Feature struct {
	Index int
	Name  string
	Raw   [128]byte
}

// FeaturePlacement is a placed feature instance on the map.
type FeaturePlacement struct {
	FeatureIdx int // Index into Features
	AttrX      int // Attribute cell X (16px units)
	AttrY      int // Attribute cell Y (16px units)
	PixelX     int // Pixel X (AttrX * 16)
	PixelY     int // Pixel Y (AttrY * 16)
}

// LoadFeatures reads the feature name table. TA stores the table pointer at
// 0x20 (PTRTileAnim); TA:K stores it at 0x18. Both use the same count field
// (0x1c) and the same 4-byte-index + 128-byte-name entry layout.
func (m *Map) LoadFeatures(r io.ReadSeeker) ([]Feature, error) {
	count := m.Header.TileAnims
	if count == 0 {
		return nil, nil
	}
	tablePtr := m.Header.PTRTileAnim
	if m.IsTAK {
		tablePtr = m.Header.Tiles // TA:K keeps the feature-name table at 0x18
	}
	if _, err := r.Seek(int64(tablePtr), io.SeekStart); err != nil {
		return nil, err
	}

	features := make([]Feature, count)
	for i := uint32(0); i < count; i++ {
		var idx uint32
		if err := binary.Read(r, binary.LittleEndian, &idx); err != nil {
			return nil, err
		}
		var rawName [128]byte
		if _, err := io.ReadFull(r, rawName[:]); err != nil {
			return nil, err
		}
		name := string(rawName[:])
		if nul := strings.IndexByte(name, 0); nul >= 0 {
			name = name[:nul]
		}
		features[i] = Feature{Index: int(idx), Name: name, Raw: rawName}
	}
	return features, nil
}

// GetFeaturePlacements returns all placed features from the MapAttr grid.
func (m *Map) GetFeaturePlacements() []FeaturePlacement {
	if m.IsTAK {
		// TA:K stores placements in its DataUnit feature grid rather than
		// the TA attribute array; same 16px cell resolution either way.
		return m.TAKFeaturePlacements()
	}
	if m.TileAttr == nil {
		return nil
	}
	var placements []FeaturePlacement
	for ay := 0; ay < m.AttrH; ay++ {
		for ax := 0; ax < m.AttrW; ax++ {
			f := m.TileAttr[ay*m.AttrW+ax].Feature
			if f == 0xFFFF || f == 0xFFFC || f == 0xFFFE {
				continue
			}
			placements = append(placements, FeaturePlacement{
				FeatureIdx: int(f),
				AttrX:      ax,
				AttrY:      ay,
				PixelX:     ax * 16,
				PixelY:     ay * 16,
			})
		}
	}
	return placements
}

// takGraphicUnit is the pixel size of a TA: Kingdoms Graphic Unit (terrain
// texture tile). TAKDataUnit is half this: the DataUnit grid (heightmap and
// feature placement) is twice as fine as the Graphic-Unit terrain grid.
const takGraphicUnit = 32

// TAKDataUnit is the pixel size of a TA: Kingdoms DataUnit — the unit of the
// heightmap and feature-placement grids. Feature placements scale by this to
// reach full-resolution terrain pixels.
const TAKDataUnit = 16

// TAKPixelW and TAKPixelH report the full-resolution terrain render dimensions
// in pixels (Graphic-Unit grid × 32px).
func (m *Map) TAKPixelW() int { return m.TAKGUW * takGraphicUnit }
func (m *Map) TAKPixelH() int { return m.TAKGUH * takGraphicUnit }

// TAKFeaturePlacements returns every placed feature in a TA: Kingdoms map, read
// from the DataUnit-resolution feature grid. PixelX/PixelY scale the DataUnit
// cell (16px) up to the full-resolution terrain render, where feature sprites
// are anchored.
func (m *Map) TAKFeaturePlacements() []FeaturePlacement {
	if m.TAKFeatureGrid == nil || m.TAKW == 0 {
		return nil
	}
	var placements []FeaturePlacement
	for y := 0; y < m.TAKH; y++ {
		for x := 0; x < m.TAKW; x++ {
			v := m.TAKFeatureGrid[y*m.TAKW+x]
			if v >= takNoFeature {
				continue
			}
			placements = append(placements, FeaturePlacement{
				FeatureIdx: int(v),
				AttrX:      x,
				AttrY:      y,
				PixelX:     x * TAKDataUnit,
				PixelY:     y * TAKDataUnit,
			})
		}
	}
	return placements
}

// RenderTAKTerrain composites the full-resolution TA: Kingdoms terrain by
// copying a 32×32 tile from each Graphic Unit's source texture at its U/V
// offset. tex resolves a terrain name to its decoded texture image (the caller
// supplies the JPGs, typically from a VFS); a nil return leaves that unit's
// tile blank so missing textures are visible rather than fatal. Returns nil
// when the map carries no terrain-name table.
func (m *Map) RenderTAKTerrain(tex func(name uint32) image.Image) *image.RGBA {
	if !m.IsTAK || m.TAKGUW == 0 || m.TAKTerrainNames == nil {
		return nil
	}
	const gu = takGraphicUnit
	img := image.NewRGBA(image.Rect(0, 0, m.TAKPixelW(), m.TAKPixelH()))
	cache := make(map[uint32]image.Image)
	for gy := 0; gy < m.TAKGUH; gy++ {
		for gx := 0; gx < m.TAKGUW; gx++ {
			i := gy*m.TAKGUW + gx
			name := m.TAKTerrainNames[i]
			t, ok := cache[name]
			if !ok {
				t = tex(name)
				cache[name] = t
			}
			if t == nil {
				continue
			}
			sx := int(m.TAKUMap[i]) * gu
			sy := int(m.TAKVMap[i]) * gu
			dst := image.Rect(gx*gu, gy*gu, gx*gu+gu, gy*gu+gu)
			draw.Draw(img, dst, t, image.Point{X: sx, Y: sy}, draw.Src)
		}
	}
	return img
}

// RenderTAKHeightmap renders the TA: Kingdoms heightmap as a normalised
// greyscale image at DataUnit resolution (TAKW×TAKH). It needs no external
// assets, so it is the self-contained fallback when terrain textures are
// unavailable.
func (m *Map) RenderTAKHeightmap() *image.Gray {
	if m.TAKHeight == nil || m.TAKW == 0 {
		return nil
	}
	minH, maxH := uint8(255), uint8(0)
	for _, h := range m.TAKHeight {
		if h < minH {
			minH = h
		}
		if h > maxH {
			maxH = h
		}
	}
	span := int(maxH) - int(minH)
	img := image.NewGray(image.Rect(0, 0, m.TAKW, m.TAKH))
	for i, h := range m.TAKHeight {
		v := uint8(0)
		if span > 0 {
			v = uint8((int(h) - int(minH)) * 255 / span)
		}
		img.Pix[i] = v
	}
	return img
}

// WritePNG encodes an image to PNG format.
func WritePNG(w io.Writer, img image.Image) error {
	return png.Encode(w, img)
}
