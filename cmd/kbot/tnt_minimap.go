package main

import (
	"bytes"
	"fmt"
	"image/color"
	"image/png"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tnt"
)

func newTNTMinimapCommand() *cobra.Command {
	var (
		target   string
		paletted bool
		kingdom  string
	)
	cmd := &cobra.Command{
		Use:   "minimap <file.tnt>",
		Short: "Export the minimap as a PNG",
		Long: `Render the embedded minimap as a PNG.

By default the output is RGBA with the void/padding byte rendered as
transparent.  Pass --paletted to get a paletted 8-bit PNG that preserves
the original palette indices (round-trip safe).

TA: Kingdoms maps render with their per-kingdom terrain palette, taken
from the sibling .ota's kingdom field. Pass --kingdom (aramon, taros,
veruna, zhon, creon) to override or supply it when the .ota is absent.`,
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
			if m.Minimap == nil {
				return fmt.Errorf("file has no minimap")
			}
			var pal color.Palette
			if m.IsTAK {
				pal, err = takPaletteForTNT(args[0], kingdom)
			} else {
				pal, err = tntPalette()
			}
			if err != nil {
				return err
			}
			out, err := openOutput(target)
			if err != nil {
				return err
			}
			defer closeOutput(out, target)
			if paletted {
				return png.Encode(out, m.RenderMinimapPaletted(pal))
			}
			return png.Encode(out, m.RenderMinimap(pal))
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().BoolVar(&paletted, "paletted", false, "Emit an 8-bit paletted PNG preserving raw palette indices")
	cmd.Flags().StringVar(&kingdom, "kingdom", "", "TA:K palette override (aramon, taros, veruna, zhon, creon)")
	return cmd
}
