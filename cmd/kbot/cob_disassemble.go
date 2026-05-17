package main

import (
	"bytes"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/assembly"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
)

func newCobDisassembleCommand() *cobra.Command {
	var (
		target       string
		stream       bool
		scriptFilter string
		annotated    bool
	)

	cmd := &cobra.Command{
		Use:   "disassemble <file.cob>",
		Short: "Disassemble COB bytecode to an assembly listing",
		Long: `Produce a human-readable assembly listing from a COB file.

By default the listing is written to stdout.  Use --target to write
to a file instead.  Pass --stream to read the COB from stdin.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := readInput(args, stream)
			if err != nil {
				return err
			}

			cob, err := scripting.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("failed to parse COB: %w", err)
			}

			dec := decompiler.NewDecompiler(cob)

			format := assembly.Plain
			if annotated {
				format = assembly.Annotated
			}

			var output string
			if scriptFilter != "" {
				output, err = dec.DisassembleScript(scriptFilter, format)
			} else {
				output, err = dec.Disassemble(format)
			}
			if err != nil {
				return fmt.Errorf("disassembly failed: %w", err)
			}

			return writeTarget([]byte(output), target)
		},
	}

	cmd.Flags().StringVar(&target, "target", "", "Output file path (default: stdout)")
	cmd.Flags().BoolVar(&stream, "stream", false, "Read input from stdin")
	cmd.Flags().StringVarP(&scriptFilter, "script", "s", "", "Disassemble only the named script")
	cmd.Flags().BoolVarP(&annotated, "annotated", "a", false, "Annotated output with flow arrows and hex opcodes")

	return cmd
}
