package main

import (
	"github.com/spf13/cobra"
)

// newTSFCommand builds the `kbot tsf` command tree for the text form of TA:
// Kingdoms animations.
func newTSFCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tsf",
		Short: "TA: Kingdoms animation text scripts (.tsf)",
		Long: `Inspect and validate TSF documents — the human-readable, brace-delimited
text form of a TAF animation.  The GUI loader consumes TSF directly for
menu backgrounds; "kbot taf decompile" emits it and "kbot taf compile"
reads it back.

Sub-commands:
  info   Summarise the animation, frames and layers
  lint   Check the document matches the compiler's expectations`,
	}
	cmd.AddCommand(
		newTSFInfoCommand(),
		newTSFLintCommand(),
	)
	return cmd
}
