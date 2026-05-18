package main

import (
	"bytes"
	"fmt"
	"image/png"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/sct"
)

func newSCTImageCommand() *cobra.Command {
	var target string
	cmd := &cobra.Command{
		Use:   "image <file.sct>",
		Short: "Render the section's tile grid to a PNG",
		Long:  `Render the SCT tile grid into a single RGBA PNG (32px per tile).`,
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
			pal, err := tntPalette()
			if err != nil {
				return err
			}
			img := s.RenderTileMap(pal)
			out, err := openOutput(target)
			if err != nil {
				return err
			}
			defer closeOutput(out, target)
			return png.Encode(out, img)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	return cmd
}
