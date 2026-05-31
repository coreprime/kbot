package zrb

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/smacker"
)

func newZRBToMP4Command() *cobra.Command {
	return &cobra.Command{
		Use:   "to-mp4 <input.smk> <output.mp4>",
		Short: "Convert Smacker video to MP4",
		Long: `Convert a Smacker video file to MP4 format using FFmpeg.

Requires FFmpeg to be installed:
  macOS:   brew install ffmpeg
  Linux:   sudo apt-get install ffmpeg
  Windows: Download from ffmpeg.org`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Printf("Converting %s to MP4...\n", args[0])
			if err := smacker.ConvertToMP4(args[0], args[1]); err != nil {
				return err
			}
			fmt.Printf("✅ Conversion complete: %s\n", args[1])
			return nil
		},
	}
}
