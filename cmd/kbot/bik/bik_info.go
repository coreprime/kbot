package bik

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/bik"
)

func newBIKInfoCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "info <file.bik>",
		Short: "Display information about a Bink video file",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			reader, err := bik.OpenReader(args[0])
			if err != nil {
				return err
			}
			defer func() { _ = reader.Close() }()

			fmt.Print(reader.Info())
			return nil
		},
	}
}
