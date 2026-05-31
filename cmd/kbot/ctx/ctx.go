package ctx

import (
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/internal/kbotctx"
)

func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "ctx",
		Short: "Manage kbot working-directory contexts",
		Long: `Register named Total Annihilation installs (packed or flattened) so
kbot's VFS-backed commands can pick them up automatically.

The config lives at ~/.kbot.  The active context is whichever alias is
named in the "current" field, but the KBOT_CONTEXT environment variable
overrides it for the running process.

Running 'kbot ctx' with no subcommand lists the registered contexts
(same as 'kbot ctx list').  Pass --help to see the full help text.

Subcommands:
  add     Register a new context
  here    Adopt the current directory as a context
  list    List registered contexts
  path    Print the active context's path (for $(kbot ctx path))
  use     Switch the persisted current context
  delete  Remove a context`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runCtxList(cmd)
		},
	}
	cmd.AddCommand(newCtxAddCommand())
	cmd.AddCommand(newCtxHereCommand())
	cmd.AddCommand(newCtxListCommand())
	cmd.AddCommand(newCtxPathCommand())
	cmd.AddCommand(newCtxUseCommand())
	cmd.AddCommand(newCtxDeleteCommand())
	return cmd
}

func newCtxAddCommand() *cobra.Command {
	var (
		alias   string
		game    string
		version string
		replace bool
	)
	cmd := &cobra.Command{
		Use:   "add <path>",
		Short: "Register a working-directory context",
		Long: fmt.Sprintf(`Register <path> as a named kbot context.

<path> may be either a packed TA install (containing .hpi/.ufo/.ccx/.gp3
archives) or a flattened directory.

Required flags:
  --alias <alias>           Short name to refer to the context by
  --game  totala|takingdoms|custom

Optional flags:
  --version <x>             Version label (e.g. "3.1c")
  --replace                 Overwrite an existing alias

The first context added becomes the current context automatically.

Examples:
  kbot ctx add ~/games/totala --alias ta-gog --game %s --version 3.1c
  kbot ctx add ~/games/tak    --alias kingdoms --game %s
`, kbotctx.GameTotalA, kbotctx.GameTAKingdoms),
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := args[0]
			cfg, err := kbotctx.Load()
			if err != nil {
				return err
			}
			if _, err := os.Stat(path); err != nil {
				return fmt.Errorf("path %s: %w", path, err)
			}
			if err := cfg.Add(alias, kbotctx.Context{
				Path:    path,
				Game:    strings.ToLower(game),
				Version: version,
			}, replace); err != nil {
				return err
			}
			if err := cfg.Save(); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "Added context %q -> %s\n", alias, cfg.Contexts[alias].Path)
			if cfg.Current == alias {
				fmt.Fprintf(os.Stderr, "Set %q as current context\n", alias)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&alias, "alias", "", "Short name to refer to the context by (required)")
	cmd.Flags().StringVar(&game, "game", "", fmt.Sprintf("Game flavour: %s (required)", strings.Join(kbotctx.ValidGames, ", ")))
	cmd.Flags().StringVar(&version, "version", "", "Optional version label (e.g. \"3.1c\")")
	cmd.Flags().BoolVar(&replace, "replace", false, "Overwrite an existing alias")
	_ = cmd.MarkFlagRequired("alias")
	_ = cmd.MarkFlagRequired("game")
	return cmd
}

func newCtxListCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List registered contexts",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runCtxList(cmd)
		},
	}
}

func runCtxList(cmd *cobra.Command) error {
	cfg, err := kbotctx.Load()
	if err != nil {
		return err
	}
	out := cmd.OutOrStdout()
	errOut := cmd.ErrOrStderr()
	if len(cfg.Contexts) == 0 {
		_, _ = fmt.Fprintln(errOut, "No contexts registered. Try: kbot ctx add <path> --alias <name> --game totala")
		return nil
	}
	activeAlias, _, activeSource, _ := cfg.Active()
	tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(tw, "CURRENT\tALIAS\tGAME\tVERSION\tPATH"); err != nil {
		return err
	}
	for _, alias := range cfg.Aliases() {
		marker := ""
		if alias == activeAlias {
			marker = "*"
			if activeSource == "env" {
				marker = "* (env)"
			}
		}
		ctx := cfg.Contexts[alias]
		version := ctx.Version
		if version == "" {
			version = "-"
		}
		if _, err := fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", marker, alias, ctx.Game, version, ctx.Path); err != nil {
			return err
		}
	}
	if err := tw.Flush(); err != nil {
		return err
	}
	if activeAlias != "" && activeSource == "env" {
		_, _ = fmt.Fprintf(errOut, "\n%s=%s overriding persisted current=%q\n", kbotctx.EnvVar, activeAlias, cfg.Current)
	}
	return nil
}

func newCtxUseCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "use <alias>",
		Short: "Switch the persisted current context",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			alias := args[0]
			cfg, err := kbotctx.Load()
			if err != nil {
				return err
			}
			if err := cfg.Use(alias); err != nil {
				return err
			}
			if err := cfg.Save(); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "Switched current context to %q (%s)\n", alias, cfg.Contexts[alias].Path)
			if env := os.Getenv(kbotctx.EnvVar); env != "" && env != alias {
				fmt.Fprintf(os.Stderr, "Note: %s=%s is set and will still override this for the current shell\n", kbotctx.EnvVar, env)
			}
			return nil
		},
	}
}

func newCtxDeleteCommand() *cobra.Command {
	return &cobra.Command{
		Use:     "delete <alias>",
		Aliases: []string{"rm", "remove"},
		Short:   "Remove a context",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			alias := args[0]
			cfg, err := kbotctx.Load()
			if err != nil {
				return err
			}
			if err := cfg.Delete(alias); err != nil {
				return err
			}
			if err := cfg.Save(); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "Deleted context %q\n", alias)
			if cfg.Current == "" {
				fmt.Fprintln(os.Stderr, "No current context set. Use `kbot ctx use <alias>` to pick one.")
			}
			return nil
		},
	}
}
