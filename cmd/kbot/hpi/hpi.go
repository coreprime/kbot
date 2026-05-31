package hpi

import "github.com/spf13/cobra"

func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "hpi",
		Short: "Work with HPI/UFO/CCX archive files",
		Long: `List, extract, pack, and inspect Total Annihilation archive files.
Supports HPI, UFO, and CCX formats.`,
	}

	cmd.AddCommand(
		newHPIListCommand(),
		newHPIExtractCommand(),
		newHPIPackCommand(),
		newHPIInfoCommand(),
	)

	return cmd
}
