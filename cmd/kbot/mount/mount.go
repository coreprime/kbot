package mount

import (
	mountpkg "github.com/coreprime/kbot/internal/mount"
	"github.com/spf13/cobra"
)

func NewCommand() *cobra.Command {
	return mountpkg.NewCommand()
}
