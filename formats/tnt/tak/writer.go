package tak

import (
	"encoding/binary"
	"fmt"
	"io"
)

// headerSize is the on-disk size of the 64-byte TNT header.
const headerSize = 64

// Encode writes a TA:Kingdoms (0x4000) TNT byte stream, relaying every section
// back out with freshly-computed header pointers so an edited heightmap /
// terrain-name / U-V / feature grid round-trips. The feature-name table is
// written verbatim from FeatureTableRaw and the minimap is re-emitted.
//
// Section order after the 64-byte header:
//
//	heightmap (W·H) → feature grid (W·H·uint16) → feature-name table (raw) →
//	terrain names (gu·uint32) → U-map (gu) → V-map (gu) → minimap (8 + w·h)
func Encode(w io.Writer, m *Map) error {
	if m == nil {
		return fmt.Errorf("nil map")
	}
	gu := m.GUW * m.GUH
	if m.W <= 0 || m.H <= 0 || gu <= 0 {
		return fmt.Errorf("invalid TA:K dimensions: %dx%d (gu=%d)", m.W, m.H, gu)
	}
	if len(m.Height) != m.W*m.H {
		return fmt.Errorf("heightmap length %d != W*H=%d", len(m.Height), m.W*m.H)
	}
	if len(m.FeatureGrid) != m.W*m.H {
		return fmt.Errorf("feature grid length %d != W*H=%d", len(m.FeatureGrid), m.W*m.H)
	}
	if len(m.TerrainNames) != gu {
		return fmt.Errorf("terrain names length %d != gu=%d", len(m.TerrainNames), gu)
	}
	if len(m.UMap) != gu || len(m.VMap) != gu {
		return fmt.Errorf("U/V map lengths %d/%d != gu=%d", len(m.UMap), len(m.VMap), gu)
	}

	hdr := m.Header
	hdr.Version = Version
	hdr.Width = uint32(m.W)
	hdr.Height = uint32(m.H)

	off := uint32(headerSize)
	hdr.HeightPtr = off
	off += uint32(m.W * m.H)
	hdr.FeatureGridPtr = off
	off += uint32(m.W * m.H * 2)
	hdr.FeatureTablePtr = 0
	if len(m.FeatureTableRaw) > 0 {
		hdr.FeatureTablePtr = off
		off += uint32(len(m.FeatureTableRaw))
	}
	hdr.TerrainNamesPtr = off
	off += uint32(gu * 4)
	hdr.UMapPtr = off
	off += uint32(gu)
	hdr.VMapPtr = off
	off += uint32(gu)
	hdr.MinimapPtr = 0
	if m.Minimap != nil && m.MinimapW > 0 && m.MinimapH > 0 {
		hdr.MinimapPtr = off
	}

	if err := binary.Write(w, binary.LittleEndian, &hdr); err != nil {
		return fmt.Errorf("write TA:K header: %w", err)
	}
	if _, err := w.Write(m.Height); err != nil {
		return fmt.Errorf("write heightmap: %w", err)
	}
	fg := make([]byte, m.W*m.H*2)
	for i, v := range m.FeatureGrid {
		binary.LittleEndian.PutUint16(fg[i*2:], v)
	}
	if _, err := w.Write(fg); err != nil {
		return fmt.Errorf("write feature grid: %w", err)
	}
	if len(m.FeatureTableRaw) > 0 {
		if _, err := w.Write(m.FeatureTableRaw); err != nil {
			return fmt.Errorf("write feature table: %w", err)
		}
	}
	tn := make([]byte, gu*4)
	for i, v := range m.TerrainNames {
		binary.LittleEndian.PutUint32(tn[i*4:], v)
	}
	if _, err := w.Write(tn); err != nil {
		return fmt.Errorf("write terrain names: %w", err)
	}
	if _, err := w.Write(m.UMap); err != nil {
		return fmt.Errorf("write U-map: %w", err)
	}
	if _, err := w.Write(m.VMap); err != nil {
		return fmt.Errorf("write V-map: %w", err)
	}
	if hdr.MinimapPtr != 0 {
		if err := binary.Write(w, binary.LittleEndian, uint32(m.MinimapW)); err != nil {
			return fmt.Errorf("write minimap width: %w", err)
		}
		if err := binary.Write(w, binary.LittleEndian, uint32(m.MinimapH)); err != nil {
			return fmt.Errorf("write minimap height: %w", err)
		}
		if _, err := w.Write(m.Minimap); err != nil {
			return fmt.Errorf("write minimap pixels: %w", err)
		}
	}
	return nil
}
