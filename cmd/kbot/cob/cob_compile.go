package cob

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/scripting/compiler"
)

func newCobCompileCommand() *cobra.Command {
	var (
		target string
		stream bool
	)

	cmd := &cobra.Command{
		Use:   "compile <file.bos>",
		Short: "Compile BOS source to COB bytecode",
		Long: `Compile BOS source code into COB bytecode.

The working directory is used as the virtual filesystem root so that
#include directives for .h files are resolved relative to it.`,
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

			var buf bytes.Buffer
			if err := cob.WriteToWriter(&buf); err != nil {
				return fmt.Errorf("failed to serialize COB: %w", err)
			}

			return cli.WriteTarget(buf.Bytes(), target)
		},
	}

	cmd.Flags().StringVar(&target, "target", "", "Output file path (default: stdout)")
	cmd.Flags().BoolVar(&stream, "stream", false, "Read input from stdin")

	return cmd
}
