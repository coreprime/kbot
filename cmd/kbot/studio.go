package main

import (
	"github.com/coreprime/kbot/internal/studio"
	"github.com/spf13/cobra"
)

func newStudioCommand() *cobra.Command {
	return studio.NewCommand()
}
