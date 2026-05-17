package main

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	kmcp "github.com/coreprime/kbot/internal/mcp"
)

func newMCPCommand() *cobra.Command {
	var (
		httpAddr string
		mounts   []string
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
  configured, the server runs in permissive mode and all absolute paths
  are accepted — useful for local development, risky for shared hosts.

Examples:
  kbot mcp --mount ~/games/totala
  kbot mcp --mount ~/games/totala --mount /tmp/kbot-out
  kbot mcp --http 127.0.0.1:8765 --mount ~/games/totala`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			srv, err := kmcp.NewServer(kmcp.Config{
				Version:    Version,
				MountRoots: mounts,
			})
			if err != nil {
				return fmt.Errorf("init mcp server: %w", err)
			}

			// All status output goes to stderr so the stdio transport
			// (which uses stdout for JSON-RPC framing) stays clean.
			if len(mounts) > 0 {
				fmt.Fprintf(os.Stderr, "kbot mcp: %d mount root(s) configured\n", len(mounts))
			} else {
				fmt.Fprintln(os.Stderr, "kbot mcp: running in permissive mode — no mount roots configured")
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

	return cmd
}
