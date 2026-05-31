package main

import "github.com/spf13/cobra"

func newBIKCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "bik",
		Short: "Work with Bink video files",
		Long: `Inspect and convert Bink (.bik) video files — the cutscene format used by
TA: Kingdoms in place of the Smacker (.zrb) videos in the original game.

Conversion is decode-only: FFmpeg can decode Bink but no Bink encoder exists
outside RAD's proprietary tools, so there is no from-mp4 counterpart.`,
	}

	cmd.AddCommand(
		newBIKInfoCommand(),
		newBIKToMP4Command(),
	)

	return cmd
}
