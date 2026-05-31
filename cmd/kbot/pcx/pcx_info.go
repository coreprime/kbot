package pcx

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/pcx"
)

func newPCXInfoCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "info <file.pcx>",
		Short: "Display basic information about a PCX file",
		Long:  `Display basic information about a PCX file (simplified version of describe).`,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			f, err := os.Open(args[0])
			if err != nil {
				return fmt.Errorf("failed to open file: %w", err)
			}
			defer func() { _ = f.Close() }()

			reader, err := pcx.LoadFromReader(f)
			if err != nil {
				return fmt.Errorf("failed to read PCX file: %w", err)
			}

			fmt.Printf("%s: %dx%d, %d-bit\n", args[0], reader.Width(), reader.Height(), reader.BitsPerPixel())
			return nil
		},
	}
}
