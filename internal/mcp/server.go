package mcp

import (
	"context"
	"fmt"

	"github.com/mark3labs/mcp-go/server"
)

// ContextSpec describes a kbot ctx entry to expose through the MCP
// server.  Contexts are richer than --game-data flags: they carry the
// game flavour and version label that kbot ctx tracks, and one entry
// may be marked Current so it becomes the registry default.
type ContextSpec struct {
	Alias   string
	Path    string
	Game    string
	Version string
	Current bool
}

// Config configures a kbot MCP server.
type Config struct {
	// Version is reported to MCP clients during the handshake.
	Version string

	// MountRoots is an allow-list of filesystem roots that tools may
	// read from or write to.  When empty (and no GameData / Contexts
	// entries either) the server runs in permissive mode (all absolute
	// paths allowed).
	MountRoots []string

	// GameData lists game-data folders to expose as named virtual
	// filesystems.  Each entry is either "PATH" or "NAME=PATH"; the
	// first entry becomes the default used when a tool call omits
	// game_data.  Game-data base paths are added implicitly to the
	// guard's mount roots so on-disk paths within them resolve too.
	GameData []string

	// Contexts lists kbot ctx entries to expose as named virtual
	// filesystems.  Registered alongside GameData; the Current entry is
	// inserted first so it becomes the registry default.  Use this
	// instead of GameData when you want the model to see the kbot ctx
	// metadata (game flavour, version) via the ctx_* tools.
	Contexts []ContextSpec
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
	// Insert current context first so Registry.Default() returns it.
	orderedContexts := orderContexts(cfg.Contexts)
	for _, c := range orderedContexts {
		if _, err := registry.AddNamed(c.Alias, c.Path,
			WithGame(c.Game),
			WithVersion(c.Version),
			WithSource("context"),
		); err != nil {
			_ = registry.Close()
			return nil, nil, fmt.Errorf("kbot context %q: %w", c.Alias, err)
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

	registerBIKTools(s, resolver)
	registerCOBTools(s, resolver)
	registerCtxTools(s, resolver)
	registerFNTTools(s, resolver)
	registerHPITools(s, resolver)
	registerGAFTools(s, resolver)
	registerPALTools(s, resolver)
	registerPCXTools(s, resolver)
	registerSCTTools(s, resolver)
	registerTAFTools(s, resolver)
	registerTDFTools(s, resolver)
	registerTNTTools(s, resolver)
	registerVFSTools(s, resolver)

	cleanup := func() error { return registry.Close() }
	return s, cleanup, nil
}

// orderContexts returns specs ordered so the Current entry is first.
// The remaining entries keep their input order so callers can choose a
// deterministic listing (e.g. alphabetical) when populating Contexts.
func orderContexts(specs []ContextSpec) []ContextSpec {
	if len(specs) == 0 {
		return nil
	}
	out := make([]ContextSpec, 0, len(specs))
	for _, c := range specs {
		if c.Current {
			out = append(out, c)
		}
	}
	for _, c := range specs {
		if !c.Current {
			out = append(out, c)
		}
	}
	return out
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
