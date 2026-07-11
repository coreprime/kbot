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

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/palettes"
	"github.com/coreprime/kbot/internal/palettepick"
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
					"Output paths are anchored to the game-data folder when relative. "+
					"When 'palette' is omitted, kbot auto-detects a palette from the "+
					"game-data VFS (TA: Kingdoms ships per-asset palettes); pass an "+
					"explicit VFS path to override.",
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
			mcplib.WithString("palette",
				mcplib.Description(
					"Optional VFS path to a .pal or .pcx palette inside game-data. "+
						"Omit to auto-detect (same-name .pcx sidecar > side palette > global palette.pal).",
				),
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
	Path          string `json:"path"`
	Source        string `json:"source,omitempty"`
	Sequence      int    `json:"sequence"`
	Name          string `json:"name"`
	Frames        int    `json:"frames"`
	Output        string `json:"output"`
	Format        string `json:"format"`
	Palette       string `json:"palette,omitempty"`
	PaletteSource string `json:"palette_source,omitempty"`
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
		paletteOverride := req.GetString("palette", "")

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

		// Resolve palette via the game-data VFS when available; without a
		// game-data context (raw --mount mode), fall back to the embedded
		// palette so behavior matches the historical default.
		palette, paletteRes, err := resolveMCPGAFPalette(r, gameData, rf.VirtualPath, paletteOverride)
		if err != nil {
			return errorResult(err), nil
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
			Path:          rf.displayPath(),
			Source:        rf.Source,
			Sequence:      sequence,
			Name:          seq.Name,
			Frames:        len(seq.Frames),
			Output:        resolvedOut,
			Format:        format,
			Palette:       paletteRes.Path,
			PaletteSource: string(paletteRes.Source),
		})
	}
}

// resolveMCPGAFPalette picks the rendering palette for an MCP gaf_export call.
// When the call is anchored to a game-data folder, the resolver runs against
// that VFS so per-asset palettes resolve correctly; otherwise the embedded TA
// palette is used to preserve historical behavior.
func resolveMCPGAFPalette(r *Resolver, gameData, gafVirtualPath, override string) (*gaf.Palette, palettepick.Result, error) {
	gd, err := r.registry.Get(gameData)
	if err != nil || gd == nil {
		// No game-data registered: stick with embedded.
		if override != "" {
			return nil, palettepick.Result{}, fmt.Errorf("palette override %q requires a game-data folder", override)
		}
		pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
		if err != nil {
			return nil, palettepick.Result{}, fmt.Errorf("load embedded palette: %w", err)
		}
		return pal, palettepick.Result{Palette: pal, Source: palettepick.SourceEmbedded, Label: "embedded TA palette"}, nil
	}
	v, err := gd.VFS()
	if err != nil {
		return nil, palettepick.Result{}, fmt.Errorf("open game-data vfs: %w", err)
	}
	res, err := palettepick.Resolve(v, gafVirtualPath, override)
	if err != nil {
		return nil, palettepick.Result{}, err
	}
	return res.Palette, res, nil
}
