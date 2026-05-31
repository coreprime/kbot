package crt

import "github.com/spf13/cobra"

func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "crt",
		Short: "Work with TA: Kingdoms .crt scenario files",
		Long: `Inspect Total Annihilation: Kingdoms .crt scenario files, which pair
with a map's .tnt to store pre-placed units, the per-player rule engine
and named trigger regions.`,
	}

	cmd.AddCommand(newCRTDescribeCommand())

	return cmd
}
