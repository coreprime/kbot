package main

import "github.com/spf13/cobra"

func newPALCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pal",
		Short: "Work with TA palette and color-lookup files",
		Long: `Inspect and convert Total Annihilation .PAL palettes, plus the related
.ALP / .LHT / .SHD 256x4 color-index lookup tables.`,
	}

	cmd.AddCommand(
		newPALInfoCommand(),
		newPALDescribeCommand(),
		newPALSwatchCommand(),
		newPALConvertCommand(),
		newPALLookupCommand(),
	)

	return cmd
}
