package studio

import (
	"github.com/coreprime/kbot/internal/studio"
	"github.com/spf13/cobra"
)

func NewCommand() *cobra.Command {
	return studio.NewCommand()
}
