package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/internal/gameserver"
	"github.com/spf13/cobra"
)

func newHostCommand() *cobra.Command {
	var (
		addr       string
		root       string
		seed       uint32
		inputDelay uint64
	)
	cmd := &cobra.Command{
		Use:   "host",
		Short: "Run the authoritative multiplayer game server",
		Long: `host runs the authoritative simulation server. Clients connect over a
websocket at /ws (optionally ?match=<id>); each match runs its own fixed-rate
tick loop and relays command frames, snapshots and state hashes so connected
clients can predict locally and reconcile against authority.

Units are resolved from a flattened game-asset tree (the unpacked HPI layout
with units/*.fbi and weapons/*.tdf) given by --root. When --root is omitted the
server runs with a single built-in synthetic unit ("scout"), which is enough to
exercise the lockstep netcode from the browser demo with no TA install.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var spawn sim.SpawnFunc
			if root == "" {
				spawn = gameserver.DemoSpawnFunc()
				_, _ = fmt.Fprintln(cmd.OutOrStdout(), "no --root given: serving the built-in demo unit set")
			} else {
				if _, err := os.Stat(root); err != nil {
					return fmt.Errorf("asset root: %w", err)
				}
				spawn = gameserver.FBISpawnFunc(root)
			}
			srv := gameserver.NewServer(spawn, seed, inputDelay)
			defer srv.Stop()

			mux := http.NewServeMux()
			mux.Handle("/ws", srv)
			httpSrv := &http.Server{Addr: addr, Handler: mux}

			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()

			errc := make(chan error, 1)
			go func() { errc <- httpSrv.ListenAndServe() }()
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "kbot host listening on %s (ws /ws)\n", addr)

			select {
			case <-ctx.Done():
				shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				return httpSrv.Shutdown(shutCtx)
			case err := <-errc:
				if err == http.ErrServerClosed {
					return nil
				}
				return err
			}
		},
	}
	cmd.Flags().StringVar(&addr, "addr", ":8080", "listen address")
	cmd.Flags().StringVar(&root, "root", "", "flattened TA asset tree (units/*.fbi, weapons/*.tdf)")
	cmd.Flags().Uint32Var(&seed, "seed", 1, "world RNG seed for new matches")
	cmd.Flags().Uint64Var(&inputDelay, "input-delay", 3, "ticks of input delay applied to orders")
	return cmd
}
