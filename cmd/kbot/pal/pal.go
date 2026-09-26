package pal

import "github.com/spf13/cobra"

func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pal",
		Short: "Work with TA palette and color-lookup files",
		Long: `Inspect and convert Total Annihilation .PAL palettes, plus the related
colour-index lookup tables: .ALP (65,536 bytes, 256x256 blends) and
.SHD / .LHT (8,192 bytes, 32 rows of 256).`,
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
