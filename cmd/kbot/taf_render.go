package main

import (
	"fmt"
	"image/png"

	"github.com/spf13/cobra"
)

func newTAFRenderCommand() *cobra.Command {
	var (
		vfsRoot string
		target  string
		frame   int
	)
	cmd := &cobra.Command{
		Use:   "render <file.taf>",
		Short: "Export a single frame as a PNG",
		Long: `Decode one frame of a TAF to a non-premultiplied RGBA PNG, preserving
its alpha channel exactly.

Examples:
  kbot taf render frontend.taf --frame 0 --target frame0.png
  kbot taf render anims/loadscreen.taf > preview.png`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			taf, _, cleanup, err := loadTAF(args[0], vfsRoot, target == "")
			defer cleanup()
			if err != nil {
				return err
			}
			img, err := taf.FrameImage(frame)
			if err != nil {
				return err
			}
			out, err := openOutput(target)
			if err != nil {
				return err
			}
			defer closeOutput(out, target)
			if err := png.Encode(out, img); err != nil {
				return fmt.Errorf("encode png: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().IntVar(&frame, "frame", 0, "Frame index to render")
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}
