package zrb

import "github.com/spf13/cobra"

func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "zrb",
		Short: "Work with Smacker/ZRB video files",
		Long:  `Inspect and convert Smacker (.smk/.zrb) video files.`,
	}

	cmd.AddCommand(
		newZRBInfoCommand(),
		newZRBToMP4Command(),
		newZRBFromMP4Command(),
	)

	return cmd
}
