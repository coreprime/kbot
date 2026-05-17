package main

import (
	"github.com/coreprime/kbot/internal/explorer"
	"github.com/spf13/cobra"
)

func newMountCommand() *cobra.Command {
	return explorer.NewCommand()
}
