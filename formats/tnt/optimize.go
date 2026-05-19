package tnt

import (
	"crypto/sha256"
	"fmt"
	"image/color"
	"io"
)

// OptimizeOptions tunes the Map.Optimize pass.
type OptimizeOptions struct {
	// SimilarityPercent is the maximum mean per-channel pixel difference
	// (expressed as a percent of 255) between two tile graphics for them
	// to be treated as visually similar and consolidated.  Set to 0 to
	// skip the similarity pass and only collapse byte-identical tiles.
	SimilarityPercent float64

	// Palette converts paletted tile bytes to RGB when scoring visual
	// similarity.  Required when SimilarityPercent > 0.
	Palette color.Palette

	// KeepUnused keeps tile graphics that no cell in the tilemap
	// references.  Defaults to false (unreferenced tiles are dropped).
	KeepUnused bool

	// Progress receives one-line human-readable status updates while the
	// optimisation runs.  Pass os.Stderr for CLI use, or nil to silence.
	Progress io.Writer
}

// OptimizeStats summarises Map.Optimize results.
type OptimizeStats struct {
	TilesBefore      int
	TilesAfter       int
	ExactMerges      int
	SimilarityMerges int
	UnusedRemoved    int
}

// Optimize rewrites m in-place to collapse redundant tile graphics.
//
// Three passes run in order:
//
//  1. byte-identical tile graphics are merged into a single index;
//  2. visually-similar tile graphics whose placements share the same
//     heightmap footprint are merged (skipped when SimilarityPercent is 0);
//  3. tile graphics that no longer have any placement are removed
//     (skipped when KeepUnused is true).
//
// The on-disk heightmap and feature placements are preserved verbatim;
// only m.Tiles and m.TileMap are rewritten.
func (m *Map) Optimize(opts OptimizeOptions) (OptimizeStats, error) {
	stats := OptimizeStats{}
	if m == nil {
		return stats, fmt.Errorf("nil map")
	}
	stats.TilesBefore = len(m.Tiles)
	if len(m.Tiles) == 0 {
		stats.TilesAfter = 0
		return stats, nil
	}

	stats.ExactMerges = m.mergeExactDuplicates(opts.Progress)

	if opts.SimilarityPercent > 0 {
		if opts.Palette == nil {
			return stats, fmt.Errorf("optimize: SimilarityPercent>0 requires Palette")
		}
		stats.SimilarityMerges = m.mergeSimilarTiles(opts.SimilarityPercent, opts.Palette, opts.Progress)
	}

	if !opts.KeepUnused {
		stats.UnusedRemoved = m.removeUnusedTiles(opts.Progress)
	}

	stats.TilesAfter = len(m.Tiles)
	return stats, nil
}

func (m *Map) mergeExactDuplicates(progress io.Writer) int {
	progressf(progress, "pass 1: hashing %d tile graphics for exact duplicates\n", len(m.Tiles))
	canonical := make(map[[32]byte]int, len(m.Tiles))
	parent := make([]int, len(m.Tiles))
	for i := range parent {
		parent[i] = i
	}
	dupes := 0
	for i, tile := range m.Tiles {
		h := sha256.Sum256(tile)
		if c, ok := canonical[h]; ok {
			parent[i] = c
			dupes++
			continue
		}
		canonical[h] = i
	}
	if dupes == 0 {
		progressf(progress, "  no exact duplicates found\n")
		return 0
	}
	progressf(progress, "  consolidated %d tile graphics (exact match)\n", dupes)
	m.rewriteWithParent(parent)
	return dupes
}

func (m *Map) mergeSimilarTiles(thresholdPercent float64, palette color.Palette, progress io.Writer) int {
	n := len(m.Tiles)
	if n < 2 {
		return 0
	}
	progressf(progress, "pass 2: scoring visual similarity (<=%g%% per-pixel diff) across %d tiles\n",
		thresholdPercent, n)

	const pixelsPerTile = 32 * 32
	rgbAll := make([]byte, n*pixelsPerTile*3)
	for i, tile := range m.Tiles {
		base := i * pixelsPerTile * 3
		for p := 0; p < pixelsPerTile; p++ {
			var r, g, b uint8
			idx := tile[p]
			if int(idx) < len(palette) {
				rr, gg, bb, _ := palette[idx].RGBA()
				r = uint8(rr >> 8)
				g = uint8(gg >> 8)
				b = uint8(bb >> 8)
			}
			off := base + p*3
			rgbAll[off+0] = r
			rgbAll[off+1] = g
			rgbAll[off+2] = b
		}
	}

	sigs := m.buildHeightSignatures()

	// Convert "mean per-channel diff in percent of 255" into a total-sum
	// budget over all 32*32*3 channel samples.  A pair is "similar" when
	// the running diff stays at or below this budget.
	budget := uint64(thresholdPercent / 100.0 * 255.0 * float64(pixelsPerTile*3))

	parent := make([]int, n)
	for i := range parent {
		parent[i] = i
	}
	merges := 0

	for i := 0; i < n; i++ {
		if parent[i] != i {
			continue
		}
		if i > 0 && i%128 == 0 {
			progressf(progress, "  scanning tile %d/%d (%d merges so far)\n", i, n, merges)
		}
		sigI := sigs[i]
		baseI := i * pixelsPerTile * 3
		for j := i + 1; j < n; j++ {
			if parent[j] != j {
				continue
			}
			if !heightSetsEqual(sigI, sigs[j]) {
				continue
			}
			baseJ := j * pixelsPerTile * 3
			var diff uint64
			similar := true
			for p := 0; p < pixelsPerTile*3; p++ {
				a := rgbAll[baseI+p]
				b := rgbAll[baseJ+p]
				if a > b {
					diff += uint64(a - b)
				} else {
					diff += uint64(b - a)
				}
				if diff > budget {
					similar = false
					break
				}
			}
			if similar {
				parent[j] = i
				merges++
			}
		}
	}

	if merges == 0 {
		progressf(progress, "  no visually-similar groups under threshold\n")
		return 0
	}
	progressf(progress, "  consolidated %d tile graphics (visual similarity)\n", merges)
	m.rewriteWithParent(parent)
	return merges
}

// removeUnusedTiles drops tile graphics that are not referenced by any
// cell of m.TileMap.  Returns the number of tiles removed.
func (m *Map) removeUnusedTiles(progress io.Writer) int {
	used := make([]bool, len(m.Tiles))
	for _, ti := range m.TileMap {
		if int(ti) < len(used) {
			used[int(ti)] = true
		}
	}
	dropped := 0
	for _, u := range used {
		if !u {
			dropped++
		}
	}
	if dropped == 0 {
		return 0
	}
	progressf(progress, "dropping %d unreferenced tile graphics\n", dropped)
	newIdx := make([]int, len(m.Tiles))
	newTiles := make([][]byte, 0, len(m.Tiles)-dropped)
	for i, t := range m.Tiles {
		if !used[i] {
			newIdx[i] = -1
			continue
		}
		newIdx[i] = len(newTiles)
		newTiles = append(newTiles, t)
	}
	m.Tiles = newTiles
	for i, ti := range m.TileMap {
		ni := newIdx[int(ti)]
		if ni < 0 {
			// Defensive: a placement referenced a tile we just dropped.
			// used[] is built from m.TileMap so this can only happen
			// when TileMap holds out-of-range indices; clamp to 0.
			ni = 0
		}
		m.TileMap[i] = uint16(ni)
	}
	return dropped
}

// heightTuple is the (top-left, top-right, bottom-left, bottom-right)
// 4-tuple of elevation bytes that sits under a single 32x32 tile placement.
type heightTuple [4]uint8

// buildHeightSignatures walks the tilemap and collects, for each tile
// index, the set of distinct 4-tuple heightmap footprints observed at
// its placements.  Tiles that are never placed get a nil entry.
func (m *Map) buildHeightSignatures() []map[heightTuple]struct{} {
	sigs := make([]map[heightTuple]struct{}, len(m.Tiles))
	for ty := 0; ty < m.TileH; ty++ {
		for tx := 0; tx < m.TileW; tx++ {
			ti := int(m.TileMap[ty*m.TileW+tx])
			if ti < 0 || ti >= len(m.Tiles) {
				continue
			}
			ax, ay := tx*2, ty*2
			h := heightTuple{
				m.TileAttr[ay*m.AttrW+ax].Height,
				m.TileAttr[ay*m.AttrW+(ax+1)].Height,
				m.TileAttr[(ay+1)*m.AttrW+ax].Height,
				m.TileAttr[(ay+1)*m.AttrW+(ax+1)].Height,
			}
			set := sigs[ti]
			if set == nil {
				set = make(map[heightTuple]struct{})
				sigs[ti] = set
			}
			set[h] = struct{}{}
		}
	}
	return sigs
}

func heightSetsEqual(a, b map[heightTuple]struct{}) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if _, ok := b[k]; !ok {
			return false
		}
	}
	return true
}

// rewriteWithParent collapses tile indices per a union-find parent[]
// table (each entry points at its canonical root) and rebuilds m.Tiles
// and m.TileMap accordingly.  The canonical for each cluster is the
// lowest original index it contains, so the resulting tile order is
// stable.
func (m *Map) rewriteWithParent(parent []int) {
	root := make([]int, len(parent))
	for i := range parent {
		r := i
		for parent[r] != r {
			r = parent[r]
		}
		root[i] = r
	}
	newIdx := make([]int, len(parent))
	newTiles := make([][]byte, 0, len(parent))
	for i := range parent {
		if root[i] == i {
			newIdx[i] = len(newTiles)
			newTiles = append(newTiles, m.Tiles[i])
		}
	}
	for i := range parent {
		if root[i] != i {
			newIdx[i] = newIdx[root[i]]
		}
	}
	m.Tiles = newTiles
	for i, ti := range m.TileMap {
		m.TileMap[i] = uint16(newIdx[int(ti)])
	}
}

func progressf(w io.Writer, format string, args ...any) {
	if w == nil {
		return
	}
	_, _ = fmt.Fprintf(w, format, args...)
}
