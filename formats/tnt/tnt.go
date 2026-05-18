// Package tnt implements reading of Total Annihilation TNT map files.
package tnt

import (
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
)

// Header is the 64-byte TNT file header.
type Header struct {
	IDVersion   uint32 // Always 8192 (0x2000)
	Width       uint32 // Map width in 16px attribute cells (tile width = Width/2)
	Height      uint32 // Map height in 16px attribute cells (tile height = Height/2)
	PTRMapData  uint32 // Offset to tile index array (uint16 × TileW × TileH)
	PTRMapAttr  uint32 // Offset to attribute array (4 bytes × Width × Height)
	PTRTileGfx  uint32 // Offset to tile graphics (32×32 palette indices)
	Tiles       uint32 // Number of unique tiles
	TileAnims   uint32 // Number of tile animation/feature entries
	PTRTileAnim uint32 // Offset to tile animation structures
	SeaLevel    uint32 // Heights below this are underwater
	PTRMinimap  uint32 // Offset to minimap (252×252)
	Unknown1    uint32
	Pad1        uint32
	Pad2        uint32
	Pad3        uint32
	Pad4        uint32
}

// TileAttr is the per-cell attribute (4 bytes).
// There is one attribute per 16×16 pixel cell — 4 per 32×32 tile.
type TileAttr struct {
	Height  uint8  // Elevation at this cell
	Feature uint16 // Feature index (0xFFFF = none)
	Pad     uint8
}

// Map is a parsed TNT file.
type Map struct {
	Header   Header
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

	if m.Header.IDVersion != 8192 {
		return nil, fmt.Errorf("unsupported TNT version: %d (expected 8192)", m.Header.IDVersion)
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
// The image is AttrW × AttrH (16px resolution, 2× the tile grid).
func (m *Map) RenderHeightMap() *image.Gray {
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

// LoadFeatures reads the feature name table from the TileAnim section.
func (m *Map) LoadFeatures(r io.ReadSeeker) ([]Feature, error) {
	if m.Header.TileAnims == 0 {
		return nil, nil
	}
	if _, err := r.Seek(int64(m.Header.PTRTileAnim), io.SeekStart); err != nil {
		return nil, err
	}

	features := make([]Feature, m.Header.TileAnims)
	for i := uint32(0); i < m.Header.TileAnims; i++ {
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

// WritePNG encodes an image to PNG format.
func WritePNG(w io.Writer, img image.Image) error {
	return png.Encode(w, img)
}
