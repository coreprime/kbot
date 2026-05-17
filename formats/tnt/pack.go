package tnt

import (
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Metadata is the round-trip metadata bundle written next to the unpacked
// PNG/CSV artefacts.  Anything that cannot be recovered byte-for-byte from
// the other files lives here.
type Metadata struct {
	Version          string          `json:"version"`
	Header           HeaderMetadata  `json:"header"`
	Minimap          MinimapMetadata `json:"minimap"`
	Features         []string        `json:"features"`
	FeatureRawB64    []string        `json:"feature_raw_b64,omitempty"`
	FeatureSentinels []FeatureMarker `json:"feature_sentinels,omitempty"`
	AttrPadB64       string          `json:"attr_pad_b64,omitempty"`
	MapDataPadB64    string          `json:"map_data_pad_b64,omitempty"`
}

// HeaderMetadata captures the round-trip header fields that aren't derivable
// from the other unpacked artefacts.
type HeaderMetadata struct {
	IDVersion uint32 `json:"id_version"`
	SeaLevel  uint32 `json:"sea_level"`
	Unknown1  uint32 `json:"unknown1"`
	Pad1      uint32 `json:"pad1"`
	Pad2      uint32 `json:"pad2"`
	Pad3      uint32 `json:"pad3"`
	Pad4      uint32 `json:"pad4"`
}

// MinimapMetadata records the minimap dimensions for round-trip.
type MinimapMetadata struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// FeatureMarker records a cell whose feature column holds a non-placement
// sentinel value (commonly 0xFFFE "void" or 0xFFFC seen on early maps).
type FeatureMarker struct {
	X     int    `json:"x"`
	Y     int    `json:"y"`
	Value uint16 `json:"value"`
}

// Unpack writes m and the supplied feature table into dir as a directory of
// editable artefacts:
//
//	map.png            full RGBA render of the tile grid
//	heightmap.png      8-bit grayscale, pixel = raw elevation byte
//	minimap.png        paletted PNG of the embedded minimap
//	tiles/<n>.png      paletted 32x32 PNG per unique tile
//	tilemap.csv        2D grid of tile indices
//	features.csv       feature_index,name,attr_x,attr_y per placement
//	metadata.json      header constants + feature table + round-trip info
//
// dir is created if missing.
func Unpack(m *Map, features []Feature, palette color.Palette, dir string) error {
	if m == nil {
		return fmt.Errorf("nil map")
	}
	tilesDir := filepath.Join(dir, "tiles")
	if err := os.MkdirAll(tilesDir, 0o755); err != nil {
		return fmt.Errorf("mkdir tiles: %w", err)
	}

	if err := encodePNGFile(filepath.Join(dir, "map.png"), m.RenderTileMap(palette)); err != nil {
		return err
	}
	if err := encodePNGFile(filepath.Join(dir, "heightmap.png"), m.RenderHeightMapRaw()); err != nil {
		return err
	}
	if m.Minimap != nil {
		if err := encodePNGFile(filepath.Join(dir, "minimap.png"), m.RenderMinimapPaletted(palette)); err != nil {
			return err
		}
	}
	for i := range m.Tiles {
		img := m.RenderTilePaletted(i, palette)
		if err := encodePNGFile(filepath.Join(tilesDir, fmt.Sprintf("%d.png", i)), img); err != nil {
			return err
		}
	}
	if err := writeTilemapCSV(filepath.Join(dir, "tilemap.csv"), m); err != nil {
		return err
	}
	if err := writeFeaturesCSV(filepath.Join(dir, "features.csv"), m, features); err != nil {
		return err
	}

	meta := Metadata{
		Version: "1",
		Header: HeaderMetadata{
			IDVersion: m.Header.IDVersion,
			SeaLevel:  m.Header.SeaLevel,
			Unknown1:  m.Header.Unknown1,
			Pad1:      m.Header.Pad1,
			Pad2:      m.Header.Pad2,
			Pad3:      m.Header.Pad3,
			Pad4:      m.Header.Pad4,
		},
		Minimap:  MinimapMetadata{Width: m.MinimapW, Height: m.MinimapH},
		Features: make([]string, len(features)),
	}
	anyRaw := false
	rawB64 := make([]string, len(features))
	for i, f := range features {
		meta.Features[i] = f.Name
		expected := make([]byte, 128)
		copy(expected, f.Name)
		if !equalBytes(f.Raw[:], expected) {
			rawB64[i] = base64.StdEncoding.EncodeToString(f.Raw[:])
			anyRaw = true
		}
	}
	if anyRaw {
		meta.FeatureRawB64 = rawB64
	}

	pads := make([]byte, len(m.TileAttr))
	anyPad := false
	for i, a := range m.TileAttr {
		pads[i] = a.Pad
		if a.Pad != 0 {
			anyPad = true
		}
	}
	if anyPad {
		meta.AttrPadB64 = base64.StdEncoding.EncodeToString(pads)
	}
	if len(m.MapDataPad) > 0 {
		meta.MapDataPadB64 = base64.StdEncoding.EncodeToString(m.MapDataPad)
	}
	for y := 0; y < m.AttrH; y++ {
		for x := 0; x < m.AttrW; x++ {
			v := m.TileAttr[y*m.AttrW+x].Feature
			if v == 0xFFFF || int(v) < len(features) {
				continue
			}
			meta.FeatureSentinels = append(meta.FeatureSentinels, FeatureMarker{X: x, Y: y, Value: v})
		}
	}

	body, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "metadata.json"), body, 0o644); err != nil {
		return fmt.Errorf("write metadata: %w", err)
	}
	return nil
}

// Pack reads a directory written by Unpack and reconstructs the Map + Feature
// table.  Callers can then call Map.Save to write out a fresh TNT.
func Pack(dir string) (*Map, []Feature, error) {
	metaPath := filepath.Join(dir, "metadata.json")
	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, nil, fmt.Errorf("read metadata.json: %w", err)
	}
	var meta Metadata
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		return nil, nil, fmt.Errorf("parse metadata.json: %w", err)
	}

	heightImg, err := decodePNGFile(filepath.Join(dir, "heightmap.png"))
	if err != nil {
		return nil, nil, fmt.Errorf("heightmap.png: %w", err)
	}
	gray := toGray(heightImg)
	attrW := gray.Rect.Dx()
	attrH := gray.Rect.Dy()

	tileRows, err := readTilemapCSV(filepath.Join(dir, "tilemap.csv"))
	if err != nil {
		return nil, nil, err
	}
	tileH := len(tileRows)
	if tileH == 0 {
		return nil, nil, fmt.Errorf("tilemap.csv is empty")
	}
	tileW := len(tileRows[0])
	if tileW*2 != attrW || tileH*2 != attrH {
		return nil, nil, fmt.Errorf("tilemap (%dx%d) does not match heightmap (%dx%d)", tileW, tileH, attrW, attrH)
	}
	tileMap := make([]uint16, tileW*tileH)
	for y, row := range tileRows {
		if len(row) != tileW {
			return nil, nil, fmt.Errorf("tilemap.csv row %d has %d columns, expected %d", y, len(row), tileW)
		}
		for x, cell := range row {
			v, perr := strconv.Atoi(strings.TrimSpace(cell))
			if perr != nil {
				return nil, nil, fmt.Errorf("tilemap.csv [%d,%d] not numeric: %q", x, y, cell)
			}
			tileMap[y*tileW+x] = uint16(v)
		}
	}

	tiles, err := readTilesDir(filepath.Join(dir, "tiles"))
	if err != nil {
		return nil, nil, err
	}

	attrs := make([]TileAttr, attrW*attrH)
	for y := 0; y < attrH; y++ {
		for x := 0; x < attrW; x++ {
			attrs[y*attrW+x] = TileAttr{
				Height:  gray.GrayAt(x, y).Y,
				Feature: 0xFFFF,
			}
		}
	}
	if meta.AttrPadB64 != "" {
		padBytes, perr := base64.StdEncoding.DecodeString(meta.AttrPadB64)
		if perr != nil {
			return nil, nil, fmt.Errorf("decode attr_pad_b64: %w", perr)
		}
		if len(padBytes) != len(attrs) {
			return nil, nil, fmt.Errorf("attr_pad_b64 length %d, expected %d", len(padBytes), len(attrs))
		}
		for i := range attrs {
			attrs[i].Pad = padBytes[i]
		}
	}
	if err := applyFeaturesCSV(filepath.Join(dir, "features.csv"), attrs, attrW, attrH, len(meta.Features)); err != nil {
		return nil, nil, err
	}
	for _, s := range meta.FeatureSentinels {
		if s.X < 0 || s.X >= attrW || s.Y < 0 || s.Y >= attrH {
			return nil, nil, fmt.Errorf("feature_sentinels: (%d,%d) outside %dx%d grid", s.X, s.Y, attrW, attrH)
		}
		attrs[s.Y*attrW+s.X].Feature = s.Value
	}

	var (
		mmPix []byte
		mmW   int
		mmH   int
	)
	mmPath := filepath.Join(dir, "minimap.png")
	if _, statErr := os.Stat(mmPath); statErr == nil {
		mmImg, derr := decodePNGFile(mmPath)
		if derr != nil {
			return nil, nil, fmt.Errorf("minimap.png: %w", derr)
		}
		pix, w, h, perr := palettePixels(mmImg)
		if perr != nil {
			return nil, nil, fmt.Errorf("minimap.png: %w", perr)
		}
		mmPix = pix
		mmW = w
		mmH = h
	} else if meta.Minimap.Width > 0 && meta.Minimap.Height > 0 {
		mmW = meta.Minimap.Width
		mmH = meta.Minimap.Height
		mmPix = make([]byte, mmW*mmH)
	}

	var mapDataPad []byte
	if meta.MapDataPadB64 != "" {
		mapDataPad, err = base64.StdEncoding.DecodeString(meta.MapDataPadB64)
		if err != nil {
			return nil, nil, fmt.Errorf("decode map_data_pad_b64: %w", err)
		}
	}

	idv := meta.Header.IDVersion
	if idv == 0 {
		idv = 8192
	}

	m := &Map{
		Header: Header{
			IDVersion: idv,
			SeaLevel:  meta.Header.SeaLevel,
			Unknown1:  meta.Header.Unknown1,
			Pad1:      meta.Header.Pad1,
			Pad2:      meta.Header.Pad2,
			Pad3:      meta.Header.Pad3,
			Pad4:      meta.Header.Pad4,
		},
		TileW:      tileW,
		TileH:      tileH,
		AttrW:      attrW,
		AttrH:      attrH,
		TileMap:    tileMap,
		TileAttr:   attrs,
		Tiles:      tiles,
		Minimap:    mmPix,
		MinimapW:   mmW,
		MinimapH:   mmH,
		MapDataPad: mapDataPad,
	}

	features := make([]Feature, len(meta.Features))
	for i, name := range meta.Features {
		features[i] = Feature{Index: i, Name: name}
		if i < len(meta.FeatureRawB64) && meta.FeatureRawB64[i] != "" {
			raw, derr := base64.StdEncoding.DecodeString(meta.FeatureRawB64[i])
			if derr != nil {
				return nil, nil, fmt.Errorf("decode feature_raw_b64[%d]: %w", i, derr)
			}
			if len(raw) != 128 {
				return nil, nil, fmt.Errorf("feature_raw_b64[%d] decoded to %d bytes, expected 128", i, len(raw))
			}
			copy(features[i].Raw[:], raw)
		}
	}

	return m, features, nil
}

func encodePNGFile(path string, img image.Image) error {
	if img == nil {
		return nil
	}
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	defer func() { _ = f.Close() }()
	if err := png.Encode(f, img); err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	return nil
}

func decodePNGFile(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return png.Decode(f)
}

func toGray(img image.Image) *image.Gray {
	if g, ok := img.(*image.Gray); ok {
		return g
	}
	b := img.Bounds()
	g := image.NewGray(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			r, _, _, _ := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			g.Pix[y*g.Stride+x] = byte(r >> 8)
		}
	}
	return g
}

func palettePixels(img image.Image) ([]byte, int, int, error) {
	pi, ok := img.(*image.Paletted)
	if !ok {
		return nil, 0, 0, fmt.Errorf("expected paletted PNG (got %T)", img)
	}
	b := pi.Bounds()
	w := b.Dx()
	h := b.Dy()
	pix := make([]byte, w*h)
	for y := 0; y < h; y++ {
		copy(pix[y*w:(y+1)*w], pi.Pix[y*pi.Stride:y*pi.Stride+w])
	}
	return pix, w, h, nil
}

func writeTilemapCSV(path string, m *Map) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create tilemap.csv: %w", err)
	}
	defer func() { _ = f.Close() }()
	w := csv.NewWriter(f)
	defer w.Flush()
	row := make([]string, m.TileW)
	for ty := 0; ty < m.TileH; ty++ {
		for tx := 0; tx < m.TileW; tx++ {
			row[tx] = strconv.Itoa(int(m.TileMap[ty*m.TileW+tx]))
		}
		if err := w.Write(row); err != nil {
			return fmt.Errorf("write tilemap row %d: %w", ty, err)
		}
	}
	return nil
}

func writeFeaturesCSV(path string, m *Map, features []Feature) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create features.csv: %w", err)
	}
	defer func() { _ = f.Close() }()
	w := csv.NewWriter(f)
	defer w.Flush()
	if err := w.Write([]string{"feature_index", "name", "attr_x", "attr_y"}); err != nil {
		return err
	}
	for _, p := range m.GetFeaturePlacements() {
		name := ""
		if p.FeatureIdx < len(features) {
			name = features[p.FeatureIdx].Name
		}
		if err := w.Write([]string{
			strconv.Itoa(p.FeatureIdx),
			name,
			strconv.Itoa(p.AttrX),
			strconv.Itoa(p.AttrY),
		}); err != nil {
			return err
		}
	}
	return nil
}

func readTilemapCSV(path string) ([][]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open tilemap.csv: %w", err)
	}
	defer func() { _ = f.Close() }()
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("parse tilemap.csv: %w", err)
	}
	return rows, nil
}

func readTilesDir(dir string) ([][]byte, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read tiles dir: %w", err)
	}
	type tileEntry struct {
		idx  int
		path string
	}
	var found []tileEntry
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(strings.ToLower(name), ".png") {
			continue
		}
		stem := strings.TrimSuffix(name, filepath.Ext(name))
		n, perr := strconv.Atoi(stem)
		if perr != nil {
			continue
		}
		found = append(found, tileEntry{idx: n, path: filepath.Join(dir, name)})
	}
	if len(found) == 0 {
		return nil, fmt.Errorf("no <n>.png tile files in %s", dir)
	}
	sort.Slice(found, func(i, j int) bool { return found[i].idx < found[j].idx })
	tiles := make([][]byte, found[len(found)-1].idx+1)
	for _, t := range found {
		img, derr := decodePNGFile(t.path)
		if derr != nil {
			return nil, fmt.Errorf("tile %d: %w", t.idx, derr)
		}
		pix, w, h, perr := palettePixels(img)
		if perr != nil {
			return nil, fmt.Errorf("tile %d: %w", t.idx, perr)
		}
		if w != 32 || h != 32 {
			return nil, fmt.Errorf("tile %d has size %dx%d, expected 32x32", t.idx, w, h)
		}
		tiles[t.idx] = pix
	}
	for i, t := range tiles {
		if t == nil {
			return nil, fmt.Errorf("missing tile %d.png in %s", i, dir)
		}
	}
	return tiles, nil
}

func applyFeaturesCSV(path string, attrs []TileAttr, attrW, attrH, featureCount int) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open features.csv: %w", err)
	}
	defer func() { _ = f.Close() }()
	r := csv.NewReader(f)
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return fmt.Errorf("parse features.csv: %w", err)
	}
	for ri, row := range rows {
		if ri == 0 && len(row) > 0 && !isAllDigits(row[0]) {
			continue
		}
		if len(row) < 4 {
			return fmt.Errorf("features.csv row %d: expected 4 fields, got %d", ri, len(row))
		}
		idx, ierr := strconv.Atoi(strings.TrimSpace(row[0]))
		if ierr != nil {
			return fmt.Errorf("features.csv row %d feature_index not numeric: %q", ri, row[0])
		}
		if featureCount > 0 && (idx < 0 || idx >= featureCount) {
			return fmt.Errorf("features.csv row %d feature_index %d out of range (table has %d entries)", ri, idx, featureCount)
		}
		x, xerr := strconv.Atoi(strings.TrimSpace(row[2]))
		if xerr != nil {
			return fmt.Errorf("features.csv row %d attr_x not numeric: %q", ri, row[2])
		}
		y, yerr := strconv.Atoi(strings.TrimSpace(row[3]))
		if yerr != nil {
			return fmt.Errorf("features.csv row %d attr_y not numeric: %q", ri, row[3])
		}
		if x < 0 || x >= attrW || y < 0 || y >= attrH {
			return fmt.Errorf("features.csv row %d position (%d,%d) outside %dx%d grid", ri, x, y, attrW, attrH)
		}
		attrs[y*attrW+x].Feature = uint16(idx)
	}
	return nil
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func isAllDigits(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

