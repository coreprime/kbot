package tnt

import (
	"bytes"
	"testing"
)

// makeSyntheticTAK builds a small, fully-populated TA:K map for round-trip
// testing without needing game assets. 4×4 DataUnits → 2×2 Graphic Units.
func makeSyntheticTAK(withFeatureTable bool) *Map {
	const W, H = 4, 4
	const guW, guH = 2, 2
	m := &Map{IsTAK: true, TAKW: W, TAKH: H, TAKGUW: guW, TAKGUH: guH}
	m.Header.IDVersion = VersionTAK
	m.Header.Width = W
	m.Header.Height = H
	m.Header.PTRMapData = 77 // TA:K sea level value (preserved verbatim)
	m.Header.Pad1 = 0xDEAD

	m.TAKHeight = make([]byte, W*H)
	for i := range m.TAKHeight {
		m.TAKHeight[i] = byte(i * 3)
	}
	m.TAKFeatureGrid = make([]uint16, W*H)
	for i := range m.TAKFeatureGrid {
		m.TAKFeatureGrid[i] = uint16(0xFF00 + i) // mostly "none" sentinels
	}
	m.TAKTerrainNames = []uint32{0x10, 0x20, 0x30, 0x40}
	m.TAKUMap = []byte{1, 2, 3, 4}
	m.TAKVMap = []byte{5, 6, 7, 8}
	m.Minimap = []byte{11, 22, 33, 44}
	m.MinimapW, m.MinimapH = 2, 2

	if withFeatureTable {
		m.Header.TileAnims = 2
		m.TAKFeatureTableRaw = []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF}
	}
	return m
}

func TestSaveTAKRoundTrip(t *testing.T) {
	for _, withFeat := range []bool{false, true} {
		src := makeSyntheticTAK(withFeat)
		var buf bytes.Buffer
		if err := src.SaveTAK(&buf); err != nil {
			t.Fatalf("SaveTAK(withFeat=%v): %v", withFeat, err)
		}
		got, err := LoadFromReader(bytes.NewReader(buf.Bytes()))
		if err != nil {
			t.Fatalf("reload(withFeat=%v): %v", withFeat, err)
		}
		if !got.IsTAK {
			t.Fatalf("reload not flagged TA:K")
		}
		if got.TAKW != src.TAKW || got.TAKH != src.TAKH || got.TAKGUW != src.TAKGUW || got.TAKGUH != src.TAKGUH {
			t.Errorf("dims: got %dx%d (gu %dx%d) want %dx%d (gu %dx%d)",
				got.TAKW, got.TAKH, got.TAKGUW, got.TAKGUH, src.TAKW, src.TAKH, src.TAKGUW, src.TAKGUH)
		}
		if !bytes.Equal(got.TAKHeight, src.TAKHeight) {
			t.Errorf("heightmap mismatch: %v vs %v", got.TAKHeight, src.TAKHeight)
		}
		if len(got.TAKFeatureGrid) != len(src.TAKFeatureGrid) {
			t.Fatalf("feature grid len %d != %d", len(got.TAKFeatureGrid), len(src.TAKFeatureGrid))
		}
		for i := range src.TAKFeatureGrid {
			if got.TAKFeatureGrid[i] != src.TAKFeatureGrid[i] {
				t.Errorf("feature grid[%d]: %d != %d", i, got.TAKFeatureGrid[i], src.TAKFeatureGrid[i])
			}
		}
		if len(got.TAKTerrainNames) != len(src.TAKTerrainNames) {
			t.Fatalf("terrain names len %d != %d", len(got.TAKTerrainNames), len(src.TAKTerrainNames))
		}
		for i := range src.TAKTerrainNames {
			if got.TAKTerrainNames[i] != src.TAKTerrainNames[i] {
				t.Errorf("terrain name[%d]: %x != %x", i, got.TAKTerrainNames[i], src.TAKTerrainNames[i])
			}
		}
		if !bytes.Equal(got.TAKUMap, src.TAKUMap) {
			t.Errorf("U-map mismatch: %v vs %v", got.TAKUMap, src.TAKUMap)
		}
		if !bytes.Equal(got.TAKVMap, src.TAKVMap) {
			t.Errorf("V-map mismatch: %v vs %v", got.TAKVMap, src.TAKVMap)
		}
		if !bytes.Equal(got.Minimap, src.Minimap) || got.MinimapW != src.MinimapW || got.MinimapH != src.MinimapH {
			t.Errorf("minimap mismatch: %v %dx%d vs %v %dx%d",
				got.Minimap, got.MinimapW, got.MinimapH, src.Minimap, src.MinimapW, src.MinimapH)
		}
		// TA:K-specific header values must survive (sea level + an arbitrary pad).
		if got.Header.PTRMapData != src.Header.PTRMapData {
			t.Errorf("sea level (PTRMapData): %d != %d", got.Header.PTRMapData, src.Header.PTRMapData)
		}
		if got.Header.Pad1 != src.Header.Pad1 {
			t.Errorf("pad1: %x != %x", got.Header.Pad1, src.Header.Pad1)
		}
		if withFeat && !bytes.Equal(got.TAKFeatureTableRaw, src.TAKFeatureTableRaw) {
			t.Errorf("feature table raw mismatch: %v vs %v", got.TAKFeatureTableRaw, src.TAKFeatureTableRaw)
		}
	}
}
