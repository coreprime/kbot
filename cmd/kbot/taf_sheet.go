package main

import (
	"fmt"
	"image/color"
	"image/png"

	"github.com/spf13/cobra"
)

func newTAFSheetCommand() *cobra.Command {
	var (
		vfsRoot string
		target  string
		cols    int
		bgHex   string
	)
	cmd := &cobra.Command{
		Use:   "sheet <file.taf>",
		Short: "Tile every frame into one sprite-sheet PNG",
		Long: `Lay every frame out in a grid. Cells are sized to the largest frame and
smaller frames are anchored top-left. Handy for eyeballing a whole
animation at once.

Examples:
  kbot taf sheet anims/spark.taf --cols 8 --target spark-sheet.png
  kbot taf sheet frontend.taf --bg "#202020" > sheet.png`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			taf, _, cleanup, err := loadTAF(args[0], vfsRoot, target == "")
			defer cleanup()
			if err != nil {
				return err
			}
			bg, err := parseColor(bgHex, color.RGBA{0, 0, 0, 0})
			if err != nil {
				return fmt.Errorf("invalid --bg: %w", err)
			}
			img, err := taf.RenderSheet(cols, bg)
			if err != nil {
				return err
			}
			out, err := openOutput(target)
			if err != nil {
				return err
			}
			defer closeOutput(out, target)
			if err := png.Encode(out, img); err != nil {
				return fmt.Errorf("encode png: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().IntVar(&cols, "cols", 8, "Number of columns in the grid")
	cmd.Flags().StringVar(&bgHex, "bg", "transparent", "Background color (hex like #rrggbb or transparent)")
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}
