package mount

import (
	"github.com/coreprime/kbot/internal/explorer"
	"github.com/spf13/cobra"
)

func NewCommand() *cobra.Command {
	return explorer.NewCommand()
}
