package tak

import "testing"

// newBlankMap builds an empty TA:K map of the given DataUnit dimensions with all
// terrain layers allocated and zeroed.
func newBlankMap(w, h int) *Map {
	guW, guH := w/2, h/2
	return &Map{
		W: w, H: h, GUW: guW, GUH: guH,
		Height:       make([]byte, w*h),
		FeatureGrid:  make([]uint16, w*h),
		TerrainNames: make([]uint32, guW*guH),
		UMap:         make([]byte, guW*guH),
		VMap:         make([]byte, guW*guH),
	}
}

func TestStampSection(t *testing.T) {
	// 8×8 DataUnits = 4×4 Graphic Units destination.
	dst := newBlankMap(8, 8)
	// 4×4 DataUnits = 2×2 GU section, with recognisable values.
	src := newBlankMap(4, 4)
	for i := range src.TerrainNames {
		src.TerrainNames[i] = uint32(0x100 + i)
		src.UMap[i] = byte(10 + i)
		src.VMap[i] = byte(20 + i)
	}
	for i := range src.Height {
		src.Height[i] = byte(50 + i)
		src.FeatureGrid[i] = uint16(0x200 + i)
	}

	// Stamp at graphic-unit (1,1) → DataUnit (2,2).
	dst.StampSection(src, 1, 1)

	// Graphic-unit layers: dst GU (1,1)..(2,2) must equal src GU (0,0)..(1,1).
	for sy := 0; sy < src.GUH; sy++ {
		for sx := 0; sx < src.GUW; sx++ {
			si := sy*src.GUW + sx
			di := (1+sy)*dst.GUW + (1 + sx)
			if dst.TerrainNames[di] != src.TerrainNames[si] {
				t.Errorf("terrain name at dst GU(%d,%d)=%x want %x", 1+sx, 1+sy, dst.TerrainNames[di], src.TerrainNames[si])
			}
			if dst.UMap[di] != src.UMap[si] || dst.VMap[di] != src.VMap[si] {
				t.Errorf("U/V at dst GU(%d,%d) mismatch", 1+sx, 1+sy)
			}
		}
	}
	// DataUnit layers: dst DU (2,2).. must equal src DU (0,0)..
	for sy := 0; sy < src.H; sy++ {
		for sx := 0; sx < src.W; sx++ {
			si := sy*src.W + sx
			di := (2+sy)*dst.W + (2 + sx)
			if dst.Height[di] != src.Height[si] {
				t.Errorf("height at dst DU(%d,%d)=%d want %d", 2+sx, 2+sy, dst.Height[di], src.Height[si])
			}
			if dst.FeatureGrid[di] != src.FeatureGrid[si] {
				t.Errorf("feature at dst DU(%d,%d) mismatch", 2+sx, 2+sy)
			}
		}
	}
	// A cell outside the stamp must stay zero (GU 0,0).
	if dst.TerrainNames[0] != 0 {
		t.Errorf("GU(0,0) should be untouched, got %x", dst.TerrainNames[0])
	}
}

func TestStampSectionClipsAtEdge(t *testing.T) {
	dst := newBlankMap(4, 4) // 2×2 GU
	src := newBlankMap(4, 4) // 2×2 GU
	for i := range src.TerrainNames {
		src.TerrainNames[i] = 0xABCD
	}
	// Stamp so only the top-left GU lands inside (offset (1,1) on a 2×2 grid).
	dst.StampSection(src, 1, 1)
	if dst.TerrainNames[1*dst.GUW+1] != 0xABCD {
		t.Errorf("in-bounds GU(1,1) not stamped")
	}
	// Round-trip safety: stamping must not have panicked or corrupted lengths.
	if len(dst.TerrainNames) != dst.GUW*dst.GUH {
		t.Errorf("terrain names length changed")
	}
}
