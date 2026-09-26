package zrb

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/smacker"
)

func newZRBToMP4Command() *cobra.Command {
	var (
		lineDouble   bool
		storedHeight bool
	)
	cmd := &cobra.Command{
		Use:   "to-mp4 <input.smk> <output.mp4>",
		Short: "Convert Smacker video to MP4",
		Long: `Convert a Smacker video file to MP4 (H.264/AAC) using FFmpeg.

The MP4 shows the movie as the game does: at its display height, with
square pixels, stopping at the header's frame count. The retail 640x240
movies (data/*.zrb) are interlaced, so the game shows them as 640x480
with every second line black; --line-double fills those lines by
repeating each stored line instead, and --stored-height keeps the stored
640x240 frames.

Requires FFmpeg to be installed:
  macOS:   brew install ffmpeg
  Linux:   sudo apt-get install ffmpeg
  Windows: Download from ffmpeg.org`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			opts := smacker.MP4Options{StoredHeight: storedHeight}
			if lineDouble {
				opts.Interlace = smacker.InterlaceLineDouble
			}
			fmt.Printf("Converting %s to MP4...\n", args[0])
			if err := smacker.ConvertToMP4WithOptions(args[0], args[1], opts); err != nil {
				return err
			}
			fmt.Printf("✅ Conversion complete: %s\n", args[1])
			return nil
		},
	}
	cmd.Flags().BoolVar(&lineDouble, "line-double", false, "Fill an interlaced movie's extra lines by repeating each line instead of black")
	cmd.Flags().BoolVar(&storedHeight, "stored-height", false, "Keep the stored frame height instead of the height the game shows")
	return cmd
}
