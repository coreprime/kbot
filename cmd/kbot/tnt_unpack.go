package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tnt"
)

func newTNTUnpackCommand() *cobra.Command {
	var target string
	cmd := &cobra.Command{
		Use:   "unpack <file.tnt>",
		Short: "Unpack a TNT into a directory of editable files",
		Long: `Decompose a TNT into a directory tree:

  <target>/
    map.png            full RGBA render of the tile grid
    heightmap.png      8-bit grayscale, pixel = raw elevation byte
    minimap.png        paletted PNG of the embedded minimap
    tiles/<n>.png      paletted 32x32 PNG per unique tile
    tilemap.csv        2D grid of tile indices (rows = y, cols = x)
    features.csv       feature_index,name,attr_x,attr_y (one row per placement)
    metadata.json      header constants + feature table + round-trip info

The unpack output round-trips through 'kbot tnt pack' to a byte-identical TNT.`,
		Args: cobra.ExactArgs(1),
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

			if target == "" {
				base := filepath.Base(path)
				ext := filepath.Ext(base)
				target = base[:len(base)-len(ext)] + "_unpacked"
			}

			pal, err := tntPalette()
			if err != nil {
				return err
			}
			if err := tnt.Unpack(m, features, pal, target); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Unpacked %s -> %s\n", path, target)
			fmt.Fprintf(os.Stderr, "  %dx%d tiles, %d unique tile gfx, %d features, %d placements\n",
				m.TileW, m.TileH, len(m.Tiles), len(features), len(m.GetFeaturePlacements()))
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output directory (default: <input>_unpacked)")
	return cmd
}
