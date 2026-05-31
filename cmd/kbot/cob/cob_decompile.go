package cob

import (
	"bytes"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
)

func newCobDecompileCommand() *cobra.Command {
	var (
		target string
		stream bool
	)

	cmd := &cobra.Command{
		Use:   "decompile <file.cob>",
		Short: "Decompile COB bytecode to BOS source",
		Long: `Convert a COB bytecode file into readable BOS source code.

Output goes to stdout by default; use --target to write to a file.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := cli.ReadInput(args, stream)
			if err != nil {
				return err
			}

			cob, err := scripting.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("failed to parse COB: %w", err)
			}

			dec := decompiler.NewDecompiler(cob)
			output, err := dec.Decompile()
			if err != nil {
				return fmt.Errorf("decompilation failed: %w", err)
			}

			return cli.WriteTarget([]byte(output), target)
		},
	}

	cmd.Flags().StringVar(&target, "target", "", "Output file path (default: stdout)")
	cmd.Flags().BoolVar(&stream, "stream", false, "Read input from stdin")

	return cmd
}
