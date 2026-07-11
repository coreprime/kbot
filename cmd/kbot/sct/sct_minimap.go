package sct

import (
	"bytes"
	"fmt"
	"image/png"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/sct"
)

func newSCTMinimapCommand() *cobra.Command {
	var target string
	cmd := &cobra.Command{
		Use:   "minimap <file.sct>",
		Short: "Export the embedded 128x128 minimap as a PNG",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read sct: %w", err)
			}
			s, err := sct.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse sct: %w", err)
			}
			if s.Minimap == nil {
				return fmt.Errorf("section has no minimap")
			}
			pal, err := cli.TNTPalette()
			if err != nil {
				return err
			}
			img := s.RenderMinimap(pal)
			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)
			return png.Encode(out, img)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	return cmd
}
