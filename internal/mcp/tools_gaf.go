package mcp

import (
	"context"
	"fmt"
	"image/gif"
	"os"
	"path/filepath"
	"strings"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/internal/assets"
)

func registerGAFTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("gaf_list",
			mcplib.WithDescription(
				"List sequences in a GAF (Graphics Animation Format) file. "+
					"Each sequence reports its name, frame count and total duration.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .gaf file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeGAFListHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("gaf_export",
			mcplib.WithDescription(
				"Export one sequence from a GAF file as an animated GIF or APNG. "+
					"Output paths are anchored to the game-data folder when relative.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .gaf file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithNumber("sequence",
				mcplib.Description("Sequence index to export (default 0)."),
			),
			mcplib.WithString("format",
				mcplib.Description("Output format: 'gif' (default) or 'png' (APNG)."),
			),
			mcplib.WithString("output",
				mcplib.Required(),
				mcplib.Description("Destination path for the rendered image."),
			),
			withGameData(),
		),
		makeGAFExportHandler(r),
	)
}

type gafSeqInfo struct {
	Index         int     `json:"index"`
	Name          string  `json:"name"`
	Frames        int     `json:"frames"`
	DurationTicks uint32  `json:"duration_ticks"`
	DurationSecs  float64 `json:"duration_seconds"`
}

type gafListOutput struct {
	Path      string       `json:"path"`
	Source    string       `json:"source,omitempty"`
	Version   uint32       `json:"version"`
	Total     int          `json:"total_sequences"`
	Sequences []gafSeqInfo `json:"sequences"`
}

func makeGAFListHandler(r *Resolver) server.ToolHandlerFunc {
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

		reader, err := gaf.LoadFromFile(rf.LocalPath)
		if err != nil {
			return errorResult(fmt.Errorf("parse gaf: %w", err)), nil
		}
		defer func() { _ = reader.Close() }()

		seqs, err := reader.ReadSequences()
		if err != nil {
			return errorResult(fmt.Errorf("read sequences: %w", err)), nil
		}

		out := gafListOutput{
			Path:      rf.displayPath(),
			Source:    rf.Source,
			Version:   reader.Header().Version,
			Total:     len(seqs),
			Sequences: make([]gafSeqInfo, 0, len(seqs)),
		}
		for i, seq := range seqs {
			var ticks uint32
			for _, f := range seq.Frames {
				ticks += f.Duration
			}
			out.Sequences = append(out.Sequences, gafSeqInfo{
				Index:         i,
				Name:          seq.Name,
				Frames:        len(seq.Frames),
				DurationTicks: ticks,
				DurationSecs:  float64(ticks) / 30.0,
			})
		}
		return jsonResult(out)
	}
}

type gafExportOutput struct {
	Path     string `json:"path"`
	Source   string `json:"source,omitempty"`
	Sequence int    `json:"sequence"`
	Name     string `json:"name"`
	Frames   int    `json:"frames"`
	Output   string `json:"output"`
	Format   string `json:"format"`
}

func makeGAFExportHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		output, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		sequence := int(req.GetFloat("sequence", 0))
		format := strings.ToLower(req.GetString("format", "gif"))
		if format != "gif" && format != "png" {
			return errorResult(fmt.Errorf("format must be gif or png, got %q", format)), nil
		}
		gameData := req.GetString("game_data", "")

		rf, err := r.ResolveFile(path, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()

		resolvedOut, err := r.ResolveOutput(output, gameData)
		if err != nil {
			return errorResult(fmt.Errorf("output: %w", err)), nil
		}

		reader, err := gaf.LoadFromFile(rf.LocalPath)
		if err != nil {
			return errorResult(fmt.Errorf("parse gaf: %w", err)), nil
		}
		defer func() { _ = reader.Close() }()

		seqs, err := reader.ReadSequences()
		if err != nil {
			return errorResult(fmt.Errorf("read sequences: %w", err)), nil
		}
		if sequence < 0 || sequence >= len(seqs) {
			return errorResult(fmt.Errorf("sequence %d out of range (0..%d)", sequence, len(seqs)-1)), nil
		}

		palette, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
		if err != nil {
			return errorResult(fmt.Errorf("load palette: %w", err)), nil
		}

		if err := os.MkdirAll(filepath.Dir(resolvedOut), 0o755); err != nil {
			return errorResult(fmt.Errorf("create output dir: %w", err)), nil
		}
		dst, err := os.Create(resolvedOut)
		if err != nil {
			return errorResult(fmt.Errorf("create output: %w", err)), nil
		}
		defer func() { _ = dst.Close() }()

		seq := seqs[sequence]
		switch format {
		case "gif":
			g, gerr := seq.ToGIF(palette)
			if gerr != nil {
				return errorResult(fmt.Errorf("gif conversion: %w", gerr)), nil
			}
			if gerr := gif.EncodeAll(dst, g); gerr != nil {
				return errorResult(fmt.Errorf("gif encode: %w", gerr)), nil
			}
		case "png":
			if perr := seq.ToAPNG(palette, dst); perr != nil {
				return errorResult(fmt.Errorf("apng conversion: %w", perr)), nil
			}
		}

		return jsonResult(gafExportOutput{
			Path:     rf.displayPath(),
			Source:   rf.Source,
			Sequence: sequence,
			Name:     seq.Name,
			Frames:   len(seq.Frames),
			Output:   resolvedOut,
			Format:   format,
		})
	}
}
