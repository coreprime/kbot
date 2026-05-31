package ctx

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/internal/kbotctx"
)

func newCtxPathCommand() *cobra.Command {
	var alias string
	cmd := &cobra.Command{
		Use:   "path",
		Short: "Print the active context's path",
		Long: `Print the path of the active kbot context to stdout, with no trailing
status text, so it can be used in shell substitution.

Examples:
  cd "$(kbot ctx path)"
  ls "$(kbot ctx path)/units"
  KBOT_CONTEXT=kingdoms cd "$(kbot ctx path)"

Pass --alias to print a specific context's path instead of the active
one.

Exit codes:
  0  path printed
  1  no context is active (or named alias not found)`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := kbotctx.Load()
			if err != nil {
				return err
			}
			if alias != "" {
				entry, ok := cfg.Contexts[alias]
				if !ok {
					return fmt.Errorf("context %q not found", alias)
				}
				_, _ = fmt.Fprintln(cmd.OutOrStdout(), entry.Path)
				return nil
			}
			name, entry, _, ok := cfg.Active()
			if !ok {
				if name != "" {
					return fmt.Errorf("%s=%s names an unknown kbot context", kbotctx.EnvVar, name)
				}
				return fmt.Errorf("no active kbot context (run `kbot ctx add` or `kbot ctx use <alias>`)")
			}
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), entry.Path)
			return nil
		},
	}
	cmd.Flags().StringVar(&alias, "alias", "", "Print this alias's path instead of the active context")
	return cmd
}
