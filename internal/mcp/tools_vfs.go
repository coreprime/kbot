package mcp

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// registerVFSTools exposes the game-data introspection tools the model uses
// to answer "where is ARMCOM.bos" and similar questions.
func registerVFSTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("vfs_game_data",
			mcplib.WithDescription(
				"List the game-data folders this server knows about.  The first "+
					"entry is the default used when a tool call omits game_data.  "+
					"Each entry reports its name, base path, archive count and "+
					"total file count (loading the VFS on first call may take a "+
					"few seconds on a full install).",
			),
		),
		makeVFSGameDataHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("vfs_find",
			mcplib.WithDescription(
				"Locate Total Annihilation / TA: Kingdoms files inside a game-data "+
					"folder.  Pass a bare filename ('ARMCOM.bos'), a glob over the "+
					"full virtual path ('units/ARMCOM.*'), or a basename glob ('*.bos').  "+
					"Returns every matching file with its virtual path and the source "+
					"archive (or 'disk' / 'archive' for top-level files).",
			),
			mcplib.WithString("query",
				mcplib.Required(),
				mcplib.Description("Filename or glob to search for."),
			),
			mcplib.WithString("game_data",
				mcplib.Description("Game-data folder name to search.  Defaults to the first --game-data folder."),
			),
			mcplib.WithNumber("limit",
				mcplib.Description("Maximum number of hits to return (default 50, max 1000)."),
			),
		),
		makeVFSFindHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("vfs_list",
			mcplib.WithDescription(
				"List virtual files and subdirectories under a directory in a "+
					"game-data folder.  Pass an empty path or '/' to list the root.",
			),
			mcplib.WithString("path",
				mcplib.Description("Virtual directory path (e.g. 'units').  Empty for root."),
			),
			mcplib.WithString("game_data",
				mcplib.Description("Game-data folder name.  Defaults to the first --game-data folder."),
			),
		),
		makeVFSListHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("vfs_stat",
			mcplib.WithDescription(
				"Look up a single file in a game-data folder and report its source "+
					"layer (which archive provides the active version) along with "+
					"every layer that contains it.  Useful when you need to know "+
					"whether a mod has overridden a base-game file.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Virtual path or bare filename to inspect."),
			),
			mcplib.WithString("game_data",
				mcplib.Description("Game-data folder name.  Defaults to the first --game-data folder."),
			),
		),
		makeVFSStatHandler(r),
	)
}

// ── vfs_game_data ─────────────────────────────────────────────────────────

type gameDataEntry struct {
	Name      string `json:"name"`
	BasePath  string `json:"base_path"`
	IsDefault bool   `json:"is_default"`
	Archives  int    `json:"archives,omitempty"`
	Files     int    `json:"files,omitempty"`
	Loaded    bool   `json:"loaded"`
	LoadError string `json:"load_error,omitempty"`
}

type gameDataOutput struct {
	GameData []gameDataEntry `json:"game_data"`
	Count    int             `json:"count"`
}

func makeVFSGameDataHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, _ mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		names := r.Registry().Names()
		out := gameDataOutput{Count: len(names)}
		for i, name := range names {
			gd, _ := r.Registry().Get(name)
			if gd == nil {
				continue
			}
			entry := gameDataEntry{
				Name:      gd.Name,
				BasePath:  gd.BasePath,
				IsDefault: i == 0,
			}
			if vfs, err := gd.VFS(); err == nil {
				entry.Loaded = true
				entry.Archives = len(vfs.Archives())
				entry.Files = len(vfs.List())
			} else {
				entry.LoadError = err.Error()
			}
			out.GameData = append(out.GameData, entry)
		}
		return jsonResult(out)
	}
}

// ── vfs_find ──────────────────────────────────────────────────────────────

type vfsFindHit struct {
	VirtualPath string `json:"virtual_path,omitempty"`
	DiskPath    string `json:"disk_path,omitempty"`
	Source      string `json:"source"`
	GameData    string `json:"game_data"`
}

type vfsFindOutput struct {
	Query    string       `json:"query"`
	GameData string       `json:"game_data"`
	Total    int          `json:"total"`
	Returned int          `json:"returned"`
	Hits     []vfsFindHit `json:"hits"`
}

func makeVFSFindHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		query, err := req.RequireString("query")
		if err != nil {
			return errorResult(err), nil
		}
		gameData := req.GetString("game_data", "")
		limit := int(req.GetFloat("limit", 50))
		if limit <= 0 {
			limit = 50
		}
		if limit > 1000 {
			limit = 1000
		}

		gd, err := r.Registry().Get(gameData)
		if err != nil {
			return errorResult(err), nil
		}
		if gd == nil {
			return errorResult(fmt.Errorf("no game-data folder configured (pass --game-data on launch)")), nil
		}

		hits, err := findInGameData(gd, query)
		if err != nil {
			return errorResult(err), nil
		}

		out := vfsFindOutput{
			Query:    query,
			GameData: gd.Name,
			Total:    len(hits),
		}
		if len(hits) > limit {
			hits = hits[:limit]
		}
		out.Returned = len(hits)
		for _, h := range hits {
			out.Hits = append(out.Hits, vfsFindHit{
				VirtualPath: h.VirtualPath,
				DiskPath:    h.DiskPath,
				Source:      h.Source,
				GameData:    gd.Name,
			})
		}
		return jsonResult(out)
	}
}

// findInGameData picks the right GameData search for a query — basename when
// the query has no glob metacharacters or path separators, otherwise glob.
func findInGameData(gd *GameData, query string) ([]Hit, error) {
	if !strings.ContainsAny(query, "*?[") && !strings.ContainsAny(query, "/\\") {
		return gd.FindByBasename(query)
	}
	return gd.FindByPattern(query)
}

// ── vfs_list ──────────────────────────────────────────────────────────────

type vfsListEntry struct {
	Name   string `json:"name"`
	IsDir  bool   `json:"is_dir"`
	Size   int64  `json:"size,omitempty"`
	Source string `json:"source,omitempty"`
}

type vfsListOutput struct {
	GameData string         `json:"game_data"`
	Path     string         `json:"path"`
	Count    int            `json:"count"`
	Entries  []vfsListEntry `json:"entries"`
}

func makeVFSListHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path := req.GetString("path", "")
		path = strings.Trim(filepath.ToSlash(path), "/")
		gameData := req.GetString("game_data", "")

		gd, err := r.Registry().Get(gameData)
		if err != nil {
			return errorResult(err), nil
		}
		if gd == nil {
			return errorResult(fmt.Errorf("no game-data folder configured (pass --game-data on launch)")), nil
		}

		vfs, err := gd.VFS()
		if err != nil {
			return errorResult(err), nil
		}

		names, err := vfs.ListDir(path)
		if err != nil {
			return errorResult(err), nil
		}
		sort.Strings(names)

		out := vfsListOutput{
			GameData: gd.Name,
			Path:     path,
			Count:    len(names),
		}
		for _, name := range names {
			full := name
			if path != "" {
				full = path + "/" + name
			}
			entry := vfsListEntry{Name: name}
			if info, statErr := vfs.Stat(full); statErr == nil {
				entry.IsDir = info.IsDir
				entry.Size = info.Size
				entry.Source = info.Source
			}
			out.Entries = append(out.Entries, entry)
		}
		return jsonResult(out)
	}
}

// ── vfs_stat ──────────────────────────────────────────────────────────────

type vfsStatLayer struct {
	Source   string `json:"source"`
	Priority int    `json:"priority"`
	Size     int64  `json:"size"`
}

type vfsStatOutput struct {
	GameData      string         `json:"game_data"`
	Query         string         `json:"query"`
	VirtualPath   string         `json:"virtual_path"`
	ActiveSource  string         `json:"active_source"`
	Size          int64          `json:"size"`
	Layers        []vfsStatLayer `json:"layers"`
	MultipleHits  []vfsFindHit   `json:"multiple_hits,omitempty"`
	NotFound      bool           `json:"not_found,omitempty"`
}

func makeVFSStatHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		query, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		gameData := req.GetString("game_data", "")

		gd, err := r.Registry().Get(gameData)
		if err != nil {
			return errorResult(err), nil
		}
		if gd == nil {
			return errorResult(fmt.Errorf("no game-data folder configured (pass --game-data on launch)")), nil
		}

		vfs, err := gd.VFS()
		if err != nil {
			return errorResult(err), nil
		}

		out := vfsStatOutput{GameData: gd.Name, Query: query}

		// Direct hit first.
		if vfs.Exists(query) && !vfs.IsDir(query) {
			info, _ := vfs.Stat(query)
			out.VirtualPath = query
			if info != nil {
				out.ActiveSource = info.Source
				out.Size = info.Size
			}
			for _, l := range vfs.GetFileLayers(query) {
				out.Layers = append(out.Layers, vfsStatLayer{
					Source:   l.Source,
					Priority: l.Priority,
					Size:     l.Size,
				})
			}
			return jsonResult(out)
		}

		// Fall back to basename search.
		if !strings.ContainsAny(query, "/\\") {
			hits, err := gd.FindByBasename(query)
			if err != nil {
				return errorResult(err), nil
			}
			switch len(hits) {
			case 0:
				out.NotFound = true
				return jsonResult(out)
			case 1:
				h := hits[0]
				if h.VirtualPath != "" {
					info, _ := vfs.Stat(h.VirtualPath)
					out.VirtualPath = h.VirtualPath
					if info != nil {
						out.ActiveSource = info.Source
						out.Size = info.Size
					}
					for _, l := range vfs.GetFileLayers(h.VirtualPath) {
						out.Layers = append(out.Layers, vfsStatLayer{
							Source:   l.Source,
							Priority: l.Priority,
							Size:     l.Size,
						})
					}
				} else {
					out.ActiveSource = h.Source
				}
				return jsonResult(out)
			default:
				for _, h := range hits {
					out.MultipleHits = append(out.MultipleHits, vfsFindHit{
						VirtualPath: h.VirtualPath,
						DiskPath:    h.DiskPath,
						Source:      h.Source,
						GameData:    gd.Name,
					})
				}
				return jsonResult(out)
			}
		}

		out.NotFound = true
		return jsonResult(out)
	}
}
