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

func newTNTVoidmapCommand() *cobra.Command {
	var target string
	cmd := &cobra.Command{
		Use:   "voidmap <file.tnt>",
		Short: "Export the engine-void mask as a PNG",
		Long: `Render an attribute-resolution PNG (one pixel per 16×16 attribute cell)
highlighting cells whose Feature value is 0xFFFC — the canonical
engine-void sentinel.  Void cells are opaque red; everything else is
transparent so the output can be overlaid on a tnt image render.

0xFFFD / 0xFFFE are deliberately not classified as void (see
docs/formats/tnt.md); use 'kbot tnt describe' to inspect those values.`,
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
			if m.IsTAK {
				return fmt.Errorf("TA: Kingdoms maps are not yet supported by voidmap (void sentinels are TA-specific)")
			}
			img := m.RenderVoidMap()
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
	return cmd
}
