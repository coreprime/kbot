package mcp

import (
	"context"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// registerCtxTools exposes read-only views over the kbot ctx
// registrations the server was launched with.  Mutating the on-disk
// kbot config from inside the MCP server is intentionally not
// supported — long-running servers should not rewrite ~/.kbot behind
// the user's back.
func registerCtxTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("ctx_list",
			mcplib.WithDescription(
				"List the kbot ctx workspaces this server was launched with. "+
					"Each entry reports the alias, on-disk path, game flavour "+
					"(totala, takingdoms, custom), optional version label, and "+
					"whether it is the default (the entry tool calls fall back "+
					"to when game_data is omitted).  Folders registered via "+
					"--game-data appear too, but without game/version metadata.",
			),
		),
		makeCtxListHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("ctx_current",
			mcplib.WithDescription(
				"Report the active (default) kbot ctx workspace — the one "+
					"tool calls resolve against when game_data is omitted.  "+
					"Returns the alias, path, game flavour, and version.",
			),
		),
		makeCtxCurrentHandler(r),
	)
}

// ── ctx_list ──────────────────────────────────────────────────────────────

type ctxListEntry struct {
	Alias    string `json:"alias"`
	Path     string `json:"path"`
	Game     string `json:"game,omitempty"`
	Version  string `json:"version,omitempty"`
	Source   string `json:"source,omitempty"`
	Current  bool   `json:"current"`
}

type ctxListOutput struct {
	Count    int            `json:"count"`
	Current  string         `json:"current,omitempty"`
	Contexts []ctxListEntry `json:"contexts"`
}

func makeCtxListHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, _ mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		names := r.Registry().Names()
		out := ctxListOutput{Count: len(names)}
		for i, name := range names {
			gd, _ := r.Registry().Get(name)
			if gd == nil {
				continue
			}
			entry := ctxListEntry{
				Alias:   gd.Name,
				Path:    gd.BasePath,
				Game:    gd.Game,
				Version: gd.Version,
				Source:  gd.Source,
				Current: i == 0,
			}
			if entry.Current {
				out.Current = entry.Alias
			}
			out.Contexts = append(out.Contexts, entry)
		}
		return jsonResult(out)
	}
}

// ── ctx_current ───────────────────────────────────────────────────────────

type ctxCurrentOutput struct {
	Alias   string `json:"alias,omitempty"`
	Path    string `json:"path,omitempty"`
	Game    string `json:"game,omitempty"`
	Version string `json:"version,omitempty"`
	Source  string `json:"source,omitempty"`
	None    bool   `json:"none,omitempty"`
}

func makeCtxCurrentHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, _ mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		gd := r.Registry().Default()
		if gd == nil {
			return jsonResult(ctxCurrentOutput{None: true})
		}
		return jsonResult(ctxCurrentOutput{
			Alias:   gd.Name,
			Path:    gd.BasePath,
			Game:    gd.Game,
			Version: gd.Version,
			Source:  gd.Source,
		})
	}
}

