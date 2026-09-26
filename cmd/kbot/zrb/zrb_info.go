package zrb

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/smacker"
)

func newZRBInfoCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "info <file.smk>",
		Short: "Display information about a Smacker video file",
		Long: `Display information about a Smacker video file: signature, stored and
display size (the retail 640x240 movies are interlaced and shown as
640x480), frame count and rate, and each audio track the game plays
(a track is used only when its present bit is set) with its sample rate,
channels, sample size and compression.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			reader, err := smacker.OpenReader(args[0])
			if err != nil {
				return err
			}
			defer func() { _ = reader.Close() }()

			fmt.Print(reader.Info())
			return nil
		},
	}
}
