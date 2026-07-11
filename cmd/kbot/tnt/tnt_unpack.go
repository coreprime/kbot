package tnt

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/tnt"
)

func newTNTUnpackCommand() *cobra.Command {
	var (
		target   string
		lossless bool
	)
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
    metadata.json      header constants + round-trip info

By default the feature name table is omitted from metadata.json; 'kbot tnt
pack' rebuilds it from the unique names referenced in features.csv.  Pass
--lossless to preserve the original feature table (including any trailing
scratch bytes Cavedog's tooling left behind) so the directory packs back to
a byte-identical TNT.`,
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
			if m.IsTAK {
				return fmt.Errorf("TA: Kingdoms maps have no tile pool to unpack; use 'kbot tnt image' or 'kbot tnt heightmap' to export layers")
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

			pal, err := cli.TNTPalette()
			if err != nil {
				return err
			}
			if err := tnt.UnpackWithOptions(m, features, pal, target, tnt.UnpackOptions{Lossless: lossless}); err != nil {
				return err
			}

			mode := "lossy"
			if lossless {
				mode = "lossless"
			}
			fmt.Fprintf(os.Stderr, "Unpacked %s -> %s (%s)\n", path, target, mode)
			fmt.Fprintf(os.Stderr, "  %dx%d tiles, %d unique tile gfx, %d features, %d placements\n",
				m.TileW, m.TileH, len(m.Tiles), len(features), len(m.GetFeaturePlacements()))
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output directory (default: <input>_unpacked)")
	cmd.Flags().BoolVar(&lossless, "lossless", false,
		"Preserve features + feature_raw_b64 in metadata.json for byte-identical repack")
	return cmd
}
