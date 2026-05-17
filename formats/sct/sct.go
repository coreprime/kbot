// Package sct implements reading of Total Annihilation SCT (Section) map files.
//
// SCT files contain tile-based terrain sections used by the TA map editor.
// Each section has a grid of 32×32 pixel tiles, height data, and a 128×128 minimap.
package sct

import (
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
)

// Header is the 28-byte SCT file header.
type Header struct {
	Version    uint32 // Always 3
	PtrMinimap uint32 // Offset to 128×128 minimap
	NumTiles   uint32 // Number of 32×32 tiles
	PtrTiles   uint32 // Offset to tile pixel data
	Width      uint32 // Section width in tiles
	Height     uint32 // Section height in tiles
	PtrData    uint32 // Offset to section data (tile indices + height)
}

// HeightData is one height sample (4 per tile).
// In V3 files this is 4 bytes; in V2 files it is 8 bytes.
type HeightData struct {
	Height uint8
}

// Section is a parsed SCT file.
type Section struct {
	Header     Header
	Tiles      [][]byte     // NumTiles entries, each 1024 bytes (32×32 palette indices)
	TileMap    []int16      // Width×Height tile indices into Tiles
	HeightMap  []HeightData // (Width*2)×(Height*2) height samples at 16px resolution
	AttrW      int          // Width * 2 (attribute grid width)
	AttrH      int          // Height * 2 (attribute grid height)
	Minimap    []byte       // 128×128 palette indices
}

// LoadFromReader parses an SCT file from the given reader.
func LoadFromReader(r io.ReadSeeker) (*Section, error) {
	s := &Section{}

	// Read header.
	if err := binary.Read(r, binary.LittleEndian, &s.Header); err != nil {
		return nil, fmt.Errorf("failed to read SCT header: %w", err)
	}
	if s.Header.Version != 2 && s.Header.Version != 3 {
		return nil, fmt.Errorf("unsupported SCT version: %d (expected 2 or 3)", s.Header.Version)
	}

	// Read tiles.
	if _, err := r.Seek(int64(s.Header.PtrTiles), io.SeekStart); err != nil {
		return nil, fmt.Errorf("failed to seek to tiles: %w", err)
	}
	s.Tiles = make([][]byte, s.Header.NumTiles)
	for i := uint32(0); i < s.Header.NumTiles; i++ {
		tile := make([]byte, 1024) // 32×32
		if _, err := io.ReadFull(r, tile); err != nil {
			return nil, fmt.Errorf("failed to read tile %d: %w", i, err)
		}
		s.Tiles[i] = tile
	}

	// Read section data (tile indices).
	if _, err := r.Seek(int64(s.Header.PtrData), io.SeekStart); err != nil {
		return nil, fmt.Errorf("failed to seek to section data: %w", err)
	}
	tileCount := int(s.Header.Width * s.Header.Height)
	s.TileMap = make([]int16, tileCount)
	if err := binary.Read(r, binary.LittleEndian, s.TileMap); err != nil {
		return nil, fmt.Errorf("failed to read tile map: %w", err)
	}

	// Read height/attribute data.
	// The attribute grid is Width*2 × Height*2 (16px resolution).
	// Height data follows immediately after the tile map.
	// V3: 4 bytes per entry, V2: 8 bytes per entry.
	s.AttrW = int(s.Header.Width) * 2
	s.AttrH = int(s.Header.Height) * 2
	attrCount := s.AttrW * s.AttrH
	entrySize := 4
	if s.Header.Version == 2 {
		entrySize = 8
	}
	s.HeightMap = make([]HeightData, attrCount)
	for i := 0; i < attrCount; i++ {
		entry := make([]byte, entrySize)
		if _, err := io.ReadFull(r, entry); err != nil {
			s.HeightMap = nil
			break
		}
		s.HeightMap[i] = HeightData{Height: entry[0]}
	}

	// Read minimap.
	if s.Header.PtrMinimap > 0 {
		if _, err := r.Seek(int64(s.Header.PtrMinimap), io.SeekStart); err == nil {
			minimap := make([]byte, 128*128)
			if _, err := io.ReadFull(r, minimap); err == nil {
				s.Minimap = minimap
			}
		}
	}

	return s, nil
}

// RenderTileMap renders the full tile map as an RGBA image using the given palette.
func (s *Section) RenderTileMap(palette color.Palette) *image.RGBA {
	w := int(s.Header.Width) * 32
	h := int(s.Header.Height) * 32
	img := image.NewRGBA(image.Rect(0, 0, w, h))

	for ty := 0; ty < int(s.Header.Height); ty++ {
		for tx := 0; tx < int(s.Header.Width); tx++ {
			tileIdx := s.TileMap[ty*int(s.Header.Width)+tx]
			if tileIdx < 0 || int(tileIdx) >= len(s.Tiles) {
				continue
			}
			tile := s.Tiles[tileIdx]
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

// RenderHeightMap renders the height data as a normalized greyscale image.
// The attribute grid is AttrW × AttrH (2× the tile grid, at 16px resolution).
func (s *Section) RenderHeightMap() *image.Gray {
	if s.HeightMap == nil {
		return nil
	}
	img := image.NewGray(image.Rect(0, 0, s.AttrW, s.AttrH))

	minH, maxH := uint8(255), uint8(0)
	for _, hd := range s.HeightMap {
		if hd.Height < minH {
			minH = hd.Height
		}
		if hd.Height > maxH {
			maxH = hd.Height
		}
	}

	for ay := 0; ay < s.AttrH; ay++ {
		for ax := 0; ax < s.AttrW; ax++ {
			idx := ay*s.AttrW + ax
			if idx >= len(s.HeightMap) {
				continue
			}
			h := s.HeightMap[idx].Height
			v := uint8(128)
			if maxH > minH {
				v = uint8(uint16(h-minH) * 255 / uint16(maxH-minH))
			}
			img.SetGray(ax, ay, color.Gray{v})
		}
	}
	return img
}

// RenderMinimap renders the minimap as an RGBA image using the given palette.
func (s *Section) RenderMinimap(palette color.Palette) *image.RGBA {
	if s.Minimap == nil {
		return nil
	}
	img := image.NewRGBA(image.Rect(0, 0, 128, 128))
	for y := 0; y < 128; y++ {
		for x := 0; x < 128; x++ {
			palIdx := s.Minimap[y*128+x]
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

// WritePNG encodes an image to PNG format.
func WritePNG(w io.Writer, img image.Image) error {
	return png.Encode(w, img)
}
