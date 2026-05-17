package main

import (
	"bytes"
	"fmt"
	"image/png"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tnt"
)

func newTNTHeightmapCommand() *cobra.Command {
	var (
		target    string
		normalize bool
	)
	cmd := &cobra.Command{
		Use:   "heightmap <file.tnt>",
		Short: "Export the height attribute grid as a PNG",
		Long: `Render the per-cell elevation grid as an 8-bit grayscale PNG.

By default the pixel value equals the raw elevation byte (0-255).  This is
round-trip safe: 'kbot tnt pack' reads the same encoding back.  Pass
--normalize for a viewer-friendly stretched image (range scaled to 0-255).`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read tnt: %w", err)
			}
			m, err := tnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}
			out, err := openOutput(target)
			if err != nil {
				return err
			}
			defer closeOutput(out, target)
			if normalize {
				return png.Encode(out, m.RenderHeightMap())
			}
			return png.Encode(out, m.RenderHeightMapRaw())
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().BoolVar(&normalize, "normalize", false, "Stretch elevation range to 0-255 (viewer-friendly, lossy)")
	return cmd
}
