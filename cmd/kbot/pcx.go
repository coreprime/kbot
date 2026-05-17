package main

import "github.com/spf13/cobra"

func newPCXCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pcx",
		Short: "Work with PCX image files",
		Long:  `Describe, convert, and inspect PCX image files.`,
	}

	cmd.AddCommand(
		newPCXDescribeCommand(),
		newPCXConvertCommand(),
		newPCXInfoCommand(),
	)

	return cmd
}
