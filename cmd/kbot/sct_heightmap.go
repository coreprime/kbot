package main

import (
	"bytes"
	"fmt"
	"image/png"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/sct"
)

func newSCTHeightmapCommand() *cobra.Command {
	var target string
	cmd := &cobra.Command{
		Use:   "heightmap <file.sct>",
		Short: "Export the section's height data as a grayscale PNG",
		Long:  `Render the 16-pixel-resolution attribute height grid as a normalized grayscale PNG.`,
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
			img := s.RenderHeightMap()
			if img == nil {
				return fmt.Errorf("section has no height data")
			}
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
