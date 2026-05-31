package fnt

import "github.com/spf13/cobra"

func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "fnt",
		Short: "Work with bitmap font files",
		Long:  `Inspect, render, and dump Total Annihilation 1bpp bitmap font files.`,
	}

	cmd.AddCommand(
		newFNTInfoCommand(),
		newFNTDescribeCommand(),
		newFNTRenderCommand(),
		newFNTSheetCommand(),
		newFNTDumpCommand(),
	)

	return cmd
}
