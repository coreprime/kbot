package tak

import (
	"bytes"
	"testing"
)

func makeSynthetic(withFeatureTable bool) *Map {
	const W, H = 4, 4
	m := &Map{W: W, H: H, GUW: W / 2, GUH: H / 2}
	m.Header.SeaLevel = 77
	m.Header.Pad[0] = 0xDEAD
	m.Height = make([]byte, W*H)
	for i := range m.Height {
		m.Height[i] = byte(i * 3)
	}
	m.FeatureGrid = make([]uint16, W*H)
	for i := range m.FeatureGrid {
		m.FeatureGrid[i] = uint16(NoFeature + i)
	}
	m.TerrainNames = []uint32{0x10, 0x20, 0x30, 0x40}
	m.UMap = []byte{1, 2, 3, 4}
	m.VMap = []byte{5, 6, 7, 8}
	m.Minimap = []byte{11, 22, 33, 44}
	m.MinimapW, m.MinimapH = 2, 2
	if withFeatureTable {
		m.Header.FeatureCount = 2
		m.FeatureTableRaw = []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF}
	}
	return m
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	for _, withFeat := range []bool{false, true} {
		src := makeSynthetic(withFeat)
		var buf bytes.Buffer
		if err := Encode(&buf, src); err != nil {
			t.Fatalf("Encode(withFeat=%v): %v", withFeat, err)
		}
		got, err := Decode(bytes.NewReader(buf.Bytes()))
		if err != nil {
			t.Fatalf("Decode(withFeat=%v): %v", withFeat, err)
		}
		if got.W != src.W || got.H != src.H || got.GUW != src.GUW || got.GUH != src.GUH {
			t.Errorf("dims: got %dx%d gu %dx%d", got.W, got.H, got.GUW, got.GUH)
		}
		if !bytes.Equal(got.Height, src.Height) {
			t.Errorf("heightmap mismatch")
		}
		if len(got.FeatureGrid) != len(src.FeatureGrid) {
			t.Fatalf("feature grid len %d != %d", len(got.FeatureGrid), len(src.FeatureGrid))
		}
		for i := range src.FeatureGrid {
			if got.FeatureGrid[i] != src.FeatureGrid[i] {
				t.Errorf("feature grid[%d] mismatch", i)
			}
		}
		for i := range src.TerrainNames {
			if got.TerrainNames[i] != src.TerrainNames[i] {
				t.Errorf("terrain name[%d] mismatch", i)
			}
		}
		if !bytes.Equal(got.UMap, src.UMap) || !bytes.Equal(got.VMap, src.VMap) {
			t.Errorf("U/V map mismatch")
		}
		if !bytes.Equal(got.Minimap, src.Minimap) || got.MinimapW != src.MinimapW || got.MinimapH != src.MinimapH {
			t.Errorf("minimap mismatch")
		}
		if got.Header.SeaLevel != src.Header.SeaLevel {
			t.Errorf("sea level: %d != %d", got.Header.SeaLevel, src.Header.SeaLevel)
		}
		if got.Header.Pad[0] != src.Header.Pad[0] {
			t.Errorf("pad mismatch")
		}
		if withFeat && !bytes.Equal(got.FeatureTableRaw, src.FeatureTableRaw) {
			t.Errorf("feature table mismatch")
		}
	}
}
