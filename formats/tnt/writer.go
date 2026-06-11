package tnt

import (
	"encoding/binary"
	"fmt"
	"io"

	"github.com/coreprime/kbot/formats/tnt/tak"
)

// HeaderSize is the on-disk size of the TNT header in bytes.
const HeaderSize = 64

// TileGfxSize is the byte size of a single 32×32 tile graphic.
const TileGfxSize = 32 * 32

// TileAnimEntrySize is the on-disk size of a tile animation/feature entry.
const TileAnimEntrySize = 132

// Save writes the map to a TNT byte stream.  The features slice supplies
// the TileAnim feature table that ships with the TNT (the names referenced
// by TileAttr.Feature indices).  Pass nil if there are no features.
//
// Block layout produced:
//
//	0x00            header (64 B)
//	PTRMapData      tile index array  (TileW × TileH × uint16)
//	PTRMapAttr      attribute array   (AttrW × AttrH × 4 B)
//	PTRTileGfx      tile graphics     (Tiles × 1024 B)
//	PTRTileAnim     feature table     (Features × 132 B)
//	PTRMinimap      minimap           (8 B header + MinimapW × MinimapH)
func (m *Map) Save(w io.Writer, features []Feature) error {
	if m == nil {
		return fmt.Errorf("nil map")
	}
	if m.TileW <= 0 || m.TileH <= 0 || m.AttrW <= 0 || m.AttrH <= 0 {
		return fmt.Errorf("invalid map dimensions: tile=%dx%d attr=%dx%d",
			m.TileW, m.TileH, m.AttrW, m.AttrH)
	}
	if len(m.TileMap) != m.TileW*m.TileH {
		return fmt.Errorf("tile map length %d does not match TileW*TileH=%d",
			len(m.TileMap), m.TileW*m.TileH)
	}
	if len(m.TileAttr) != m.AttrW*m.AttrH {
		return fmt.Errorf("attr length %d does not match AttrW*AttrH=%d",
			len(m.TileAttr), m.AttrW*m.AttrH)
	}
	for i, tile := range m.Tiles {
		if len(tile) != TileGfxSize {
			return fmt.Errorf("tile %d is %d bytes, expected %d", i, len(tile), TileGfxSize)
		}
	}

	tiles := uint32(len(m.Tiles))
	anims := uint32(len(features))

	hdr := m.Header
	hdr.IDVersion = 8192
	hdr.Width = uint32(m.AttrW)
	hdr.Height = uint32(m.AttrH)
	hdr.Tiles = tiles
	hdr.TileAnims = anims

	mapDataBytes := uint32(m.TileW*m.TileH*2) + uint32(len(m.MapDataPad))
	hdr.PTRMapData = uint32(HeaderSize)
	hdr.PTRMapAttr = hdr.PTRMapData + mapDataBytes
	hdr.PTRTileGfx = hdr.PTRMapAttr + uint32(m.AttrW*m.AttrH*4)
	hdr.PTRTileAnim = hdr.PTRTileGfx + tiles*TileGfxSize
	hdr.PTRMinimap = hdr.PTRTileAnim + anims*TileAnimEntrySize

	if err := binary.Write(w, binary.LittleEndian, &hdr); err != nil {
		return fmt.Errorf("write header: %w", err)
	}

	if err := binary.Write(w, binary.LittleEndian, m.TileMap); err != nil {
		return fmt.Errorf("write tile map: %w", err)
	}
	if len(m.MapDataPad) > 0 {
		if _, err := w.Write(m.MapDataPad); err != nil {
			return fmt.Errorf("write mapdata padding: %w", err)
		}
	}

	attrBuf := make([]byte, 4*len(m.TileAttr))
	for i, a := range m.TileAttr {
		off := i * 4
		attrBuf[off] = a.Height
		binary.LittleEndian.PutUint16(attrBuf[off+1:off+3], a.Feature)
		attrBuf[off+3] = a.Pad
	}
	if _, err := w.Write(attrBuf); err != nil {
		return fmt.Errorf("write attributes: %w", err)
	}

	for i, tile := range m.Tiles {
		if _, err := w.Write(tile); err != nil {
			return fmt.Errorf("write tile %d: %w", i, err)
		}
	}

	for i, feat := range features {
		idx := uint32(feat.Index)
		if idx == 0 && i > 0 {
			idx = uint32(i)
		}
		if err := binary.Write(w, binary.LittleEndian, idx); err != nil {
			return fmt.Errorf("write feature %d index: %w", i, err)
		}
		name := feat.Raw
		if isZeroBytes(name[:]) {
			copy(name[:], feat.Name)
		}
		if _, err := w.Write(name[:]); err != nil {
			return fmt.Errorf("write feature %d name: %w", i, err)
		}
	}

	mmW := uint32(m.MinimapW)
	mmH := uint32(m.MinimapH)
	if err := binary.Write(w, binary.LittleEndian, mmW); err != nil {
		return fmt.Errorf("write minimap width: %w", err)
	}
	if err := binary.Write(w, binary.LittleEndian, mmH); err != nil {
		return fmt.Errorf("write minimap height: %w", err)
	}
	if mmW > 0 && mmH > 0 {
		expected := int(mmW) * int(mmH)
		if len(m.Minimap) != expected {
			return fmt.Errorf("minimap data length %d does not match %dx%d=%d",
				len(m.Minimap), mmW, mmH, expected)
		}
		if _, err := w.Write(m.Minimap); err != nil {
			return fmt.Errorf("write minimap pixels: %w", err)
		}
	}

	return nil
}

// SaveTAK writes a TA: Kingdoms (0x4000) TNT by delegating to the tak
// subpackage (which owns the 0x4000 read/write variance). It builds the
// subpackage's map view from the shared Map's TAK* fields — including the
// sea-level value and header padding preserved from the original header — so an
// edited heightmap / terrain-name / U-V / feature grid round-trips.
func (m *Map) SaveTAK(w io.Writer) error {
	if m == nil {
		return fmt.Errorf("nil map")
	}
	if !m.IsTAK {
		return fmt.Errorf("not a TA:K map (use Save for TA)")
	}
	tm := &tak.Map{
		W: m.TAKW, H: m.TAKH, GUW: m.TAKGUW, GUH: m.TAKGUH,
		Height: m.TAKHeight, FeatureGrid: m.TAKFeatureGrid,
		FeatureTableRaw: m.TAKFeatureTableRaw, TerrainNames: m.TAKTerrainNames,
		UMap: m.TAKUMap, VMap: m.TAKVMap,
		Minimap: m.Minimap, MinimapW: m.MinimapW, MinimapH: m.MinimapH,
	}
	// Preserve the non-pointer header values TA:K keeps (sea level at 0x0c,
	// the feature count at 0x1c, and the trailing pad words).
	tm.Header.SeaLevel = m.Header.PTRMapData
	tm.Header.FeatureCount = m.Header.TileAnims
	tm.Header.Pad = [4]uint32{m.Header.Pad1, m.Header.Pad2, m.Header.Pad3, m.Header.Pad4}
	return tak.Encode(w, tm)
}

func isZeroBytes(b []byte) bool {
	for _, v := range b {
		if v != 0 {
			return false
		}
	}
	return true
}
