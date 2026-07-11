package pal

import (
	"fmt"
	"image/png"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/pal"
)

func newPALSwatchCommand() *cobra.Command {
	var (
		target   string
		cellSize int
	)
	cmd := &cobra.Command{
		Use:   "swatch <file.pal>",
		Short: "Render a palette as a 16x16 PNG swatch grid",
		Long: `Render the palette as a 16x16 grid of square color cells.
Index 0 (the transparent sentinel) is drawn with a magenta hatch so it is
visible alongside the other entries.`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			p, err := pal.LoadFromFile(args[0])
			if err != nil {
				return fmt.Errorf("parse pal: %w", err)
			}
			img := p.RenderSwatch(cellSize)
			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)
			return png.Encode(out, img)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().IntVar(&cellSize, "cell", 16, "Pixel size of each color cell")
	return cmd
}
