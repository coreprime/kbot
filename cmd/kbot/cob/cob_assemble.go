package cob

import (
	"bytes"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/scripting/assembly"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
)

func newCobAssembleCommand() *cobra.Command {
	var (
		target string
		stream bool
		strict bool
	)

	cmd := &cobra.Command{
		Use:   "assemble <file.coba>",
		Short: "Assemble an assembly listing back to COB bytecode",
		Long: `Assemble a listing (as written by 'kbot cob disassemble') into COB
bytecode.

The assembler writes any opcode word it is given, including the raw
forms NAME@0x... and UNKNOWN_0x..., and reads the mnemonics earlier
listings used (MOD, BITWISE_XOR, BITWISE_NOT, LOGICAL_XOR) as the words
those listings were made from. Unless the listing declares .version 6
(TA: Kingdoms), the result is checked against what TA 3.1c runs and
every problem is printed to stderr as a warning: TA: Kingdoms
instructions, words the game does not run, PUSH/POP flags it faults on,
GET with fewer than five pending values and more than 32 stack slots.
--strict turns warnings into a failure.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := cli.ReadInput(args, stream)
			if err != nil {
				return err
			}

			asm := assembly.NewAssembler()
			cob, err := asm.Assemble(string(data))
			if err != nil {
				return fmt.Errorf("assembly failed: %w", err)
			}
			if err := reportWarnings(cmd.ErrOrStderr(), taCompatFindings(cob), strict); err != nil {
				return err
			}

			var buf bytes.Buffer
			if err := cob.WriteToWriter(&buf); err != nil {
				return fmt.Errorf("failed to serialize COB: %w", err)
			}

			return cli.WriteTarget(buf.Bytes(), target)
		},
	}

	cmd.Flags().StringVar(&target, "target", "", "Output file path (default: stdout)")
	cmd.Flags().BoolVar(&stream, "stream", false, "Read input from stdin")
	cmd.Flags().BoolVar(&strict, "strict", false, "Fail when the TA compatibility rules report a warning")

	return cmd
}
