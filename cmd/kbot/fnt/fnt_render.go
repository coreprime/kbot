package fnt

import (
	"bytes"
	"fmt"
	"image/color"
	"image/png"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/fnt"
)

func newFNTRenderCommand() *cobra.Command {
	var (
		target string
		text   string
		fgHex  string
		bgHex  string
	)
	cmd := &cobra.Command{
		Use:   "render <file.fnt>",
		Short: "Render a string in the given font to a PNG",
		Long: `Render a string in the given font to a PNG.

Examples:
  kbot fnt render comix.fnt --text "Hello TA" --target hello.png
  kbot fnt render armfont.fnt --text "Commander" --fg "#ffff00" --bg "transparent"`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if text == "" {
				return fmt.Errorf("--text is required")
			}
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read fnt: %w", err)
			}
			f, err := fnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse fnt: %w", err)
			}
			fg, err := cli.ParseColor(fgHex, color.RGBA{255, 255, 255, 255})
			if err != nil {
				return fmt.Errorf("invalid --fg: %w", err)
			}
			bg, err := cli.ParseColor(bgHex, color.RGBA{0, 0, 0, 0})
			if err != nil {
				return fmt.Errorf("invalid --bg: %w", err)
			}
			img := f.RenderText(text, fg, bg)
			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)
			return png.Encode(out, img)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().StringVar(&text, "text", "", "Text to render")
	cmd.Flags().StringVar(&fgHex, "fg", "#ffffff", "Foreground color (hex like #rrggbb or transparent)")
	cmd.Flags().StringVar(&bgHex, "bg", "transparent", "Background color (hex like #rrggbb or transparent)")
	return cmd
}

// cli.ParseColor accepts "#RRGGBB", "#RRGGBBAA" or "transparent".
