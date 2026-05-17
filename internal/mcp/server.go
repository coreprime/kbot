package mcp

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/server"
)

// Config configures a kbot MCP server.
type Config struct {
	// Version is reported to MCP clients during the handshake.
	Version string

	// MountRoots is an allow-list of filesystem roots that tools may
	// read from or write to.  When empty (and no GameData entries
	// either) the server runs in permissive mode (all absolute paths
	// allowed).
	MountRoots []string

	// GameData lists game-data folders to expose as named virtual
	// filesystems.  Each entry is either "PATH" or "NAME=PATH"; the
	// first entry becomes the default used when a tool call omits
	// game_data.  Game-data base paths are added implicitly to the
	// guard's mount roots so on-disk paths within them resolve too.
	GameData []string
}

// NewServer constructs a configured MCP server with every kbot tool
// registered.  Callers serve it with ServeStdio or ServeHTTP.
//
// The returned cleanup function must be called when the server stops to
// release any loaded game-data filesystems.  It is safe to call multiple
// times.
func NewServer(cfg Config) (*server.MCPServer, func() error, error) {
	registry := NewRegistry()
	for _, spec := range cfg.GameData {
		if spec == "" {
			continue
		}
		if _, err := registry.Add(spec); err != nil {
			_ = registry.Close()
			return nil, nil, err
		}
	}

	mounts := append([]string(nil), cfg.MountRoots...)
	for _, name := range registry.Names() {
		gd, _ := registry.Get(name)
		if gd != nil {
			mounts = append(mounts, gd.BasePath)
		}
	}

	guard, err := NewPathGuard(mounts)
	if err != nil {
		_ = registry.Close()
		return nil, nil, err
	}

	version := cfg.Version
	if version == "" {
		version = "dev"
	}

	s := server.NewMCPServer(
		"kbot",
		version,
		server.WithToolCapabilities(false),
		server.WithRecovery(),
	)

	resolver := NewResolver(guard, registry)

	registerCOBTools(s, resolver)
	registerHPITools(s, resolver)
	registerGAFTools(s, resolver)
	registerPCXTools(s, resolver)
	registerTDFTools(s, resolver)
	registerTNTTools(s, resolver)
	registerVFSTools(s, resolver)

	cleanup := func() error { return registry.Close() }
	return s, cleanup, nil
}

// ServeStdio runs the server over the stdio transport.  This is the
// canonical MCP transport for command-line tools launched by an AI
// assistant.  The function blocks until the connection ends.
//
// IMPORTANT: anything written to os.Stdout while this is running will
// corrupt the protocol.  Callers must keep stdout silent.
func ServeStdio(s *server.MCPServer) error {
	return server.ServeStdio(s)
}

// ServeHTTP runs the server over the streamable HTTP transport on the
// given listen address (e.g. ":8765" or "127.0.0.1:8765").  The
// function blocks until the HTTP server stops.
//
// The context is currently unused by the underlying transport but is
// reserved for future cancellation support.
func ServeHTTP(_ context.Context, s *server.MCPServer, addr string) error {
	if addr == "" {
		return fmt.Errorf("http address is required")
	}
	httpServer := server.NewStreamableHTTPServer(s)
	return httpServer.Start(addr)
}
