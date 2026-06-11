package tak

// StampSection composites a section's terrain into this map at the given
// graphic-unit offset — the engine behind "build maps from sections" for
// TA:Kingdoms. Terrain texture names and their U/V offsets copy per Graphic
// Unit (32px); the heightmap and feature grid copy per DataUnit (16px, so twice
// the resolution on each axis). Cells that fall outside this map are skipped, so
// a section dropped near an edge is clipped rather than wrapping.
//
// Both maps name terrain from the same shared terrain/<hex>.jpg set, so the
// names copy across directly with no remapping.
//
// Unlike TA tile stamping there is no rotate/flip support, and there cannot
// be: a Graphic Unit is only (texture name, U, V) with no orientation bits,
// so a rotated placement would still draw unrotated texels and shear every
// edge. Rotation would require baking rotated copies of the shared textures,
// which the format has no way to reference.
func (m *Map) StampSection(src *Map, atGUx, atGUy int) {
	if src == nil {
		return
	}
	// Graphic-Unit layers: terrain texture names + U/V offsets.
	for sy := 0; sy < src.GUH; sy++ {
		dy := atGUy + sy
		if dy < 0 || dy >= m.GUH {
			continue
		}
		for sx := 0; sx < src.GUW; sx++ {
			dx := atGUx + sx
			if dx < 0 || dx >= m.GUW {
				continue
			}
			si := sy*src.GUW + sx
			di := dy*m.GUW + dx
			if si < len(src.TerrainNames) && di < len(m.TerrainNames) {
				m.TerrainNames[di] = src.TerrainNames[si]
			}
			if si < len(src.UMap) && di < len(m.UMap) {
				m.UMap[di] = src.UMap[si]
			}
			if si < len(src.VMap) && di < len(m.VMap) {
				m.VMap[di] = src.VMap[si]
			}
		}
	}
	// DataUnit layers: heightmap + feature grid (2× the GU resolution).
	// Feature indices are PER-MAP table positions, so the section's
	// placements remap through this map's table (appending names it lacks);
	// empty sentinel cells copy through as-is, clearing whatever the old
	// terrain hosted there — the stamp owns its footprint.
	srcNames := src.FeatureNames()
	remap := make(map[uint16]uint16, len(srcNames))
	duX, duY := atGUx*2, atGUy*2
	for sy := 0; sy < src.H; sy++ {
		dy := duY + sy
		if dy < 0 || dy >= m.H {
			continue
		}
		for sx := 0; sx < src.W; sx++ {
			dx := duX + sx
			if dx < 0 || dx >= m.W {
				continue
			}
			si := sy*src.W + sx
			di := dy*m.W + dx
			if si < len(src.Height) && di < len(m.Height) {
				m.Height[di] = src.Height[si]
			}
			if si < len(src.FeatureGrid) && di < len(m.FeatureGrid) {
				v := src.FeatureGrid[si]
				if int(v) < len(srcNames) && v < NoFeatureThreshold {
					mapped, ok := remap[v]
					if !ok {
						mapped = uint16(m.EnsureFeature(srcNames[v]))
						remap[v] = mapped
					}
					v = mapped
				}
				m.FeatureGrid[di] = v
			}
		}
	}
}
