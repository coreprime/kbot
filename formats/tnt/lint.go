package tnt

import (
	"fmt"
	"image/color"
)

// LintSeverity classifies a TNT lint finding.  TNT lints currently
// describe size-reduction opportunities so all findings are LintInfo;
// the type is kept severity-shaped to match the COB linter and keep the
// explorer's lint UI uniform across formats.
type LintSeverity string

const (
	// LintInfo is an informational finding — typically a hint that
	// kbot tnt optimize could remove some redundancy.
	LintInfo LintSeverity = "info"
	// LintWarning is a potentially-impactful finding.
	LintWarning LintSeverity = "warning"
)

// LintDiagnostic is one finding from Map.Lint.  Count and BytesSaved
// duplicate information that Message also contains in human form so
// that the explorer can render badges, sort, and filter without parsing
// the Message string.
type LintDiagnostic struct {
	Rule       string       `json:"rule"`
	Severity   LintSeverity `json:"severity"`
	Message    string       `json:"message"`
	Count      int          `json:"count"`
	BytesSaved int          `json:"bytes_saved"`
}

// LintOptions tunes Map.Lint.
type LintOptions struct {
	// SimilarityPercent is the maximum mean per-channel pixel difference
	// (% of 255) for the similar-tiles rule.  Set to 0 to skip the
	// similarity check.  Required > 0 also implies Palette must be set.
	SimilarityPercent float64

	// Palette converts paletted tile bytes to RGB when scoring similarity.
	// Required when SimilarityPercent > 0.
	Palette color.Palette
}

// Lint inspects the map for size-reduction opportunities without
// mutating it.  Each rule mirrors a pass of Map.Optimize:
//
//	duplicate-tiles  tile graphics with byte-identical pixel data
//	similar-tiles    visually-similar tile graphics whose placements
//	                 share the same heightmap footprint
//	unused-tiles     tile graphics that no map cell references
//
// Lint runs Optimize on a deep copy of m, so the caller's map is left
// untouched and the reported counts match exactly what `kbot tnt
// optimize` would remove.
func (m *Map) Lint(opts LintOptions) ([]LintDiagnostic, error) {
	if m == nil {
		return nil, fmt.Errorf("nil map")
	}
	cp := m.clone()
	stats, err := cp.Optimize(OptimizeOptions{
		SimilarityPercent: opts.SimilarityPercent,
		Palette:           opts.Palette,
	})
	if err != nil {
		return nil, err
	}

	diags := make([]LintDiagnostic, 0, 3)
	if stats.ExactMerges > 0 {
		n := stats.ExactMerges
		diags = append(diags, LintDiagnostic{
			Rule:       "duplicate-tiles",
			Severity:   LintInfo,
			Count:      n,
			BytesSaved: n * TileGfxSize,
			Message: fmt.Sprintf(
				"%d byte-identical duplicate tile graphic%s — consolidating saves %d bytes",
				n, pluralS(n), n*TileGfxSize),
		})
	}
	if stats.SimilarityMerges > 0 {
		n := stats.SimilarityMerges
		diags = append(diags, LintDiagnostic{
			Rule:       "similar-tiles",
			Severity:   LintInfo,
			Count:      n,
			BytesSaved: n * TileGfxSize,
			Message: fmt.Sprintf(
				"%d tile graphic%s within ≤%g%% visual similarity (same heightmap footprint) — consolidating saves %d bytes",
				n, pluralS(n), opts.SimilarityPercent, n*TileGfxSize),
		})
	}
	if stats.UnusedRemoved > 0 {
		n := stats.UnusedRemoved
		diags = append(diags, LintDiagnostic{
			Rule:       "unused-tiles",
			Severity:   LintInfo,
			Count:      n,
			BytesSaved: n * TileGfxSize,
			Message: fmt.Sprintf(
				"%d unreferenced tile graphic%s — removing saves %d bytes",
				n, pluralS(n), n*TileGfxSize),
		})
	}
	return diags, nil
}

// clone returns a deep copy of m suitable for analysis without
// affecting the caller's data.  The feature table is not duplicated
// because Optimize never mutates it; Lint never writes back, so the
// copy only needs the fields Optimize touches.
func (m *Map) clone() *Map {
	cp := *m
	cp.TileMap = append([]uint16(nil), m.TileMap...)
	cp.TileAttr = append([]TileAttr(nil), m.TileAttr...)
	cp.Tiles = make([][]byte, len(m.Tiles))
	for i, t := range m.Tiles {
		cp.Tiles[i] = append([]byte(nil), t...)
	}
	if m.Minimap != nil {
		cp.Minimap = append([]byte(nil), m.Minimap...)
	}
	if m.MapDataPad != nil {
		cp.MapDataPad = append([]byte(nil), m.MapDataPad...)
	}
	return &cp
}

func pluralS(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
