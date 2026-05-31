package pal

import (
	"fmt"
	"image/png"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/pal"
)

func newPALLookupCommand() *cobra.Command {
	var (
		target      string
		palettePath string
		cellSize    int
	)
	cmd := &cobra.Command{
		Use:   "lookup <file.alp|.lht|.shd>",
		Short: "Render a color-index lookup table as a 256x4 PNG swatch",
		Long: `Render a 1024-byte TA color-index lookup table (.ALP / .LHT / .SHD) as a
256-wide x 4-tall swatch image.  Each byte in the table is mapped through the
provided --palette (defaults to the embedded TA palette) for display.`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			table, err := pal.LoadLookupFromFile(args[0])
			if err != nil {
				return fmt.Errorf("read lookup: %w", err)
			}

			var p *pal.Palette
			if palettePath != "" {
				p, err = pal.LoadFromFile(palettePath)
				if err != nil {
					return fmt.Errorf("load palette: %w", err)
				}
			} else {
				p, err = cli.EmbeddedPalette()
				if err != nil {
					return err
				}
			}

			img, err := pal.RenderLookupSwatch(table, p, cellSize)
			if err != nil {
				return err
			}
			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)
			return png.Encode(out, img)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().StringVar(&palettePath, "palette", "", "Optional .PAL file to use for index→RGB mapping")
	cmd.Flags().IntVar(&cellSize, "cell", 4, "Pixel size of each cell")
	return cmd
}
