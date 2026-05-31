package bik

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/bik"
)

func newBIKToMP4Command() *cobra.Command {
	return &cobra.Command{
		Use:   "to-mp4 <input.bik> <output.mp4>",
		Short: "Convert Bink video to MP4",
		Long: `Convert a Bink video file to MP4 format using FFmpeg.

Requires FFmpeg with the Bink decoder (binkvideo), which ships in standard
builds:
  macOS:   brew install ffmpeg
  Linux:   sudo apt-get install ffmpeg
  Windows: Download from ffmpeg.org`,
		Args: cobra.ExactArgs(2),
		RunE: func(_ *cobra.Command, args []string) error {
			fmt.Printf("Converting %s to MP4...\n", args[0])
			if err := bik.ConvertToMP4(args[0], args[1]); err != nil {
				return err
			}
			fmt.Printf("✅ Conversion complete: %s\n", args[1])
			return nil
		},
	}
}
