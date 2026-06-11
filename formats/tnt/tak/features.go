package tak

import (
	"encoding/binary"
	"strings"
)

// Feature-table + feature-grid editing.
//
// The feature-name table is a run of 132-byte entries — uint32 index followed
// by a 128-byte NUL-padded name — counted by Header.FeatureCount. The
// DataUnit-resolution FeatureGrid holds uint16 indices into that table;
// values at or above NoFeatureThreshold are sentinels (0xFFFF = empty cell,
// other 0xFFxx values mark engine state like multi-cell footprints), not
// table indices.

const featureEntrySize = 4 + 128

// EmptyFeatureCell is the grid value for "no feature here".
const EmptyFeatureCell = 0xFFFF

// NoFeatureThreshold — grid values at or above this are sentinels, not
// feature-table indices.
const NoFeatureThreshold = 0xFF00

// FeatureNames returns the feature-name table as a slice indexed by the grid's
// feature indices. Truncated/corrupt trailing entries are dropped.
func (m *Map) FeatureNames() []string {
	count := int(m.Header.FeatureCount)
	if count <= 0 || len(m.FeatureTableRaw) < featureEntrySize {
		return nil
	}
	if max := len(m.FeatureTableRaw) / featureEntrySize; count > max {
		count = max
	}
	out := make([]string, count)
	for i := 0; i < count; i++ {
		raw := m.FeatureTableRaw[i*featureEntrySize+4 : (i+1)*featureEntrySize]
		name := string(raw)
		if nul := strings.IndexByte(name, 0); nul >= 0 {
			name = name[:nul]
		}
		out[i] = name
	}
	return out
}

// EnsureFeature returns the table index for a feature name, appending a new
// 132-byte entry (and bumping Header.FeatureCount) when the name isn't
// already present. Matching is case-insensitive, like the engine's own
// feature lookup. Returns -1 for an empty or over-long name.
func (m *Map) EnsureFeature(name string) int {
	name = strings.TrimSpace(name)
	if name == "" || len(name) >= 128 {
		return -1
	}
	for i, n := range m.FeatureNames() {
		if strings.EqualFold(n, name) {
			return i
		}
	}
	idx := int(m.Header.FeatureCount)
	var entry [featureEntrySize]byte
	binary.LittleEndian.PutUint32(entry[:4], uint32(idx))
	copy(entry[4:], name)
	m.FeatureTableRaw = append(m.FeatureTableRaw, entry[:]...)
	m.Header.FeatureCount = uint32(idx + 1)
	return idx
}

// SetFeaturePlacements replaces the map's feature placements with the given
// (x, y, name) anchors, where x/y are DataUnit cells. Existing feature
// indices in the grid are cleared to EmptyFeatureCell; sentinel values other
// than the feature indices themselves (footprint markers etc.) are
// preserved, since the anchors here describe single-cell intent the editor
// tracks. Unknown names are added to the feature table. Placements outside
// the grid or with unusable names are skipped and counted in the return.
func (m *Map) SetFeaturePlacements(places []FeatureAnchor) (skipped int) {
	for i, v := range m.FeatureGrid {
		if v < NoFeatureThreshold {
			m.FeatureGrid[i] = EmptyFeatureCell
		}
	}
	for _, p := range places {
		if p.X < 0 || p.X >= m.W || p.Y < 0 || p.Y >= m.H {
			skipped++
			continue
		}
		idx := m.EnsureFeature(p.Name)
		if idx < 0 || idx >= NoFeatureThreshold {
			skipped++
			continue
		}
		m.FeatureGrid[p.Y*m.W+p.X] = uint16(idx)
	}
	return skipped
}

// FeatureAnchor is one feature placement: a DataUnit cell and the feature's
// table name.
type FeatureAnchor struct {
	X, Y int
	Name string
}

// CompactFeatureTable drops feature-table entries no grid cell references —
// the editor's EnsureFeature appends but never reaps, and hand-edited maps
// accumulate dead names. Referenced entries keep their relative order; grid
// indices are remapped in place. Returns the entry counts before and after.
func (m *Map) CompactFeatureTable() (before, after int) {
	names := m.FeatureNames()
	before = len(names)
	if before == 0 {
		return 0, 0
	}
	used := make([]bool, before)
	for _, v := range m.FeatureGrid {
		if int(v) < before && v < NoFeatureThreshold {
			used[v] = true
		}
	}
	remap := make([]uint16, before)
	var raw []byte
	for i, n := range names {
		if !used[i] {
			continue
		}
		var entry [featureEntrySize]byte
		binary.LittleEndian.PutUint32(entry[:4], uint32(after))
		copy(entry[4:], n)
		raw = append(raw, entry[:]...)
		remap[i] = uint16(after)
		after++
	}
	for i, v := range m.FeatureGrid {
		if int(v) < before && v < NoFeatureThreshold {
			m.FeatureGrid[i] = remap[v]
		}
	}
	m.FeatureTableRaw = raw
	m.Header.FeatureCount = uint32(after)
	return before, after
}
