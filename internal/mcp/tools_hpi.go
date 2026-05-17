package mcp

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/hpi"
)

// ── tool registration ─────────────────────────────────────────────────────

func registerHPITools(s *server.MCPServer, guard *PathGuard) {
	s.AddTool(
		mcplib.NewTool("hpi_list",
			mcplib.WithDescription(
				"List files inside an HPI/UFO/CCX archive. "+
					"Pass a glob pattern to filter (e.g. '*.fbi').",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the archive."),
			),
			mcplib.WithString("pattern",
				mcplib.Description("Optional glob to filter by base name (e.g. '*.cob')."),
			),
		),
		makeHPIListHandler(guard),
	)

	s.AddTool(
		mcplib.NewTool("hpi_info",
			mcplib.WithDescription(
				"Show header and content summary for an HPI/UFO/CCX archive: "+
					"version, file count, total uncompressed size, compression ratio.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the archive."),
			),
		),
		makeHPIInfoHandler(guard),
	)

	s.AddTool(
		mcplib.NewTool("hpi_extract_file",
			mcplib.WithDescription(
				"Extract a single file from an HPI/UFO/CCX archive and write it "+
					"to the given output path.  Returns the bytes written and the "+
					"resolved output path.  Both paths must lie inside the "+
					"configured mount roots when mounts are set.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the archive."),
			),
			mcplib.WithString("entry",
				mcplib.Required(),
				mcplib.Description("Path of the file inside the archive (e.g. 'units/ARMCOM.fbi')."),
			),
			mcplib.WithString("output",
				mcplib.Required(),
				mcplib.Description("Destination path on disk for the extracted file."),
			),
		),
		makeHPIExtractHandler(guard),
	)
}

// ── handlers ──────────────────────────────────────────────────────────────

type hpiEntryInfo struct {
	Path       string `json:"path"`
	Size       uint32 `json:"size"`
	Compressed bool   `json:"compressed"`
}

type hpiListOutput struct {
	Archive string         `json:"archive"`
	Total   int            `json:"total"`
	Matched int            `json:"matched"`
	Entries []hpiEntryInfo `json:"entries"`
}

func makeHPIListHandler(guard *PathGuard) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		resolved, err := guard.Resolve(path)
		if err != nil {
			return errorResult(err), nil
		}
		pattern := req.GetString("pattern", "")

		reader, err := hpi.OpenReader(resolved)
		if err != nil {
			return errorResult(fmt.Errorf("open archive: %w", err)), nil
		}
		defer func() { _ = reader.Close() }()

		all := reader.List()
		entries := make([]hpiEntryInfo, 0, len(all))
		for _, p := range all {
			if pattern != "" && !matchEntry(pattern, p) {
				continue
			}
			e := reader.Find(p)
			info := hpiEntryInfo{Path: p}
			if e != nil {
				info.Size = e.Size
				info.Compressed = e.CompType != 0
			}
			entries = append(entries, info)
		}

		return jsonResult(hpiListOutput{
			Archive: resolved,
			Total:   len(all),
			Matched: len(entries),
			Entries: entries,
		})
	}
}

type hpiInfoOutput struct {
	Archive          string `json:"archive"`
	FileSize         int64  `json:"file_size"`
	Version          uint32 `json:"version"`
	DirectorySize    uint32 `json:"directory_size"`
	DirectoryOffset  uint32 `json:"directory_offset"`
	DecryptKey       uint32 `json:"decrypt_key"`
	TotalFiles       int    `json:"total_files"`
	CompressedFiles  int    `json:"compressed_files"`
	UncompressedSize uint64 `json:"uncompressed_size"`
}

func makeHPIInfoHandler(guard *PathGuard) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		resolved, err := guard.Resolve(path)
		if err != nil {
			return errorResult(err), nil
		}

		stat, err := os.Stat(resolved)
		if err != nil {
			return errorResult(fmt.Errorf("stat archive: %w", err)), nil
		}

		reader, err := hpi.OpenReader(resolved)
		if err != nil {
			return errorResult(fmt.Errorf("open archive: %w", err)), nil
		}
		defer func() { _ = reader.Close() }()

		out := hpiInfoOutput{
			Archive:    resolved,
			FileSize:   stat.Size(),
			TotalFiles: len(reader.List()),
		}
		if h := reader.Header(); h != nil {
			out.Version = h.Version
			out.DirectorySize = h.DirectorySize
			out.DirectoryOffset = h.Offset
			out.DecryptKey = h.DecryptKey
		}
		if root := reader.Root(); root != nil {
			_ = root.Walk(func(e *hpi.Entry) error {
				if !e.IsDir {
					out.UncompressedSize += uint64(e.Size)
					if e.CompType != 0 {
						out.CompressedFiles++
					}
				}
				return nil
			})
		}

		return jsonResult(out)
	}
}

type hpiExtractOutput struct {
	Archive    string `json:"archive"`
	Entry      string `json:"entry"`
	Output     string `json:"output"`
	BytesWrote int64  `json:"bytes_written"`
}

func makeHPIExtractHandler(guard *PathGuard) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		entry, err := req.RequireString("entry")
		if err != nil {
			return errorResult(err), nil
		}
		output, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}

		resolvedArchive, err := guard.Resolve(path)
		if err != nil {
			return errorResult(err), nil
		}
		resolvedOutput, err := guard.Resolve(output)
		if err != nil {
			return errorResult(fmt.Errorf("output: %w", err)), nil
		}

		reader, err := hpi.OpenReader(resolvedArchive)
		if err != nil {
			return errorResult(fmt.Errorf("open archive: %w", err)), nil
		}
		defer func() { _ = reader.Close() }()

		rc, err := reader.Open(entry)
		if err != nil {
			return errorResult(fmt.Errorf("open entry: %w", err)), nil
		}
		defer func() { _ = rc.Close() }()

		if err := os.MkdirAll(filepath.Dir(resolvedOutput), 0o755); err != nil {
			return errorResult(fmt.Errorf("create output dir: %w", err)), nil
		}

		dst, err := os.Create(resolvedOutput)
		if err != nil {
			return errorResult(fmt.Errorf("create output: %w", err)), nil
		}
		defer func() { _ = dst.Close() }()

		n, err := io.Copy(dst, rc)
		if err != nil {
			return errorResult(fmt.Errorf("write output: %w", err)), nil
		}

		return jsonResult(hpiExtractOutput{
			Archive:    resolvedArchive,
			Entry:      entry,
			Output:     resolvedOutput,
			BytesWrote: n,
		})
	}
}

// matchEntry replicates the simple matcher used by `kbot hpi list`:
// '*' / '**/*' match everything, '*.ext' matches by suffix, and any
// other pattern is delegated to filepath.Match against the base name.
func matchEntry(pattern, path string) bool {
	if pattern == "*" || pattern == "**/*" {
		return true
	}
	if strings.HasPrefix(pattern, "*.") {
		return strings.HasSuffix(strings.ToLower(path), strings.ToLower(pattern[1:]))
	}
	matched, _ := filepath.Match(pattern, filepath.Base(path))
	return matched
}
