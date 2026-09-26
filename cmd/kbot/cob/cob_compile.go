package cob

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/scripting/compiler"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
)

func newCobCompileCommand() *cobra.Command {
	var (
		target string
		stream bool
		strict bool
	)

	cmd := &cobra.Command{
		Use:   "compile <file.bos>",
		Short: "Compile BOS source to COB bytecode",
		Long: `Compile BOS source code into COB bytecode.

The working directory is used as the virtual filesystem root so that
#include directives for .h files are resolved relative to it.

A script compiles as a TA script (COB version 4) unless it starts with
.version 6. TA 3.1c faults on TA: Kingdoms instructions, so in a TA
script these are errors: play-sound, Mission-Command, the __tak_math_*
intrinsics, .sound_name and the % operator (TA has no modulo
instruction; 0x10037000 is its bitwise XOR). Unknown identifiers,
functions needing more than the game's 32 stack slots and other
constructs the game would mis-run are errors too.

Problems that still compile (a function defined twice binds every call
to the first definition, as the game does; % under .version 6) and any
finding of the TA compatibility lint rules are printed to stderr as
warnings. --strict turns warnings into a failure.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := cli.ReadInput(args, stream)
			if err != nil {
				return err
			}

			// If reading from a file, chdir to its directory so that
			// relative #include paths resolve correctly.
			if len(args) > 0 {
				absPath, _ := filepath.Abs(args[0])
				dir := filepath.Dir(absPath)
				orig, _ := os.Getwd()
				if err := os.Chdir(dir); err == nil {
					defer func() { _ = os.Chdir(orig) }()
				}
			}

			comp := compiler.NewCompiler(string(data))
			cob, err := comp.Compile()
			if err != nil {
				return fmt.Errorf("compilation failed: %w", err)
			}
			warnings := append(append([]string{}, comp.Warnings()...), taCompatFindings(cob)...)
			if err := reportWarnings(cmd.ErrOrStderr(), warnings, strict); err != nil {
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
	cmd.Flags().BoolVar(&strict, "strict", false, "Fail when the compiler or the TA compatibility rules report a warning")

	return cmd
}
