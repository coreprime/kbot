// Package tak implements read/write for the TA: Kingdoms (0x4000) variant of
// the TNT map container. TA:Kingdoms reuses the 64-byte TNT header but
// repurposes every pointer slot and renders terrain by texture-mapping a grid
// of 32px Graphic Units rather than stamping 32×32 tiles — so its parsing and
// serialisation differ enough to live in their own subpackage (mirroring the
// per-variant split under formats/hpi).
package tak

import (
	"encoding/binary"
	"fmt"
	"io"
)

// Version is the TNT IDVersion that marks a TA:Kingdoms map (0x4000).
const Version = 16384

// GraphicUnit is the pixel size of a TA:K terrain Graphic Unit.
const GraphicUnit = 32

// NoFeature is the threshold at/above which a feature-grid cell means "none".
const NoFeature = 0xFF00

// maxPixels bounds allocations against a corrupt header.
const maxPixels = 4096 * 4096

// Header is the TA:Kingdoms view of the 64-byte TNT header. Each field names
// the TA:K meaning of the slot the TA format uses for something else:
//
//	0x00 Version (0x4000)
//	0x04 Width / 0x08 Height — in 16px DataUnits (Graphic Units = /2)
//	0x0c SeaLevel
//	0x10 HeightPtr        — Width×Height bytes, one per DataUnit
//	0x14 FeatureGridPtr   — Width×Height uint16 (>=NoFeature means none)
//	0x18 FeatureTablePtr  — feature-name table
//	0x1c FeatureCount
//	0x20 TerrainNamesPtr  — guW×guH uint32 ("%08X.JPG")
//	0x24 UMapPtr          — guW×guH bytes (texture column, 32px units)
//	0x28 VMapPtr          — guW×guH bytes (texture row, 32px units)
//	0x2c MinimapPtr       — 8-byte (w,h) header + w*h palette indices
//	0x30 Pad[4]
type Header struct {
	Version         uint32
	Width           uint32
	Height          uint32
	SeaLevel        uint32
	HeightPtr       uint32
	FeatureGridPtr  uint32
	FeatureTablePtr uint32
	FeatureCount    uint32
	TerrainNamesPtr uint32
	UMapPtr         uint32
	VMapPtr         uint32
	MinimapPtr      uint32
	Pad             [4]uint32
}

// Map is the decoded TA:Kingdoms map. Width/Height are in 16px DataUnits; the
// terrain grid (GUW×GUH) is half that on each axis (32px Graphic Units).
type Map struct {
	Header          Header
	W, H            int // DataUnits
	GUW, GUH        int // Graphic Units
	Height          []byte
	FeatureGrid     []uint16
	FeatureTableRaw []byte // captured verbatim; internal layout not modelled
	TerrainNames    []uint32
	UMap, VMap      []byte
	Minimap         []byte
	MinimapW        int
	MinimapH        int
}

// Decode parses a TA:Kingdoms TNT from the start of r.
func Decode(r io.ReadSeeker) (*Map, error) {
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	m := &Map{}
	if err := binary.Read(r, binary.LittleEndian, &m.Header); err != nil {
		return nil, fmt.Errorf("read TA:K header: %w", err)
	}
	if m.Header.Version != Version {
		return nil, fmt.Errorf("not a TA:K TNT: version %#x", m.Header.Version)
	}
	m.W = int(m.Header.Width)
	m.H = int(m.Header.Height)
	m.GUW = m.W / 2
	m.GUH = m.H / 2

	n := m.W * m.H
	if n > 0 && n <= maxPixels {
		if buf, err := readSection(r, m.Header.HeightPtr, n); err == nil {
			m.Height = buf
		}
		if raw, err := readSection(r, m.Header.FeatureGridPtr, n*2); err == nil {
			grid := make([]uint16, n)
			for i := 0; i < n; i++ {
				grid[i] = binary.LittleEndian.Uint16(raw[i*2:])
			}
			m.FeatureGrid = grid
		}
	}
	gu := m.GUW * m.GUH
	if gu > 0 && gu <= maxPixels {
		if raw, err := readSection(r, m.Header.TerrainNamesPtr, gu*4); err == nil {
			names := make([]uint32, gu)
			for i := 0; i < gu; i++ {
				names[i] = binary.LittleEndian.Uint32(raw[i*4:])
			}
			m.TerrainNames = names
		}
		if buf, err := readSection(r, m.Header.UMapPtr, gu); err == nil {
			m.UMap = buf
		}
		if buf, err := readSection(r, m.Header.VMapPtr, gu); err == nil {
			m.VMap = buf
		}
	}
	m.captureFeatureTable(r)
	m.readMinimap(r)
	return m, nil
}

// captureFeatureTable copies the feature-name table verbatim (its internal
// layout isn't modelled) so Encode can write it back unchanged. The span is
// bounded by the next section pointer above it, or end-of-file.
func (m *Map) captureFeatureTable(r io.ReadSeeker) {
	ft := m.Header.FeatureTablePtr
	if ft == 0 || m.Header.FeatureCount == 0 {
		return
	}
	fileEnd, err := r.Seek(0, io.SeekEnd)
	if err != nil {
		return
	}
	end := fileEnd
	for _, p := range []uint32{
		m.Header.HeightPtr, m.Header.FeatureGridPtr, m.Header.TerrainNamesPtr,
		m.Header.UMapPtr, m.Header.VMapPtr, m.Header.MinimapPtr,
	} {
		if int64(p) > int64(ft) && int64(p) < end {
			end = int64(p)
		}
	}
	if nbytes := int(end - int64(ft)); nbytes > 0 && nbytes <= maxPixels {
		if raw, err := readSection(r, ft, nbytes); err == nil {
			m.FeatureTableRaw = raw
		}
	}
}

func (m *Map) readMinimap(r io.ReadSeeker) {
	if m.Header.MinimapPtr == 0 {
		return
	}
	if _, err := r.Seek(int64(m.Header.MinimapPtr), io.SeekStart); err != nil {
		return
	}
	var mmW, mmH uint32
	if err := binary.Read(r, binary.LittleEndian, &mmW); err != nil {
		return
	}
	if err := binary.Read(r, binary.LittleEndian, &mmH); err != nil {
		return
	}
	if mmW > 0 && mmH > 0 && mmW <= 1024 && mmH <= 1024 {
		pixels := make([]byte, mmW*mmH)
		if _, err := io.ReadFull(r, pixels); err == nil {
			m.Minimap = pixels
			m.MinimapW = int(mmW)
			m.MinimapH = int(mmH)
		}
	}
}

func readSection(r io.ReadSeeker, ptr uint32, n int) ([]byte, error) {
	if _, err := r.Seek(int64(ptr), io.SeekStart); err != nil {
		return nil, err
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}
