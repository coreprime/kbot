package mcp

import (
	"context"
	"fmt"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/assembly"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
	"github.com/coreprime/kbot/formats/scripting/linter"
)

// ── tool registration ─────────────────────────────────────────────────────

func registerCOBTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("cob_decompile",
			mcplib.WithDescription(
				"Decompile a COB (Compiled Object Bytecode) file to BOS source. "+
					"Returns the reconstructed source text. "+
					"Path may be absolute, virtual ('scripts/ARMCOM.cob'), or a bare filename to search the game-data VFS for.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .cob file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeCobDecompileHandler(r),
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
				mcplib.Description("Path to the .cob file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithString("script",
				mcplib.Description("Optional script name (e.g. 'Create'). When omitted, all scripts are disassembled."),
			),
			mcplib.WithBoolean("annotated",
				mcplib.Description("Annotated output with flow arrows and hex opcodes (default false)."),
			),
			withGameData(),
		),
		makeCobDisassembleHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("cob_lint",
			mcplib.WithDescription(
				"Run kbot's static analysis on a COB file or directory of COB files. "+
					"Returns structured diagnostics (rule, severity, script, line, message) "+
					"plus a per-rule summary count.  Path may also be a virtual directory inside the game-data VFS.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to a .cob file or a directory containing .cob files."),
			),
			withGameData(),
		),
		makeCobLintHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("cob_info",
			mcplib.WithDescription(
				"Summarise a COB file: version, script names, piece names and static var count. "+
					"Fast — does not decompile.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .cob file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeCobInfoHandler(r),
	)
}

// ── handlers ──────────────────────────────────────────────────────────────

func makeCobDecompileHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		rf, err := r.ResolveFile(path, req.GetString("game_data", ""))
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()

		cob, err := scripting.LoadFromFile(rf.LocalPath)
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

func makeCobDisassembleHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		rf, err := r.ResolveFile(path, req.GetString("game_data", ""))
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()

		script := req.GetString("script", "")
		annotated := req.GetBool("annotated", false)

		cob, err := scripting.LoadFromFile(rf.LocalPath)
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

func makeCobLintHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		gameData := req.GetString("game_data", "")

		// Try the path as a file first.  Lint accepts a directory too, so on
		// any "is a directory" / "no match" failure, fall back to ResolveDir.
		rf, err := r.ResolveFile(path, gameData)
		if err == nil {
			defer func() { _ = rf.Close() }()
			return runCobLint(map[string]string{rf.displayPath(): rf.LocalPath})
		}

		rd, derr := r.ResolveDir(path, gameData, []string{".cob"})
		if derr != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rd.Close() }()

		files := map[string]string{}
		for _, f := range rd.Files {
			files[f.displayPath()] = f.LocalPath
		}
		return runCobLint(files)
	}
}

func runCobLint(files map[string]string) (*mcplib.CallToolResult, error) {
	if len(files) == 0 {
		return errorResult(fmt.Errorf("no .cob files to lint")), nil
	}

	l := linter.New()
	out := lintOutput{
		Diagnostics: []lintDiag{},
		Summary:     map[string]int{},
	}

	for display, local := range files {
		cob, err := scripting.LoadFromFile(local)
		if err != nil {
			out.Diagnostics = append(out.Diagnostics, lintDiag{
				File:     display,
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
				File:     display,
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

type cobInfo struct {
	Path        string   `json:"path"`
	Source      string   `json:"source,omitempty"`
	Version     uint32   `json:"version"`
	NumScripts  uint32   `json:"num_scripts"`
	NumPieces   uint32   `json:"num_pieces"`
	NumStatics  uint32   `json:"num_statics"`
	ScriptNames []string `json:"script_names"`
	PieceNames  []string `json:"piece_names"`
	CodeBytes   int      `json:"code_bytes"`
}

func makeCobInfoHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		rf, err := r.ResolveFile(path, req.GetString("game_data", ""))
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()

		cob, err := scripting.LoadFromFile(rf.LocalPath)
		if err != nil {
			return errorResult(fmt.Errorf("parse cob: %w", err)), nil
		}

		return jsonResult(cobInfo{
			Path:        rf.displayPath(),
			Source:      rf.Source,
			Version:     cob.VersionSignature,
			NumScripts:  cob.NumScripts,
			NumPieces:   cob.NumPieces,
			NumStatics:  cob.NumberOfStaticVars,
			ScriptNames: cob.ScriptNames,
			PieceNames:  cob.PieceNames,
			CodeBytes:   len(cob.Code),
		})
	}
}
