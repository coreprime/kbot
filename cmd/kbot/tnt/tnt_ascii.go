package tnt

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/tnt"
)

func newTNTASCIICommand() *cobra.Command {
	var cols int
	cmd := &cobra.Command{
		Use:   "ascii <file.tnt>",
		Short: "Print a tiny ASCII rendering of the map elevation",
		Long: `Print a small ASCII-art height map.  Useful as a quick sanity
check from a terminal — and frankly, a bit of a dev-joke.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read tnt: %w", err)
			}
			m, err := tnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}
			fmt.Print(m.RenderASCII(cols))
			return nil
		},
	}
	cmd.Flags().IntVar(&cols, "cols", 64, "Number of columns in the rendered output")
	return cmd
}
