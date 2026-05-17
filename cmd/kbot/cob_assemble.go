package main

import (
	"bytes"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/scripting/assembly"
)

func newCobAssembleCommand() *cobra.Command {
	var (
		target string
		stream bool
	)

	cmd := &cobra.Command{
		Use:   "assemble <file.coba>",
		Short: "Assemble an assembly listing back to COB bytecode",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := readInput(args, stream)
			if err != nil {
				return err
			}

			asm := assembly.NewAssembler()
			cob, err := asm.Assemble(string(data))
			if err != nil {
				return fmt.Errorf("assembly failed: %w", err)
			}

			var buf bytes.Buffer
			if err := cob.WriteToWriter(&buf); err != nil {
				return fmt.Errorf("failed to serialize COB: %w", err)
			}

			return writeTarget(buf.Bytes(), target)
		},
	}

	cmd.Flags().StringVar(&target, "target", "", "Output file path (default: stdout)")
	cmd.Flags().BoolVar(&stream, "stream", false, "Read input from stdin")

	return cmd
}
