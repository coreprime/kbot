package tnt

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/tnt"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
)

func newTNTPackCommand() *cobra.Command {
	var target string
	cmd := &cobra.Command{
		Use:   "pack <source-dir>",
		Short: "Pack an unpacked directory back into a TNT file",
		Long: `Read a directory produced by 'kbot tnt unpack' (or the same layout)
and write a TNT file.

Required entries in the source directory:
  metadata.json     header constants + feature table
  heightmap.png     8-bit grayscale, pixel = elevation byte
  minimap.png       paletted PNG (omit when metadata reports 0x0)
  tiles/<n>.png     paletted 32x32 PNGs, n = 0..tile_count-1
  tilemap.csv       2D grid of tile indices
  features.csv      placements (feature_index, name, attr_x, attr_y)

map.png is informational and ignored on pack.

Every tilemap.csv value must be the index of a tile in tiles/ (0 to
tile_count-1), and every features.csv row must name a feature of the
table: TNT tile indices are 16-bit indices into the tile set, and feature
words from 0xFFFB up are sentinels.  Pack refuses anything else rather
than write a map that reads differently.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			src := args[0]
			info, err := os.Stat(src)
			if err != nil {
				return fmt.Errorf("source path: %w", err)
			}
			if !info.IsDir() {
				return fmt.Errorf("source must be a directory: %s", src)
			}

			m, features, err := tnt.Pack(src)
			if err != nil {
				return err
			}

			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)
			if err := m.Save(out, features); err != nil {
				return fmt.Errorf("save tnt: %w", err)
			}
			if target != "" {
				fmt.Fprintf(os.Stderr, "Packed %s -> %s\n", src, target)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output TNT path (default: stdout)")
	return cmd
}
