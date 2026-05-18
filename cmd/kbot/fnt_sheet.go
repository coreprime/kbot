package main

import (
	"bytes"
	"fmt"
	"image/color"
	"image/png"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/fnt"
)

func newFNTSheetCommand() *cobra.Command {
	var (
		target string
		fgHex  string
		bgHex  string
	)
	cmd := &cobra.Command{
		Use:   "sheet <file.fnt>",
		Short: "Render every defined glyph as a 16-column sprite sheet PNG",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read fnt: %w", err)
			}
			f, err := fnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse fnt: %w", err)
			}
			fg, err := parseColor(fgHex, color.RGBA{255, 255, 255, 255})
			if err != nil {
				return fmt.Errorf("invalid --fg: %w", err)
			}
			bg, err := parseColor(bgHex, color.RGBA{0, 0, 0, 0})
			if err != nil {
				return fmt.Errorf("invalid --bg: %w", err)
			}
			img := f.RenderSheet(fg, bg)
			out, err := openOutput(target)
			if err != nil {
				return err
			}
			defer closeOutput(out, target)
			return png.Encode(out, img)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().StringVar(&fgHex, "fg", "#ffffff", "Foreground color")
	cmd.Flags().StringVar(&bgHex, "bg", "#222222", "Background color")
	return cmd
}
