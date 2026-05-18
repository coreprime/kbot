package main

import "github.com/spf13/cobra"

func newSCTCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "sct",
		Short: "Work with SCT map section files",
		Long:  `Inspect and render Total Annihilation .SCT map sections.`,
	}

	cmd.AddCommand(
		newSCTInfoCommand(),
		newSCTDescribeCommand(),
		newSCTImageCommand(),
		newSCTHeightmapCommand(),
		newSCTMinimapCommand(),
	)

	return cmd
}
