package main

import (
	"bytes"
	"fmt"
	"os"
	"sort"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tnt"
)

func newTNTDescribeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "describe <file.tnt>",
		Short: "Show a summary of a TNT map",
		Long:  `Print header geometry, tile/feature counts, height statistics, and the most-placed features.`,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
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

			fmt.Printf("TNT File: %s\n", path)
			fmt.Printf("File Size: %d bytes\n\n", len(data))

			fmt.Printf("Header:\n")
			fmt.Printf("  IDVersion:   0x%X\n", m.Header.IDVersion)
			fmt.Printf("  Width:       %d (16px cells) -> %d tiles, %d pixels\n",
				m.AttrW, m.TileW, m.TileW*32)
			fmt.Printf("  Height:      %d (16px cells) -> %d tiles, %d pixels\n",
				m.AttrH, m.TileH, m.TileH*32)
			fmt.Printf("  SeaLevel:    %d\n", m.Header.SeaLevel)
			fmt.Printf("  Tiles:       %d unique\n", len(m.Tiles))
			fmt.Printf("  Features:    %d in table, %d placements\n", len(features), placements)
			fmt.Printf("  Minimap:     %dx%d\n", m.MinimapW, m.MinimapH)
			fmt.Printf("  Unknown1:    %d   Pads: %d %d %d %d\n",
				m.Header.Unknown1, m.Header.Pad1, m.Header.Pad2, m.Header.Pad3, m.Header.Pad4)

			fmt.Printf("\nElevation:\n")
			fmt.Printf("  min=%d max=%d mean=%.1f  cells below sealevel: %d (%.2f%%)\n",
				minH, maxH, mean, belowSea, 100*float64(belowSea)/float64(len(m.TileAttr)))

			if len(features) > 0 {
				fmt.Printf("\nTop features:\n")
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
					fmt.Printf("  [%3d] %-32s  count=%d\n", ps[i].idx, name, ps[i].count)
				}
			}
			return nil
		},
	}
}
