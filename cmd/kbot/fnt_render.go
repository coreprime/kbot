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
			fg, err := parseColor(fgHex, color.RGBA{255, 255, 255, 255})
			if err != nil {
				return fmt.Errorf("invalid --fg: %w", err)
			}
			bg, err := parseColor(bgHex, color.RGBA{0, 0, 0, 0})
			if err != nil {
				return fmt.Errorf("invalid --bg: %w", err)
			}
			img := f.RenderText(text, fg, bg)
			out, err := openOutput(target)
			if err != nil {
				return err
			}
			defer closeOutput(out, target)
			return png.Encode(out, img)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().StringVar(&text, "text", "", "Text to render")
	cmd.Flags().StringVar(&fgHex, "fg", "#ffffff", "Foreground color (hex like #rrggbb or transparent)")
	cmd.Flags().StringVar(&bgHex, "bg", "transparent", "Background color (hex like #rrggbb or transparent)")
	return cmd
}

// parseColor accepts "#RRGGBB", "#RRGGBBAA" or "transparent".
func parseColor(s string, dflt color.RGBA) (color.RGBA, error) {
	if s == "" {
		return dflt, nil
	}
	if s == "transparent" || s == "none" {
		return color.RGBA{0, 0, 0, 0}, nil
	}
	if len(s) > 0 && s[0] == '#' {
		s = s[1:]
	}
	if len(s) != 6 && len(s) != 8 {
		return dflt, fmt.Errorf("expected #rrggbb or #rrggbbaa, got %q", s)
	}
	var r, g, b uint8
	var a uint8 = 255
	if _, err := fmt.Sscanf(s[0:2], "%02x", &r); err != nil {
		return dflt, err
	}
	if _, err := fmt.Sscanf(s[2:4], "%02x", &g); err != nil {
		return dflt, err
	}
	if _, err := fmt.Sscanf(s[4:6], "%02x", &b); err != nil {
		return dflt, err
	}
	if len(s) == 8 {
		if _, err := fmt.Sscanf(s[6:8], "%02x", &a); err != nil {
			return dflt, err
		}
	}
	return color.RGBA{R: r, G: g, B: b, A: a}, nil
}
