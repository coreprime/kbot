package main

import "github.com/spf13/cobra"

func newGAFCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "gaf",
		Short: "Work with GAF animation files",
		Long: `List, export, and dump Total Annihilation GAF (Graphics Animation Format)
files containing sprite sequences and animation frames.`,
	}

	cmd.AddCommand(
		newGAFListCommand(),
		newGAFExportCommand(),
		newGAFDumpCommand(),
		newGAFBuildCommand(),
		newGAFRoundtripCommand(),
	)

	return cmd
}
