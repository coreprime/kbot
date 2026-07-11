package taf

import (
	"bytes"
	"fmt"
	"image/gif"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/tsf"
)

func newTAFFromGIFCommand() *cobra.Command {
	var (
		target string
		format string
		name   string
	)
	cmd := &cobra.Command{
		Use:   "from-gif <file.gif>",
		Short: "Import an animated GIF as a TAF",
		Long: `Convert an animated GIF into a TAF.  Each GIF frame is flattened (with
disposal honoured) onto a full-size canvas and encoded as 16-bit ARGB;
GIF delays become TA: Kingdoms ticks.

Because GIF only carries 1-bit transparency, the resulting alpha is a
hard cutout.  Use ARGB4444 (the default) to retain a little alpha
headroom, or ARGB1555 for a sharper colour gamut.

Examples:
  kbot taf from-gif spark.gif --target spark.taf
  kbot taf from-gif logo.gif --format argb1555 --name LogoSpin`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			pf, err := tsf.ParsePixelFormat(format)
			if err != nil {
				return err
			}
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read gif: %w", err)
			}
			g, err := gif.DecodeAll(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("decode gif: %w", err)
			}

			base := strings.TrimSuffix(filepath.Base(args[0]), filepath.Ext(args[0]))
			if name == "" {
				name = base
			}
			taf, err := tsf.FromGIF(g, pf, name)
			if err != nil {
				return err
			}
			out, err := taf.Bytes()
			if err != nil {
				return fmt.Errorf("serialize taf: %w", err)
			}

			outPath := target
			if outPath == "" {
				outPath = base + ".taf"
			}
			return cli.WriteTarget(out, outPath)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output TAF path (default: <input>.taf)")
	cmd.Flags().StringVar(&format, "format", "argb4444", "Pixel format: argb4444 or argb1555")
	cmd.Flags().StringVar(&name, "name", "", "Sequence name (default: input base name)")
	return cmd
}
