package mcp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/assembly"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
	"github.com/coreprime/kbot/formats/scripting/linter"
)

// ── tool registration ─────────────────────────────────────────────────────

func registerCOBTools(s *server.MCPServer, guard *PathGuard) {
	s.AddTool(
		mcplib.NewTool("cob_decompile",
			mcplib.WithDescription(
				"Decompile a COB (Compiled Object Bytecode) file to BOS source. "+
					"Returns the reconstructed source text.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .cob file to decompile."),
			),
		),
		makeCobDecompileHandler(guard),
	)

	s.AddTool(
		mcplib.NewTool("cob_disassemble",
			mcplib.WithDescription(
				"Disassemble a COB file to a human-readable bytecode listing. "+
					"Pass annotated=true to include flow arrows and hex opcodes; "+
					"pass a script name to disassemble only that script.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .cob file."),
			),
			mcplib.WithString("script",
				mcplib.Description("Optional script name (e.g. 'Create'). When omitted, all scripts are disassembled."),
			),
			mcplib.WithBoolean("annotated",
				mcplib.Description("Annotated output with flow arrows and hex opcodes (default false)."),
			),
		),
		makeCobDisassembleHandler(guard),
	)

	s.AddTool(
		mcplib.NewTool("cob_lint",
			mcplib.WithDescription(
				"Run kbot's static analysis on a COB file or directory of COB files. "+
					"Returns structured diagnostics (rule, severity, script, line, message) "+
					"plus a per-rule summary count.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to a .cob file or a directory containing .cob files."),
			),
		),
		makeCobLintHandler(guard),
	)

	s.AddTool(
		mcplib.NewTool("cob_info",
			mcplib.WithDescription(
				"Summarise a COB file: version, script names, piece names and static var count. "+
					"Fast — does not decompile.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .cob file."),
			),
		),
		makeCobInfoHandler(guard),
	)
}

// ── handlers ──────────────────────────────────────────────────────────────

func makeCobDecompileHandler(guard *PathGuard) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		resolved, err := guard.Resolve(path)
		if err != nil {
			return errorResult(err), nil
		}

		cob, err := scripting.LoadFromFile(resolved)
		if err != nil {
			return errorResult(fmt.Errorf("parse cob: %w", err)), nil
		}

		out, err := decompiler.NewDecompiler(cob).Decompile()
		if err != nil {
			return errorResult(fmt.Errorf("decompile: %w", err)), nil
		}
		return mcplib.NewToolResultText(out), nil
	}
}

func makeCobDisassembleHandler(guard *PathGuard) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		resolved, err := guard.Resolve(path)
		if err != nil {
			return errorResult(err), nil
		}

		script := req.GetString("script", "")
		annotated := req.GetBool("annotated", false)

		cob, err := scripting.LoadFromFile(resolved)
		if err != nil {
			return errorResult(fmt.Errorf("parse cob: %w", err)), nil
		}

		format := assembly.Plain
		if annotated {
			format = assembly.Annotated
		}

		dec := decompiler.NewDecompiler(cob)
		var listing string
		if script != "" {
			listing, err = dec.DisassembleScript(script, format)
		} else {
			listing, err = dec.Disassemble(format)
		}
		if err != nil {
			return errorResult(fmt.Errorf("disassemble: %w", err)), nil
		}
		return mcplib.NewToolResultText(listing), nil
	}
}

// lintDiag is the JSON-friendly mirror of linter.Diagnostic.
type lintDiag struct {
	File     string `json:"file"`
	Rule     string `json:"rule"`
	Severity string `json:"severity"`
	Script   string `json:"script,omitempty"`
	Line     int    `json:"line,omitempty"`
	Message  string `json:"message"`
}

type lintOutput struct {
	Diagnostics []lintDiag     `json:"diagnostics"`
	Summary     map[string]int `json:"summary"`
	Files       int            `json:"files_linted"`
	HasErrors   bool           `json:"has_errors"`
}

func makeCobLintHandler(guard *PathGuard) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		resolved, err := guard.Resolve(path)
		if err != nil {
			return errorResult(err), nil
		}

		info, err := os.Stat(resolved)
		if err != nil {
			return errorResult(fmt.Errorf("stat %s: %w", resolved, err)), nil
		}

		var files []string
		switch {
		case info.IsDir():
			entries, err := os.ReadDir(resolved)
			if err != nil {
				return errorResult(fmt.Errorf("read dir: %w", err)), nil
			}
			for _, e := range entries {
				if !e.IsDir() && strings.EqualFold(filepath.Ext(e.Name()), ".cob") {
					files = append(files, filepath.Join(resolved, e.Name()))
				}
			}
			sort.Strings(files)
		default:
			files = []string{resolved}
		}

		if len(files) == 0 {
			return errorResult(fmt.Errorf("no .cob files found under %s", resolved)), nil
		}

		l := linter.New()
		out := lintOutput{
			Diagnostics: []lintDiag{},
			Summary:     map[string]int{},
		}

		for _, f := range files {
			cob, err := scripting.LoadFromFile(f)
			if err != nil {
				out.Diagnostics = append(out.Diagnostics, lintDiag{
					File:     f,
					Rule:     "parse-error",
					Severity: linter.Error.String(),
					Message:  err.Error(),
				})
				out.Summary["parse-error"]++
				out.HasErrors = true
				continue
			}

			diags := l.Lint(cob)
			out.Files++

			for _, d := range diags {
				out.Diagnostics = append(out.Diagnostics, lintDiag{
					File:     f,
					Rule:     d.Rule,
					Severity: d.Severity.String(),
					Script:   d.Script,
					Line:     d.Line,
					Message:  d.Message,
				})
				out.Summary[d.Rule]++
				if d.Severity == linter.Error {
					out.HasErrors = true
				}
			}
		}

		return jsonResult(out)
	}
}

type cobInfo struct {
	Path        string   `json:"path"`
	Version     uint32   `json:"version"`
	NumScripts  uint32   `json:"num_scripts"`
	NumPieces   uint32   `json:"num_pieces"`
	NumStatics  uint32   `json:"num_statics"`
	ScriptNames []string `json:"script_names"`
	PieceNames  []string `json:"piece_names"`
	CodeBytes   int      `json:"code_bytes"`
}

func makeCobInfoHandler(guard *PathGuard) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		resolved, err := guard.Resolve(path)
		if err != nil {
			return errorResult(err), nil
		}

		cob, err := scripting.LoadFromFile(resolved)
		if err != nil {
			return errorResult(fmt.Errorf("parse cob: %w", err)), nil
		}

		return jsonResult(cobInfo{
			Path:        resolved,
			Version:     cob.VersionSignature,
			NumScripts:  cob.NumScripts,
			NumPieces:   cob.NumPieces,
			NumStatics:  cob.Unknown1,
			ScriptNames: cob.ScriptNames,
			PieceNames:  cob.PieceNames,
			CodeBytes:   len(cob.Code),
		})
	}
}
