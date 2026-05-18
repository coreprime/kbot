package main

import (
	"context"
	"fmt"
	"os"

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

  If no --game-data flag is passed, kbot falls back to the active kbot
  context (see 'kbot ctx').  Set KBOT_CONTEXT=<alias> to pick a
  different registered context for this invocation.

Examples:
  kbot mcp --mount ~/games/totala
  kbot mcp --game-data ~/games/totala
  kbot mcp --game-data totala=~/games/totala --game-data kingdoms=~/games/tak
  kbot mcp --http 127.0.0.1:8765 --game-data ~/games/totala`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			resolvedGameData := gameData
			if len(resolvedGameData) == 0 && len(mounts) == 0 {
				cfg, err := kbotctx.Load()
				if err != nil {
					return err
				}
				if alias, ctxEntry, src, ok := cfg.Active(); ok {
					resolvedGameData = []string{fmt.Sprintf("%s=%s", alias, ctxEntry.Path)}
					srcLabel := "kbot context"
					if src == "env" {
						srcLabel = fmt.Sprintf("kbot context via %s", kbotctx.EnvVar)
					}
					fmt.Fprintf(os.Stderr, "kbot mcp: using %s %q (%s)\n", srcLabel, alias, ctxEntry.Path)
				} else if alias != "" && src == "env" {
					return fmt.Errorf("%s=%s names an unknown kbot context (run `kbot ctx list`)", kbotctx.EnvVar, alias)
				}
			}

			srv, cleanup, err := kmcp.NewServer(kmcp.Config{
				Version:    Version,
				MountRoots: mounts,
				GameData:   resolvedGameData,
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
			if len(resolvedGameData) > 0 {
				fmt.Fprintf(os.Stderr, "kbot mcp: %d game-data folder(s) configured\n", len(resolvedGameData))
			}
			if len(mounts) == 0 && len(resolvedGameData) == 0 {
				fmt.Fprintln(os.Stderr, "kbot mcp: running in permissive mode — no mounts or game-data configured")
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
