package tnt

import (
	"bytes"
	"image"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/internal/testutil"
)

// TestTAKVersionAccepted confirms the parser now recognises the TA: Kingdoms
// TNT version word (0x4000) instead of hard-rejecting it, and flags the map
// as a TA:K variant.
func TestTAKVersionAccepted(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "maps", "athri cay.tnt")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	m, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader: %v", err)
	}
	if !m.IsTAK {
		t.Error("expected IsTAK = true for a TA: Kingdoms map")
	}
	if m.Header.IDVersion != VersionTAK {
		t.Errorf("IDVersion = 0x%X, want 0x%X", m.Header.IDVersion, VersionTAK)
	}
	// athri cay is a 15x15 map: 480x480 pixel extent.
	if m.Header.Width != 480 || m.Header.Height != 480 {
		t.Errorf("dims = %dx%d px, want 480x480", m.Header.Width, m.Header.Height)
	}
}

// TestTAKMinimap pins the embedded minimap geometry. Across the entire shipped
// TA:K corpus the minimap is a 126x126 paletted block, so a regression in the
// 0x2c pointer or the read length is caught here.
func TestTAKMinimap(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "maps", "athri cay.tnt")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	m, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader: %v", err)
	}
	if m.MinimapW != 126 || m.MinimapH != 126 {
		t.Errorf("minimap = %dx%d, want 126x126", m.MinimapW, m.MinimapH)
	}
	if len(m.Minimap) != 126*126 {
		t.Errorf("minimap bytes = %d, want %d", len(m.Minimap), 126*126)
	}
}

// TestTAKTerrainAndFeatures pins the decoded heightmap, the texture-mapping
// grid (terrain names + U/V maps), and the feature placement grid + name table
// for a known map.
func TestTAKTerrainAndFeatures(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "maps", "athri cay.tnt")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	m, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader: %v", err)
	}

	// athri cay is 480×480 DataUnits; the Graphic-Unit grid is half that.
	if m.TAKW != 480 || m.TAKH != 480 {
		t.Errorf("TAK DataUnit dims = %dx%d, want 480x480", m.TAKW, m.TAKH)
	}
	if m.TAKGUW != 240 || m.TAKGUH != 240 {
		t.Errorf("TAK GraphicUnit dims = %dx%d, want 240x240", m.TAKGUW, m.TAKGUH)
	}
	if m.TAKPixelW() != 7680 || m.TAKPixelH() != 7680 {
		t.Errorf("TAK pixel dims = %dx%d, want 7680x7680", m.TAKPixelW(), m.TAKPixelH())
	}

	// Heightmap and feature grid are one entry per DataUnit.
	if len(m.TAKHeight) != m.TAKW*m.TAKH {
		t.Errorf("TAKHeight len = %d, want %d", len(m.TAKHeight), m.TAKW*m.TAKH)
	}
	if len(m.TAKFeatureGrid) != m.TAKW*m.TAKH {
		t.Errorf("TAKFeatureGrid len = %d, want %d", len(m.TAKFeatureGrid), m.TAKW*m.TAKH)
	}
	// Terrain-name and U/V maps are one entry per Graphic Unit.
	gu := m.TAKGUW * m.TAKGUH
	if len(m.TAKTerrainNames) != gu {
		t.Errorf("TAKTerrainNames len = %d, want %d", len(m.TAKTerrainNames), gu)
	}
	if len(m.TAKUMap) != gu || len(m.TAKVMap) != gu {
		t.Errorf("U/V map len = %d/%d, want %d", len(m.TAKUMap), len(m.TAKVMap), gu)
	}

	// athri cay ships 48 features with 582 placements (verified against the
	// shipped file).
	features, err := m.LoadFeatures(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFeatures: %v", err)
	}
	if len(features) != 48 {
		t.Errorf("features = %d, want 48", len(features))
	}
	if features[33].Name != "VerTree01" {
		t.Errorf("feature[33] = %q, want VerTree01", features[33].Name)
	}
	placements := m.TAKFeaturePlacements()
	if len(placements) != 582 {
		t.Errorf("placements = %d, want 582", len(placements))
	}
	// Every placement must index a real feature and scale to full-res pixels.
	for _, p := range placements {
		if p.FeatureIdx < 0 || p.FeatureIdx >= len(features) {
			t.Fatalf("placement idx %d out of range", p.FeatureIdx)
		}
		if p.PixelX != p.AttrX*TAKDataUnit || p.PixelY != p.AttrY*TAKDataUnit {
			t.Fatalf("placement pixel (%d,%d) != cell (%d,%d)*%d",
				p.PixelX, p.PixelY, p.AttrX, p.AttrY, TAKDataUnit)
		}
	}

	// The heightmap render is self-contained at DataUnit resolution.
	gray := m.RenderTAKHeightmap()
	if gray == nil {
		t.Fatal("RenderTAKHeightmap returned nil")
	}
	if b := gray.Bounds(); b.Dx() != m.TAKW || b.Dy() != m.TAKH {
		t.Errorf("heightmap bounds = %dx%d, want %dx%d", b.Dx(), b.Dy(), m.TAKW, m.TAKH)
	}

	// The terrain render copies a 32×32 tile per Graphic Unit; with a
	// blank-tile provider it still yields a full-size canvas.
	blank := image.NewRGBA(image.Rect(0, 0, takGraphicUnit, takGraphicUnit))
	terrain := m.RenderTAKTerrain(func(uint32) image.Image { return blank })
	if terrain == nil {
		t.Fatal("RenderTAKTerrain returned nil")
	}
	if b := terrain.Bounds(); b.Dx() != m.TAKPixelW() || b.Dy() != m.TAKPixelH() {
		t.Errorf("terrain bounds = %dx%d, want %dx%d", b.Dx(), b.Dy(), m.TAKPixelW(), m.TAKPixelH())
	}
}

// TestTAKHeightmapDispatch guards that the generic height renderers serve
// TA:K maps from the DataUnit heightmap instead of returning nil (which
// crashed `kbot tnt heightmap` on TA:K input).
func TestTAKHeightmapDispatch(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "maps", "athri cay.tnt")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	m, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader: %v", err)
	}
	norm := m.RenderHeightMap()
	if norm == nil {
		t.Fatal("RenderHeightMap returned nil for TA:K map")
	}
	if b := norm.Bounds(); b.Dx() != m.TAKW || b.Dy() != m.TAKH {
		t.Errorf("normalized bounds = %dx%d, want %dx%d", b.Dx(), b.Dy(), m.TAKW, m.TAKH)
	}
	raw := m.RenderHeightMapRaw()
	if raw == nil {
		t.Fatal("RenderHeightMapRaw returned nil for TA:K map")
	}
	if b := raw.Bounds(); b.Dx() != m.TAKW || b.Dy() != m.TAKH {
		t.Errorf("raw bounds = %dx%d, want %dx%d", b.Dx(), b.Dy(), m.TAKW, m.TAKH)
	}
	// Raw means raw: pixel bytes equal the stored elevation bytes.
	if !bytes.Equal(raw.Pix, m.TAKHeight) {
		t.Error("raw heightmap pixels differ from stored TAKHeight bytes")
	}
}

// TestTAKParseAllMaps walks every TA:K .tnt and asserts the header + minimap
// parse consistently across the shipped corpus.
func TestTAKParseAllMaps(t *testing.T) {
	dir := testutil.TAKUnpackedDir(t, "maps")

	var seen int
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".tnt") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("%s: read: %v", filepath.Base(path), err)
			return nil
		}
		m, err := LoadFromReader(bytes.NewReader(data))
		if err != nil {
			t.Errorf("%s: %v", filepath.Base(path), err)
			return nil
		}
		if !m.IsTAK {
			t.Errorf("%s: expected IsTAK", filepath.Base(path))
		}
		if m.MinimapW != 126 || m.MinimapH != 126 {
			t.Errorf("%s: minimap %dx%d, want 126x126", filepath.Base(path), m.MinimapW, m.MinimapH)
		}
		// Heightmap and feature grid are one entry per DataUnit; the
		// terrain-name and U/V maps are one entry per Graphic Unit.  All must
		// decode for every shipped map.
		if got, want := len(m.TAKHeight), m.TAKW*m.TAKH; got != want || want == 0 {
			t.Errorf("%s: TAKHeight len %d, want %d", filepath.Base(path), got, want)
		}
		if got, want := len(m.TAKFeatureGrid), m.TAKW*m.TAKH; got != want {
			t.Errorf("%s: TAKFeatureGrid len %d, want %d", filepath.Base(path), got, want)
		}
		if got, want := len(m.TAKTerrainNames), m.TAKGUW*m.TAKGUH; got != want || want == 0 {
			t.Errorf("%s: TAKTerrainNames len %d, want %d", filepath.Base(path), got, want)
		}
		// The feature name table must parse and bound every placement.
		features, err := m.LoadFeatures(bytes.NewReader(data))
		if err != nil {
			t.Errorf("%s: LoadFeatures: %v", filepath.Base(path), err)
		}
		for _, p := range m.TAKFeaturePlacements() {
			if p.FeatureIdx >= len(features) {
				t.Errorf("%s: placement idx %d >= feature count %d",
					filepath.Base(path), p.FeatureIdx, len(features))
				break
			}
		}
		seen++
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if seen == 0 {
		t.Skip("no TA:K .tnt files found under maps/")
	}
	t.Logf("parsed %d TA: Kingdoms maps", seen)
}

// TestTAKParseAllSections walks the shipped TA:K section library — small
// 0x4000 TNTs under sections/<world>/<theme>/ that the in-game editor stamps
// into maps — and asserts every one decodes with consistent height, feature
// and terrain grids.  Sections embed a 128x128 minimap (maps use 126x126),
// so the geometry expectations differ from TestTAKParseAllMaps.
func TestTAKParseAllSections(t *testing.T) {
	dir := testutil.TAKUnpackedDir(t, "sections")

	var seen int
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".tnt") {
			return nil
		}
		rel, _ := filepath.Rel(dir, path)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("%s: read: %v", rel, err)
			return nil
		}
		m, err := LoadFromReader(bytes.NewReader(data))
		if err != nil {
			t.Errorf("%s: %v", rel, err)
			return nil
		}
		if !m.IsTAK {
			t.Errorf("%s: expected IsTAK", rel)
		}
		if got, want := len(m.TAKHeight), m.TAKW*m.TAKH; got != want || want == 0 {
			t.Errorf("%s: TAKHeight len %d, want %d", rel, got, want)
		}
		if got, want := len(m.TAKFeatureGrid), m.TAKW*m.TAKH; got != want {
			t.Errorf("%s: TAKFeatureGrid len %d, want %d", rel, got, want)
		}
		if got, want := len(m.TAKTerrainNames), m.TAKGUW*m.TAKGUH; got != want || want == 0 {
			t.Errorf("%s: TAKTerrainNames len %d, want %d", rel, got, want)
		}
		if got, want := len(m.TAKUMap), m.TAKGUW*m.TAKGUH; got != want {
			t.Errorf("%s: TAKUMap len %d, want %d", rel, got, want)
		}
		seen++
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if seen == 0 {
		t.Skip("no TA:K .tnt files found under sections/")
	}
	t.Logf("parsed %d TA: Kingdoms sections", seen)
}

// TestTANotRegressed guards that the TA:K branch did not change behaviour for
// ordinary TA maps: they still parse fully, with IsTAK false and tile data
// populated.
func TestTANotRegressed(t *testing.T) {
	path := testutil.UnpackedFile(t, "maps", "cc02.tnt")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	m, err := LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadFromReader: %v", err)
	}
	if m.IsTAK {
		t.Error("TA map wrongly flagged as TA:K")
	}
	if m.Header.IDVersion != VersionTA {
		t.Errorf("IDVersion = 0x%X, want 0x%X", m.Header.IDVersion, VersionTA)
	}
	if len(m.Tiles) == 0 {
		t.Error("expected TA map to have decoded tile graphics")
	}
}
