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
		Args:  cobra.ExactArgs(1),
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
