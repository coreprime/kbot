package tnt

import (
	"bytes"
	"fmt"
	"image/png"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/tnt"
)

func newTNTBuildmapCommand() *cobra.Command {
	var (
		target   string
		seaLevel int
	)
	cmd := &cobra.Command{
		Use:   "buildmap <file.tnt>",
		Short: "Export a per-cell buildability classification as a PNG",
		Long: `Render an attribute-resolution PNG (one pixel per 16×16 attribute cell)
that classifies every cell into one of five buckets:

  black   void (Feature == 0xFFFC)
  red     a feature is placed in this cell (rocks, trees, geovents, ...)
  blue    underwater — Height is below sea level
  yellow  cliff edge — |Δheight| to a 4-neighbour exceeds 32 game units
  green   buildable

By default the .tnt header's SeaLevel field is used for the underwater
classification; pass --sealevel to override (0 disables the check).

TA: Kingdoms maps classify their DataUnit grid (same 16px cell size) the
same way, minus the void bucket — the 0x4000 format has no void sentinel.`,
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
			sea := m.Header.SeaLevel
			if cmd.Flags().Changed("sealevel") {
				if seaLevel < 0 {
					seaLevel = 0
				}
				sea = uint32(seaLevel)
			}
			img := m.RenderBuildMap(sea)
			if img == nil {
				return fmt.Errorf("map has no attribute grid")
			}
			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)
			if err := png.Encode(out, img); err != nil {
				return fmt.Errorf("encode png: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().IntVar(&seaLevel, "sealevel", 0, "Override sea level for the underwater check (default: TNT header value, 0 disables)")
	return cmd
}
