package studio

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/coreprime/kbot/formats/hpi"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/tnt"
)

// blankTileByte is the palette index used for empty tile cells.  The TA
// palette puts a dark "void"-ish color at index 0x64 (also the minimap void
// sentinel).  We re-use it so unfinished maps look obviously unfinished
// rather than smeared with palette index 0.
const blankTileByte = 0x64

// defaultHeight is the elevation written to attribute cells when the client
// doesn't supply explicit heights.
const defaultHeight = 80

// buildArtifacts materialises the TNT + OTA bytes for a save request.
// Split out from buildHPI so non-HPI save paths (loose .tnt + .ota,
// overwriting a source HPI, etc.) can reuse the same pipeline without
// going through the temp-file dance below.
func buildArtifacts(req saveRequest) (tntBytes, otaBytes []byte, err error) {
	m, features, err := buildMap(req)
	if err != nil {
		return nil, nil, err
	}
	var tntBuf bytes.Buffer
	if err := m.Save(&tntBuf, features); err != nil {
		return nil, nil, fmt.Errorf("encode TNT: %w", err)
	}
	return tntBuf.Bytes(), []byte(buildOTA(req)), nil
}

// buildHPI takes a save request, materialises a TNT + OTA pair, and bundles
// them into an HPI archive ready for download.
func buildHPI(req saveRequest) ([]byte, error) {
	tntBytes, otaBytes, err := buildArtifacts(req)
	if err != nil {
		return nil, err
	}

	// hpi.Writer is file-backed, so route through a temp file and slurp.
	tmp, err := os.CreateTemp("", "studio-*.hpi")
	if err != nil {
		return nil, fmt.Errorf("temp file: %w", err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer func() { _ = os.Remove(tmpPath) }()

	hw, err := hpi.CreateWriter(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("create hpi: %w", err)
	}
	hw.SetTrailer(nil)
	mapName := strings.ToLower(req.MapName)
	if err := hw.AddFileFromBytes(filepath.ToSlash(filepath.Join("maps", mapName+".tnt")), tntBytes); err != nil {
		_ = hw.Close()
		return nil, fmt.Errorf("add tnt: %w", err)
	}
	if err := hw.AddFileFromBytes(filepath.ToSlash(filepath.Join("maps", mapName+".ota")), otaBytes); err != nil {
		_ = hw.Close()
		return nil, fmt.Errorf("add ota: %w", err)
	}
	if err := hw.Close(); err != nil {
		return nil, fmt.Errorf("close hpi: %w", err)
	}
	return os.ReadFile(tmpPath)
}

// buildMap walks the save request and produces a fully-populated tnt.Map.
//
// The client tracks each map tile cell as a (sectionPath, sx, sy) reference;
// we resolve those references here, accumulating the unique 32×32 tile
// graphics into the map's shared tile pool and stamping the tile index into
// the map's TileMap.
func buildMap(req saveRequest) (*tnt.Map, []tnt.Feature, error) {
	tileW, tileH := req.TileW, req.TileH
	attrW, attrH := tileW*2, tileH*2

	// Load every distinct section referenced by the stamp set.
	sectionCache := make(map[string]*sct.Section)
	loadSection := func(p string) (*sct.Section, error) {
		if s, ok := sectionCache[p]; ok {
			return s, nil
		}
		data, err := vfs.ReadFile(p)
		if err != nil {
			return nil, fmt.Errorf("section %q: %w", p, err)
		}
		s, err := sct.LoadFromReader(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("section %q: parse: %w", p, err)
		}
		sectionCache[p] = s
		return s, nil
	}

	// Tile pool.  Byte-identical tiles are always coalesced — the studio
	// rewrites the pool on every save, so emitting redundant entries
	// would just produce a fatter file with no user-visible benefit and
	// would inflate the dedupTiles quality count against a synthetic
	// per-cell pool that nothing the user did actually built.  Tile
	// index 0 is reserved as the "blank" tile filled with the void byte
	// so unstamped cells render uniformly.
	type tileKey [1024]byte
	tilePool := make([][]byte, 0, 32)
	tileIndex := make(map[tileKey]uint16)
	addTile := func(pixels []byte) uint16 {
		var key tileKey
		copy(key[:], pixels)
		if idx, ok := tileIndex[key]; ok {
			return idx
		}
		idx := uint16(len(tilePool))
		tilePool = append(tilePool, append([]byte(nil), pixels...))
		tileIndex[key] = idx
		return idx
	}
	blank := make([]byte, 1024)
	for i := range blank {
		blank[i] = blankTileByte
	}
	blankIdx := addTile(blank)

	tileMap := make([]uint16, tileW*tileH)
	for i := range tileMap {
		tileMap[i] = blankIdx
	}

	heightDefault := uint8(defaultHeight)
	if req.DefaultH > 0 {
		heightDefault = uint8(clamp(req.DefaultH, 0, 255))
	}
	attrs := make([]tnt.TileAttr, attrW*attrH)
	for i := range attrs {
		attrs[i] = tnt.TileAttr{Height: heightDefault, Feature: 0xFFFF}
	}

	// Stamp tiles from sections.  The client guarantees one entry per
	// tile cell (len = tileW*tileH).  Each stamp may be nil for "blank".
	if got := len(req.Tiles); got != 0 && got != tileW*tileH {
		return nil, nil, fmt.Errorf("tiles array length %d does not match %d×%d=%d", got, tileW, tileH, tileW*tileH)
	}
	for ty := 0; ty < tileH; ty++ {
		for tx := 0; tx < tileW; tx++ {
			if len(req.Tiles) == 0 {
				break
			}
			stamp := req.Tiles[ty*tileW+tx]
			if stamp == nil || stamp.SectionPath == "" {
				continue
			}
			// Stamps loaded from an existing TNT have a synthetic
			// "tnt:<path>" section path — the (SX, SY) refer to a
			// position in that TNT's flattened tile pool (see
			// handleMapLoad).  We pull pixels straight from the cached
			// *tnt.Map; no SCT lookup, no height-rotation table.
			if strings.HasPrefix(stamp.SectionPath, "tnt:") {
				mapPath := strings.TrimPrefix(stamp.SectionPath, "tnt:")
				srcMap := lookupTNT(mapPath)
				if srcMap == nil {
					return nil, nil, fmt.Errorf("tnt source %q not in cache; reload the map", mapPath)
				}
				poolCols := tilePoolCols(len(srcMap.Tiles))
				poolIdx := stamp.SY*poolCols + stamp.SX
				if poolIdx < 0 || poolIdx >= len(srcMap.Tiles) {
					continue
				}
				tilePixels := srcMap.Tiles[poolIdx]
				if stamp.Rotation&3 != 0 {
					tilePixels = rotateTile32(tilePixels, stamp.Rotation&3)
				}
				if stamp.FlipH {
					tilePixels = flipTile32(tilePixels, true, false)
				}
				if stamp.FlipV {
					tilePixels = flipTile32(tilePixels, false, true)
				}
				tileMap[ty*tileW+tx] = addTile(tilePixels)
				// Heights for TNT-sourced tiles ride along in the
				// req.Heights array (the editor seeds it from the
				// loaded TileAttr table), so there's nothing to copy
				// here — the global override pass below handles it.
				continue
			}
			section, err := loadSection(stamp.SectionPath)
			if err != nil {
				return nil, nil, err
			}
			if stamp.SX < 0 || stamp.SY < 0 || stamp.SX >= int(section.Header.Width) || stamp.SY >= int(section.Header.Height) {
				return nil, nil, fmt.Errorf("section %s: stamp (%d,%d) outside %dx%d", stamp.SectionPath, stamp.SX, stamp.SY, section.Header.Width, section.Header.Height)
			}
			sectionTileIdx := section.TileMap[stamp.SY*int(section.Header.Width)+stamp.SX]
			if sectionTileIdx < 0 || int(sectionTileIdx) >= len(section.Tiles) {
				continue
			}
			// Rotate (and optionally flip) the 32×32 tile graphic by
			// the stamp's transform before adding it to the shared
			// tile pool — bakes the orientation into the saved TNT so
			// the in-game renderer doesn't have to do anything special.
			tilePixels := section.Tiles[sectionTileIdx]
			if stamp.Rotation&3 != 0 {
				tilePixels = rotateTile32(tilePixels, stamp.Rotation&3)
			}
			if stamp.FlipH {
				tilePixels = flipTile32(tilePixels, true, false)
			}
			if stamp.FlipV {
				tilePixels = flipTile32(tilePixels, false, true)
			}
			tileMap[ty*tileW+tx] = addTile(tilePixels)

			// Copy the 2×2 height samples for this tile, applying the
			// same rotation+flip transform so the elevation pattern
			// stays aligned with the visible pixels.
			if section.HeightMap != nil {
				sw := int(section.Header.Width) * 2
				for qy := 0; qy < 2; qy++ {
					for qx := 0; qx < 2; qx++ {
						// Mirror the flips on the destination sub-cell
						// first, then unrotate to find the source.
						fqx, fqy := qx, qy
						if stamp.FlipH {
							fqx = 1 - fqx
						}
						if stamp.FlipV {
							fqy = 1 - fqy
						}
						sqx, sqy := fqx, fqy
						switch stamp.Rotation & 3 {
						case 1:
							sqx, sqy = fqy, 1-fqx
						case 2:
							sqx, sqy = 1-fqx, 1-fqy
						case 3:
							sqx, sqy = 1-fqy, fqx
						}
						srcAX := stamp.SX*2 + sqx
						srcAY := stamp.SY*2 + sqy
						dstAX := tx*2 + qx
						dstAY := ty*2 + qy
						attrs[dstAY*attrW+dstAX].Height = section.HeightMap[srcAY*sw+srcAX].Height
					}
				}
			}
		}
	}

	// Per-attr-cell heights from the client override anything the
	// section stamping wrote.  Optional — empty slice means "use stamp
	// heights / default".
	if len(req.Heights) == attrW*attrH {
		for i, h := range req.Heights {
			attrs[i].Height = uint8(clamp(h, 0, 255))
		}
	}

	// Feature placements.
	featureNames := []string{}
	featureIndex := make(map[string]int)
	addFeatureName := func(name string) int {
		if idx, ok := featureIndex[strings.ToLower(name)]; ok {
			return idx
		}
		idx := len(featureNames)
		featureNames = append(featureNames, name)
		featureIndex[strings.ToLower(name)] = idx
		return idx
	}
	for _, fp := range req.Features {
		if fp.Name == "" {
			continue
		}
		if fp.AX < 0 || fp.AX >= attrW || fp.AY < 0 || fp.AY >= attrH {
			continue
		}
		idx := addFeatureName(fp.Name)
		attrs[fp.AY*attrW+fp.AX].Feature = uint16(idx)
	}
	// Voids stomp any feature index that happened to land on the same
	// cell — void cells can't host features in the engine.  The marker
	// 0xFFFC is the canonical void sentinel.
	if len(req.Voids) == attrW*attrH {
		for i, v := range req.Voids {
			if v != 0 {
				attrs[i].Feature = 0xFFFC
			}
		}
	}
	features := make([]tnt.Feature, len(featureNames))
	for i, name := range featureNames {
		features[i] = tnt.Feature{Index: i, Name: name}
	}

	// Minimap — 252×252 with the map's content scaled into the top-left
	// corner and the remainder filled with the TA void sentinel byte.
	minimap := buildMinimap(tileW, tileH, tileMap, tilePool)

	seaLevel := uint32(req.SeaLevel)
	if seaLevel == 0 && req.OTA != nil {
		seaLevel = uint32(req.OTA.SeaLevel)
	}

	m := &tnt.Map{
		Header: tnt.Header{
			IDVersion: 8192,
			Width:     uint32(attrW),
			Height:    uint32(attrH),
			SeaLevel:  seaLevel,
		},
		TileW:    tileW,
		TileH:    tileH,
		AttrW:    attrW,
		AttrH:    attrH,
		TileMap:  tileMap,
		TileAttr: attrs,
		Tiles:    tilePool,
		Minimap:  minimap,
		MinimapW: 252,
		MinimapH: 252,
	}
	return m, features, nil
}

// buildMinimap renders the map at 1-pixel-per-tile resolution into the
// top-left of a 252×252 palette-indexed image.  Cells outside the map area
// receive the void sentinel byte so the in-game minimap masks them off.
func buildMinimap(tileW, tileH int, tileMap []uint16, tiles [][]byte) []byte {
	const dim = 252
	mm := make([]byte, dim*dim)
	for i := range mm {
		mm[i] = tnt.MinimapVoidByte
	}

	pxW, pxH := tileW, tileH
	if pxW > dim {
		pxW = dim
	}
	if pxH > dim {
		pxH = dim
	}
	for y := 0; y < pxH; y++ {
		for x := 0; x < pxW; x++ {
			tx := x * tileW / pxW
			ty := y * tileH / pxH
			tileIdx := tileMap[ty*tileW+tx]
			if int(tileIdx) >= len(tiles) {
				continue
			}
			// Sample the middle of the tile so single-pixel minimap
			// cells reflect the dominant color rather than an edge
			// artefact.
			mm[y*dim+x] = tiles[tileIdx][16*32+16]
		}
	}
	return mm
}

// buildOTA returns a game-loadable OTA describing the map.  When the
// request carries a rich OTA struct (the studio editor populates one)
// we emit every field straight from it; otherwise we fall back to
// sensible defaults so the saved file is still playable.
func buildOTA(req saveRequest) string {
	ota := otaForRequest(req)
	var b strings.Builder
	fmt.Fprintf(&b, "[GlobalHeader]\n\t{\n")
	fmt.Fprintf(&b, "\tmissionname=%s;\n", ota.MissionName)
	fmt.Fprintf(&b, "\tmissiondescription=%s;\n", ota.MissionDescription)
	fmt.Fprintf(&b, "\tplanet=%s;\n", ota.Planet)
	fmt.Fprintf(&b, "\tmissionhint=%s;\n", ota.MissionHint)
	fmt.Fprintf(&b, "\tbrief=%s;\n", ota.Brief)
	fmt.Fprintf(&b, "\tnarration=%s;\n", ota.Narration)
	fmt.Fprintf(&b, "\tglamour=%s;\n", ota.Glamour)
	fmt.Fprintf(&b, "\tlineofsight=%d;\n", ota.LineOfSight)
	fmt.Fprintf(&b, "\tmapping=%d;\n", ota.Mapping)
	fmt.Fprintf(&b, "\ttidalstrength=%d;\n", ota.TidalStrength)
	fmt.Fprintf(&b, "\tsolarstrength=%d;\n", ota.SolarStrength)
	fmt.Fprintf(&b, "\tlavaworld=%d;\n", ota.LavaWorld)
	fmt.Fprintf(&b, "\tkillmul=%d;\n", ota.Killmul)
	fmt.Fprintf(&b, "\ttimemul=%d;\n", ota.Timemul)
	fmt.Fprintf(&b, "\tminwindspeed=%d;\n", ota.MinWindSpeed)
	fmt.Fprintf(&b, "\tmaxwindspeed=%d;\n", ota.MaxWindSpeed)
	fmt.Fprintf(&b, "\tgravity=%d;\n", ota.Gravity)
	fmt.Fprintf(&b, "\tsealevel=%d;\n", ota.SeaLevel)
	fmt.Fprintf(&b, "\timpassiblewater=%d;\n", ota.ImpassibleWater)
	fmt.Fprintf(&b, "\twaterdoesdamage=%d;\n", ota.WaterDoesDamage)
	fmt.Fprintf(&b, "\tnumplayers=%s;\n", ota.NumPlayers)
	fmt.Fprintf(&b, "\tsize=%s;\n", ota.Size)
	fmt.Fprintf(&b, "\tmemory=%s;\n", ota.Memory)
	fmt.Fprintf(&b, "\tSCHEMACOUNT=%d;\n", len(ota.Schemas))
	for si, s := range ota.Schemas {
		fmt.Fprintf(&b, "\t[Schema %d]\n\t\t{\n", si)
		fmt.Fprintf(&b, "\t\tType=%s;\n", s.Type)
		fmt.Fprintf(&b, "\t\taiprofile=%s;\n", s.AIProfile)
		fmt.Fprintf(&b, "\t\tSurfaceMetal=%d;\n", s.SurfaceMetal)
		fmt.Fprintf(&b, "\t\tMohoMetal=%d;\n", s.MohoMetal)
		fmt.Fprintf(&b, "\t\tHumanMetal=%d;\n", s.HumanMetal)
		fmt.Fprintf(&b, "\t\tComputerMetal=%d;\n", s.ComputerMetal)
		fmt.Fprintf(&b, "\t\tHumanEnergy=%d;\n", s.HumanEnergy)
		fmt.Fprintf(&b, "\t\tComputerEnergy=%d;\n", s.ComputerEnergy)
		fmt.Fprintf(&b, "\t\tMeteorWeapon=%s;\n", s.MeteorWeapon)
		fmt.Fprintf(&b, "\t\tMeteorRadius=%d;\n", s.MeteorRadius)
		fmt.Fprintf(&b, "\t\tMeteorDensity=%d;\n", s.MeteorDensity)
		fmt.Fprintf(&b, "\t\tMeteorDuration=%d;\n", s.MeteorDuration)
		fmt.Fprintf(&b, "\t\tMeteorInterval=%d;\n", s.MeteorInterval)
		fmt.Fprintf(&b, "\t\t[specials]\n\t\t\t{\n")
		for i, sp := range s.StartPos {
			fmt.Fprintf(&b, "\t\t\t[special%d]\n\t\t\t\t{\n", i)
			fmt.Fprintf(&b, "\t\t\t\tspecialwhat=StartPos%d;\n", sp.Number)
			fmt.Fprintf(&b, "\t\t\t\tXPos=%d;\n", sp.X)
			fmt.Fprintf(&b, "\t\t\t\tZPos=%d;\n", sp.Z)
			fmt.Fprintf(&b, "\t\t\t\t}\n")
		}
		fmt.Fprintf(&b, "\t\t\t}\n")
		fmt.Fprintf(&b, "\t\t}\n")
	}
	fmt.Fprintf(&b, "\t}\n")
	return b.String()
}

// otaForRequest returns the OTA payload to serialise, filling in
// defaults for any missing fields so the resulting .ota is always
// well-formed and game-loadable.
func otaForRequest(req saveRequest) otaState {
	display := strings.TrimSpace(req.DisplayName)
	if display == "" {
		display = req.MapName
	}
	planet := strings.TrimSpace(req.Planet)
	if planet == "" {
		planet = "Green"
	}
	if req.OTA == nil {
		// Old client / no editor metadata — synthesise a single-schema OTA.
		starts := req.StartPos
		if len(starts) == 0 {
			starts = defaultStartPositions(req.TileW, req.TileH)
		}
		return otaState{
			MissionName:        display,
			MissionDescription: "Created with KBot Studio.",
			Planet:             planet,
			NumPlayers:         "2, 3, 4",
			Size:               fmt.Sprintf("%d x %d", req.TileW/16, req.TileH/16),
			Memory:             "8 mb",
			TidalStrength:      20,
			SolarStrength:      20,
			Killmul:            50,
			MinWindSpeed:       200,
			MaxWindSpeed:       2500,
			Gravity:            112,
			Schemas: []otaSchema{{
				Name:           "Default",
				Type:           "Network 1",
				AIProfile:      "DEFAULT",
				SurfaceMetal:   3,
				MohoMetal:      30,
				HumanMetal:     1000,
				ComputerMetal:  1000,
				HumanEnergy:    1000,
				ComputerEnergy: 1000,
				StartPos:       starts,
			}},
		}
	}
	ota := *req.OTA
	if ota.MissionName == "" {
		ota.MissionName = display
	}
	if ota.Planet == "" {
		ota.Planet = planet
	}
	if ota.Size == "" {
		ota.Size = fmt.Sprintf("%d x %d", req.TileW/16, req.TileH/16)
	}
	if ota.Memory == "" {
		ota.Memory = "8 mb"
	}
	if ota.NumPlayers == "" {
		ota.NumPlayers = "2, 3, 4"
	}
	if len(ota.Schemas) == 0 {
		ota.Schemas = []otaSchema{{
			Name:           "Default",
			Type:           "Network 1",
			AIProfile:      "DEFAULT",
			SurfaceMetal:   3,
			MohoMetal:      30,
			HumanMetal:     1000,
			ComputerMetal:  1000,
			HumanEnergy:    1000,
			ComputerEnergy: 1000,
			StartPos:       defaultStartPositions(req.TileW, req.TileH),
		}}
	} else {
		// Backfill missing start positions in any schema so the saved
		// .ota always lists at least one StartPos per schema.
		for i := range ota.Schemas {
			if len(ota.Schemas[i].StartPos) == 0 {
				ota.Schemas[i].StartPos = defaultStartPositions(req.TileW, req.TileH)
			}
		}
	}
	return ota
}

func defaultStartPositions(tileW, tileH int) []saveStartPos {
	pxW := tileW * 32
	pxH := tileH * 32
	margin := 256
	if pxW < margin*3 {
		margin = pxW / 4
	}
	if pxH < margin*3 {
		margin = pxH / 4
	}
	return []saveStartPos{
		{Number: 1, X: margin, Z: margin},
		{Number: 2, X: pxW - margin, Z: pxH - margin},
		{Number: 3, X: pxW - margin, Z: margin},
		{Number: 4, X: margin, Z: pxH - margin},
		{Number: 5, X: pxW / 2, Z: margin},
		{Number: 6, X: pxW / 2, Z: pxH - margin},
		{Number: 7, X: margin, Z: pxH / 2},
		{Number: 8, X: pxW - margin, Z: pxH / 2},
		{Number: 9, X: pxW / 3, Z: pxH / 2},
		{Number: 10, X: pxW * 2 / 3, Z: pxH / 2},
	}
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// rotateTile32 returns a new 1024-byte tile (32×32 palette indices) rotated
// by `rotation` quarter-turns clockwise.  rotation values outside [0,3] are
// taken modulo 4.  The input slice is not modified.
func rotateTile32(src []byte, rotation int) []byte {
	out := make([]byte, 1024)
	switch rotation & 3 {
	case 0:
		copy(out, src)
	case 1: // 90° CW: dst[y][x] = src[31-x][y]
		for y := 0; y < 32; y++ {
			for x := 0; x < 32; x++ {
				out[y*32+x] = src[(31-x)*32+y]
			}
		}
	case 2: // 180°: dst[y][x] = src[31-y][31-x]
		for y := 0; y < 32; y++ {
			for x := 0; x < 32; x++ {
				out[y*32+x] = src[(31-y)*32+(31-x)]
			}
		}
	case 3: // 270° CW / 90° CCW: dst[y][x] = src[x][31-y]
		for y := 0; y < 32; y++ {
			for x := 0; x < 32; x++ {
				out[y*32+x] = src[x*32+(31-y)]
			}
		}
	}
	return out
}

// flipTile32 returns a new 1024-byte tile mirrored horizontally,
// vertically, or both.  The input slice is not modified.
func flipTile32(src []byte, flipH, flipV bool) []byte {
	if !flipH && !flipV {
		out := make([]byte, 1024)
		copy(out, src)
		return out
	}
	out := make([]byte, 1024)
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			sx, sy := x, y
			if flipH {
				sx = 31 - sx
			}
			if flipV {
				sy = 31 - sy
			}
			out[y*32+x] = src[sy*32+sx]
		}
	}
	return out
}

