package zrb

import "github.com/spf13/cobra"

func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "zrb",
		Short: "Work with Smacker/ZRB video files",
		Long: `Inspect Smacker (.smk/.zrb) video files and convert them to MP4.

There is no conversion the other way: no Smacker encoder exists (see
"kbot zrb from-mp4 --help").`,
	}

	cmd.AddCommand(
		newZRBInfoCommand(),
		newZRBToMP4Command(),
		newZRBFromMP4Command(),
	)

	return cmd
}
