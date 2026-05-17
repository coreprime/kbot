package main

import "github.com/spf13/cobra"

func newCobCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "cob",
		Short: "Work with COB/BOS script files",
		Long: `Compile, decompile, assemble, and disassemble Total Annihilation
COB (Compiled Object Bytecode) and BOS (Building Object Script) files.`,
	}

	cmd.AddCommand(
		newCobDisassembleCommand(),
		newCobDecompileCommand(),
		newCobAssembleCommand(),
		newCobCompileCommand(),
		newCobRoundtripCommand(),
		newCobLintCommand(),
	)

	return cmd
}
