package main

import (
	"bytes"
	"fmt"
	"image"
	_ "image/jpeg" // allow JPEG sprite sheets
	_ "image/png"  // allow PNG sprite sheets
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tsf"
)

func newTAFFromSheetCommand() *cobra.Command {
	var (
		target         string
		format         string
		name           string
		frameW, frameH int
		count          int
		delay          int
	)
	cmd := &cobra.Command{
		Use:   "from-sheet <file.png>",
		Short: "Import a sprite-sheet image as a TAF",
		Long: `Slice a sprite-sheet image into equal frames and build a TAF.  Cells
are read left-to-right then top-to-bottom; --frame-width and
--frame-height are required.  --count limits how many cells are taken
(0 = every full cell).  Each frame is given the same --delay in ticks.

Examples:
  kbot taf from-sheet sparks.png --frame-width 32 --frame-height 32 --delay 3
  kbot taf from-sheet run.png --frame-width 64 --frame-height 64 --count 8 --target run.taf`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			pf, err := tsf.ParsePixelFormat(format)
			if err != nil {
				return err
			}
			if frameW <= 0 || frameH <= 0 {
				return fmt.Errorf("--frame-width and --frame-height are required and must be positive")
			}
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read sheet: %w", err)
			}
			img, _, err := image.Decode(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("decode sheet: %w", err)
			}

			base := strings.TrimSuffix(filepath.Base(args[0]), filepath.Ext(args[0]))
			if name == "" {
				name = base
			}
			taf, err := tsf.FromSheet(img, frameW, frameH, count, pf, name, uint32(delay))
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
			return writeTarget(out, outPath)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output TAF path (default: <input>.taf)")
	cmd.Flags().StringVar(&format, "format", "argb4444", "Pixel format: argb4444 or argb1555")
	cmd.Flags().StringVar(&name, "name", "", "Sequence name (default: input base name)")
	cmd.Flags().IntVar(&frameW, "frame-width", 0, "Frame width in pixels (required)")
	cmd.Flags().IntVar(&frameH, "frame-height", 0, "Frame height in pixels (required)")
	cmd.Flags().IntVar(&count, "count", 0, "Number of frames to take (0 = every full cell)")
	cmd.Flags().IntVar(&delay, "delay", 3, "Per-frame duration in ticks")
	return cmd
}
