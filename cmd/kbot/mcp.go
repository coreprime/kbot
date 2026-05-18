package main

import (
	"context"
	"fmt"
	"os"
	"sort"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/internal/kbotctx"
	kmcp "github.com/coreprime/kbot/internal/mcp"
)

func newMCPCommand() *cobra.Command {
	var (
		httpAddr  string
		mounts    []string
		gameData  []string
	)

	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "Run kbot as a Model Context Protocol server",
		Long: `Expose kbot's Total Annihilation format tooling over the Model
Context Protocol so that AI assistants (Claude Desktop, Cursor, etc.)
can decompile, lint, inspect and extract TA assets directly.

Transports:
  stdio  (default)  Suitable for clients that launch the binary as a
                    subprocess and speak JSON-RPC over stdin/stdout.
  http              Streamable HTTP for long-lived multi-client setups.

Mount roots:
  --mount restricts every path argument to lie inside the given
  directory.  Multiple --mount flags may be passed.  When no mount is
  configured (and no --game-data either), the server runs in permissive
  mode and all absolute paths are accepted — useful for local
  development, risky for shared hosts.

Game-data folders:
  --game-data NAME=PATH (or just PATH) registers a Total Annihilation /
  TA: Kingdoms install as a named virtual filesystem.  Archives (.hpi,
  .ufo, .ccx, .gp3) inside the folder are layered over physical files
  exactly as the game sees them.  Repeat the flag for multiple installs;
  the first entry is the default.

  When game-data is configured, every tool's path argument accepts:
    - an absolute on-disk path,
    - a virtual path inside the VFS ("units/ARMCOM.fbi"), or
    - a bare filename ("ARMCOM.bos") which the resolver searches for
      across every archive and physical file.

  The new vfs_find / vfs_list / vfs_stat tools let the model query the
  virtual filesystem directly.

  If no --game-data flag is passed, kbot falls back to the kbot ctx
  registrations in ~/.kbot.  Every registered context is exposed as a
  named game-data folder, and the current context (or whichever alias
  KBOT_CONTEXT names) becomes the default.  The ctx_list / ctx_current
  tools expose the contexts' game-flavour and version metadata.

Examples:
  kbot mcp --mount ~/games/totala
  kbot mcp --game-data ~/games/totala
  kbot mcp --game-data totala=~/games/totala --game-data kingdoms=~/games/tak
  kbot mcp --http 127.0.0.1:8765 --game-data ~/games/totala`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var ctxSpecs []kmcp.ContextSpec
			if len(gameData) == 0 && len(mounts) == 0 {
				cfg, err := kbotctx.Load()
				if err != nil {
					return err
				}
				activeAlias, _, activeSrc, activeOK := cfg.Active()
				if !activeOK && activeAlias != "" && activeSrc == "env" {
					return fmt.Errorf("%s=%s names an unknown kbot context (run `kbot ctx list`)", kbotctx.EnvVar, activeAlias)
				}
				ctxSpecs = contextsFromConfig(cfg, activeAlias)
				if len(ctxSpecs) > 0 {
					reportContexts(ctxSpecs, activeSrc)
				}
			}

			srv, cleanup, err := kmcp.NewServer(kmcp.Config{
				Version:    Version,
				MountRoots: mounts,
				GameData:   gameData,
				Contexts:   ctxSpecs,
			})
			if err != nil {
				return fmt.Errorf("init mcp server: %w", err)
			}
			defer func() { _ = cleanup() }()

			// All status output goes to stderr so the stdio transport
			// (which uses stdout for JSON-RPC framing) stays clean.
			if len(mounts) > 0 {
				fmt.Fprintf(os.Stderr, "kbot mcp: %d mount root(s) configured\n", len(mounts))
			}
			if len(gameData) > 0 {
				fmt.Fprintf(os.Stderr, "kbot mcp: %d game-data folder(s) configured\n", len(gameData))
			}
			if len(mounts) == 0 && len(gameData) == 0 && len(ctxSpecs) == 0 {
				fmt.Fprintln(os.Stderr, "kbot mcp: running in permissive mode — no mounts, game-data, or kbot contexts configured")
			}

			if httpAddr != "" {
				fmt.Fprintf(os.Stderr, "kbot mcp: serving HTTP on %s\n", httpAddr)
				return kmcp.ServeHTTP(context.Background(), srv, httpAddr)
			}

			fmt.Fprintln(os.Stderr, "kbot mcp: serving stdio")
			return kmcp.ServeStdio(srv)
		},
	}

	cmd.Flags().StringVar(&httpAddr, "http", "", "Serve streamable HTTP on this address (e.g. 127.0.0.1:8765); default is stdio")
	cmd.Flags().StringSliceVar(&mounts, "mount", nil, "Restrict tools to paths under this root (repeatable)")
	cmd.Flags().StringSliceVar(&gameData, "game-data", nil, "Register a game-data folder as 'NAME=PATH' or 'PATH' (repeatable; first is default)")

	return cmd
}

// contextsFromConfig flattens a kbot config into ContextSpecs for the
// MCP server, marking the active alias Current so the registry picks
// it as the default.  Non-current entries follow in alphabetical order
// so the listing is stable across runs.
func contextsFromConfig(cfg *kbotctx.Config, activeAlias string) []kmcp.ContextSpec {
	if cfg == nil || len(cfg.Contexts) == 0 {
		return nil
	}
	aliases := make([]string, 0, len(cfg.Contexts))
	for a := range cfg.Contexts {
		aliases = append(aliases, a)
	}
	sort.Strings(aliases)

	specs := make([]kmcp.ContextSpec, 0, len(aliases))
	for _, a := range aliases {
		c := cfg.Contexts[a]
		specs = append(specs, kmcp.ContextSpec{
			Alias:   a,
			Path:    c.Path,
			Game:    c.Game,
			Version: c.Version,
			Current: a == activeAlias,
		})
	}
	return specs
}

// reportContexts prints a one-line-per-context summary to stderr so
// the operator can see what was picked up from ~/.kbot.  Output goes
// to stderr to keep the stdio JSON-RPC stream clean.
func reportContexts(specs []kmcp.ContextSpec, activeSrc string) {
	fmt.Fprintf(os.Stderr, "kbot mcp: %d kbot context(s) registered from ~/.kbot:\n", len(specs))
	for _, c := range specs {
		marker := "  "
		if c.Current {
			marker = " *"
			if activeSrc == "env" {
				marker = " * (env)"
			}
		}
		version := c.Version
		if version == "" {
			version = "-"
		}
		game := c.Game
		if game == "" {
			game = "-"
		}
		fmt.Fprintf(os.Stderr, "%s %s\t%s\t%s\t%s\n", marker, c.Alias, game, version, c.Path)
	}
}
