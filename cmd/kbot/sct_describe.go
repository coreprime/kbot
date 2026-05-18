package main

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/sct"
)

func newSCTDescribeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "describe <file.sct>",
		Short: "Show a detailed summary of an SCT file",
		Long:  `Print header geometry, tile counts, height statistics and minimap availability.`,
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read sct: %w", err)
			}
			s, err := sct.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse sct: %w", err)
			}

			var minH, maxH uint8 = 255, 0
			var sum uint64
			for _, h := range s.HeightMap {
				if h.Height < minH {
					minH = h.Height
				}
				if h.Height > maxH {
					maxH = h.Height
				}
				sum += uint64(h.Height)
			}
			mean := 0.0
			if len(s.HeightMap) > 0 {
				mean = float64(sum) / float64(len(s.HeightMap))
			} else {
				minH = 0
			}

			fmt.Printf("SCT File: %s\n", args[0])
			fmt.Printf("File Size: %d bytes\n\n", len(data))

			fmt.Printf("Header:\n")
			fmt.Printf("  Version:       %d\n", s.Header.Version)
			fmt.Printf("  Tile grid:     %d x %d  (%d tiles)\n",
				s.Header.Width, s.Header.Height, s.Header.Width*s.Header.Height)
			fmt.Printf("  Pixel size:    %d x %d\n", s.Header.Width*32, s.Header.Height*32)
			fmt.Printf("  Unique tiles:  %d\n", len(s.Tiles))
			fmt.Printf("  Attribute grid: %d x %d  (16px resolution)\n", s.AttrW, s.AttrH)
			fmt.Printf("  Minimap:       %v\n", s.Minimap != nil)
			fmt.Printf("  Heightmap:     %v\n", s.HeightMap != nil)

			if len(s.HeightMap) > 0 {
				fmt.Printf("\nElevation:\n")
				fmt.Printf("  min=%d max=%d mean=%.1f\n", minH, maxH, mean)
			}
			return nil
		},
	}
}
