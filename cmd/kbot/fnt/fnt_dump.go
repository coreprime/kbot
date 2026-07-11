package fnt

import (
	"bytes"
	"fmt"
	"image/color"
	"image/png"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/fnt"
)

func newFNTDumpCommand() *cobra.Command {
	var (
		target string
		fgHex  string
		bgHex  string
	)
	cmd := &cobra.Command{
		Use:   "dump <file.fnt>",
		Short: "Dump every defined glyph as a separate PNG into a directory",
		Long: `Write one PNG per defined glyph into the target directory.
Each file is named "U+00XX.png" so the output sorts in code-point order.`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			if target == "" {
				return fmt.Errorf("--target directory is required")
			}
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read fnt: %w", err)
			}
			f, err := fnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse fnt: %w", err)
			}
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("create output directory: %w", err)
			}
			fg, err := cli.ParseColor(fgHex, color.RGBA{255, 255, 255, 255})
			if err != nil {
				return fmt.Errorf("invalid --fg: %w", err)
			}
			bg, err := cli.ParseColor(bgHex, color.RGBA{0, 0, 0, 0})
			if err != nil {
				return fmt.Errorf("invalid --bg: %w", err)
			}

			written := 0
			for ch, g := range f.Glyphs {
				if g == nil {
					continue
				}
				img := g.RenderImage(fg, bg)
				name := fmt.Sprintf("U+%04X.png", ch)
				p := filepath.Join(target, name)
				out, err := os.Create(p)
				if err != nil {
					return fmt.Errorf("create %s: %w", p, err)
				}
				if err := png.Encode(out, img); err != nil {
					_ = out.Close()
					return fmt.Errorf("encode %s: %w", p, err)
				}
				_ = out.Close()
				written++
			}
			fmt.Fprintf(os.Stderr, "Wrote %d glyphs to %s\n", written, target)
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output directory (required)")
	cmd.Flags().StringVar(&fgHex, "fg", "#ffffff", "Foreground color")
	cmd.Flags().StringVar(&bgHex, "bg", "transparent", "Background color")
	return cmd
}
