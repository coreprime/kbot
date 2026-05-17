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
	// read from or write to.  When empty the server runs in
	// permissive mode (all absolute paths allowed).
	MountRoots []string
}

// NewServer constructs a configured MCP server with every kbot tool
// registered.  Callers serve it with ServeStdio or ServeHTTP.
func NewServer(cfg Config) (*server.MCPServer, error) {
	guard, err := NewPathGuard(cfg.MountRoots)
	if err != nil {
		return nil, err
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

	registerCOBTools(s, guard)
	registerHPITools(s, guard)
	registerGAFTools(s, guard)
	registerPCXTools(s, guard)
	registerTDFTools(s, guard)

	return s, nil
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
