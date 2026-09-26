package tnt

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"sort"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/tnt"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
)

func newTNTDescribeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "describe <file.tnt>",
		Short: "Show a summary of a TNT map",
		Long: `Print header geometry, tile/feature counts, height statistics, and the most-placed features.

The format line says which game reads the map: 0x2000 is a TA map, 0x1020
the older TA layout (TA reads it; kbot writes it back as 0x2000) and 0x4000
a TA: Kingdoms map, which TA cannot load.  Placements count only the cells
the game places a feature on: words below the feature-table size (0xFFFC
marks a void cell, and other high words place nothing).  MinimapFlags is the
header word at 0x2c (0x3c in a 0x1020 map); the game reads the stored minimap
only when bit 0 is set.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			w := cmd.OutOrStdout()
			path := args[0]
			data, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("read tnt: %w", err)
			}
			r := bytes.NewReader(data)
			m, err := tnt.LoadFromReader(r)
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}

			if m.IsTAK {
				describeTAK(w, path, data, m)
				return nil
			}

			features, err := m.LoadFeatures(r)
			if err != nil {
				return fmt.Errorf("read features: %w", err)
			}

			var minH, maxH uint16 = 255, 0
			var sum uint64
			belowSea := 0
			for _, a := range m.TileAttr {
				h := uint16(a.Height)
				if h < minH {
					minH = h
				}
				if h > maxH {
					maxH = h
				}
				sum += uint64(h)
				if uint32(a.Height) < m.Header.SeaLevel {
					belowSea++
				}
			}
			mean := 0.0
			if len(m.TileAttr) > 0 {
				mean = float64(sum) / float64(len(m.TileAttr))
			}

			counts := m.FeatureCounts()
			placements := 0
			for _, c := range counts {
				placements += c
			}

			reportf(w, "TNT File: %s\n", path)
			reportf(w, "File Size: %d bytes\n\n", len(data))

			flags := m.Header.MinimapFlags()
			minimapNote := "not read: bit 0 clear, the game builds the radar picture from the tiles"
			if flags&tnt.MinimapPresent != 0 {
				minimapNote = "bit 0 set, the game reads the stored minimap"
			}
			reportf(w, "Header:\n")
			reportf(w, "  IDVersion:   0x%X (%s)\n", m.Header.IDVersion, tntFormatLabel(m))
			reportf(w, "  Width:       %d (16px cells) -> %d tiles, %d pixels\n",
				m.AttrW, m.TileW, m.TileW*32)
			reportf(w, "  Height:      %d (16px cells) -> %d tiles, %d pixels\n",
				m.AttrH, m.TileH, m.TileH*32)
			reportf(w, "  SeaLevel:    %d\n", m.Header.SeaLevel)
			reportf(w, "  Tiles:       %d unique\n", len(m.Tiles))
			reportf(w, "  Features:    %d in table, %d placements\n", len(features), placements)
			reportf(w, "  Minimap:     %dx%d\n", m.MinimapW, m.MinimapH)
			reportf(w, "  MinimapFlags: %d (%s)\n", flags, minimapNote)
			reportf(w, "  Pads:        %d %d %d %d\n",
				m.Header.Pad1, m.Header.Pad2, m.Header.Pad3, m.Header.Pad4)

			reportf(w, "\nElevation:\n")
			reportf(w, "  min=%d max=%d mean=%.1f  cells below sealevel: %d (%.2f%%)\n",
				minH, maxH, mean, belowSea, 100*float64(belowSea)/float64(len(m.TileAttr)))

			if len(features) > 0 {
				reportf(w, "\nTop features:\n")
				type pair struct {
					idx, count int
				}
				ps := make([]pair, 0, len(counts))
				for i, c := range counts {
					ps = append(ps, pair{i, c})
				}
				sort.Slice(ps, func(i, j int) bool { return ps[i].count > ps[j].count })
				limit := 10
				if len(ps) < limit {
					limit = len(ps)
				}
				for i := 0; i < limit; i++ {
					name := ""
					if ps[i].idx < len(features) {
						name = features[ps[i].idx].Name
					}
					reportf(w, "  [%3d] %-32s  count=%d\n", ps[i].idx, name, ps[i].count)
				}
			}
			return nil
		},
	}
}

// reportf writes report text to w. Write errors are ignored: the report
// goes to a terminal, and there is nowhere better to report them.
func reportf(w io.Writer, format string, args ...any) {
	_, _ = fmt.Fprintf(w, format, args...)
}

// tntFormatLabel names the game that reads a TNT, by its version word.
func tntFormatLabel(m *tnt.Map) string {
	switch {
	case m.IsTAK:
		return "TA: Kingdoms only; Total Annihilation cannot load it"
	case m.IsLegacy():
		return "older TA layout; TA reads it, kbot writes 0x2000"
	}
	return "Total Annihilation"
}

// describeTAK prints a summary of a TA: Kingdoms TNT: header geometry,
// embedded minimap, heightmap/terrain grid dimensions, and the feature table
// with placement counts.
func describeTAK(w io.Writer, path string, data []byte, m *tnt.Map) {
	reportf(w, "TNT File: %s\n", path)
	reportf(w, "File Size: %d bytes\n\n", len(data))

	reportf(w, "Header (TA: Kingdoms variant):\n")
	reportf(w, "  IDVersion:   0x%X (%s)\n", m.Header.IDVersion, tntFormatLabel(m))
	reportf(w, "  Width:       %d DataUnits (%d px)\n", m.Header.Width, m.TAKPixelW())
	reportf(w, "  Height:      %d DataUnits (%d px)\n", m.Header.Height, m.TAKPixelH())
	reportf(w, "  Minimap:     %dx%d\n", m.MinimapW, m.MinimapH)
	if k := cli.TAKKingdomForTNT(path); k != "" {
		reportf(w, "  Kingdom:     %s (terrain/minimap palette)\n", k)
	}

	features, _ := m.LoadFeatures(bytes.NewReader(data))
	placements := m.TAKFeaturePlacements()
	reportf(w, "  Heightmap:   %dx%d DataUnits\n", m.TAKW, m.TAKH)
	reportf(w, "  Terrain:     %dx%d Graphic Units (texture-mapped, %dx%d px)\n", m.TAKGUW, m.TAKGUH, m.TAKPixelW(), m.TAKPixelH())
	reportf(w, "  Features:    %d in table, %d placements\n", len(features), len(placements))

	if len(features) > 0 && len(placements) > 0 {
		counts := make([]int, len(features))
		for _, p := range placements {
			if p.FeatureIdx < len(counts) {
				counts[p.FeatureIdx]++
			}
		}
		type pair struct{ idx, count int }
		ps := make([]pair, 0, len(counts))
		for i, c := range counts {
			if c > 0 {
				ps = append(ps, pair{i, c})
			}
		}
		sort.Slice(ps, func(i, j int) bool { return ps[i].count > ps[j].count })
		limit := 10
		if len(ps) < limit {
			limit = len(ps)
		}
		reportf(w, "\nTop features:\n")
		for i := 0; i < limit; i++ {
			reportf(w, "  [%3d] %-20s  count=%d\n", ps[i].idx, features[ps[i].idx].Name, ps[i].count)
		}
	}

	reportf(w, "\nNote: render the full map with 'kbot tnt image' (add\n")
	reportf(w, "--features to overlay placements) and the elevation grid\n")
	reportf(w, "with 'kbot tnt heightmap'.\n")
}
