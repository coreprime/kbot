package mcp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot-io/formats/pal"
	"github.com/coreprime/kbot-io/palettes"
)

// embeddedTAPalette loads the embedded Cavedog TA palette as a *pal.Palette.
// Used by every render handler that needs a default palette when the caller
// doesn't supply one.
func embeddedTAPalette() (*pal.Palette, error) {
	p, err := pal.LoadFromBytes(palettes.DefaultPalette)
	if err != nil {
		return nil, fmt.Errorf("load embedded TA palette: %w", err)
	}
	return p, nil
}

func registerPALTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("pal_describe",
			mcplib.WithDescription(
				"Inspect a TA .PAL palette: file size, unique RGB count, duplicate count "+
					"and whether the unused alpha byte is zero (the Cavedog convention).",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .pal file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithBoolean("list_entries",
				mcplib.Description("If true, include all 256 palette entries in the response (default false)."),
			),
			withGameData(),
		),
		makePALDescribeHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("pal_swatch",
			mcplib.WithDescription(
				"Render a TA palette as a 16x16 PNG swatch grid.  Index 0 (the transparent "+
					"sentinel) is drawn with a magenta hatch so it is visible next to the "+
					"other entries.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .pal file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			mcplib.WithNumber("cell", mcplib.Description("Pixel size of each color cell (default 16).")),
			withGameData(),
		),
		makePALSwatchHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("pal_convert",
			mcplib.WithDescription(
				"Convert a TA .PAL to an editor-friendly format: 'jasc' (Paint Shop Pro / "+
					"GIMP plain text), 'gpl' (GIMP Palette), or 'pal' (binary TA .PAL — useful "+
					"after RGB edits to re-emit the file).  Format is inferred from the output "+
					"extension when omitted (.gpl -> gpl, .pal/.txt -> jasc).",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .pal file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination path.")),
			mcplib.WithString("format", mcplib.Description("Output format: jasc, gpl, pal.")),
			mcplib.WithString("name", mcplib.Description("Palette name (gpl only, default 'TA Palette').")),
			withGameData(),
		),
		makePALConvertHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("pal_lookup",
			mcplib.WithDescription(
				"Render a 1024-byte TA color-index lookup table (.ALP, .LHT, .SHD) as a "+
					"256x4 PNG swatch.  Each byte indexes into --palette (defaults to the "+
					"embedded TA palette) for display.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .alp/.lht/.shd file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			mcplib.WithString("palette", mcplib.Description("Optional .pal file to use for index→RGB mapping.")),
			mcplib.WithNumber("cell", mcplib.Description("Pixel size of each cell (default 4).")),
			withGameData(),
		),
		makePALLookupHandler(r),
	)
}

type palDescribeEntry struct {
	Index int    `json:"index"`
	Hex   string `json:"hex"`
	R     uint8  `json:"r"`
	G     uint8  `json:"g"`
	B     uint8  `json:"b"`
}

type palDescribeOutput struct {
	Path       string             `json:"path"`
	Source     string             `json:"source,omitempty"`
	FileSize   int64              `json:"file_size"`
	Entries    int                `json:"entries"`
	UniqueRGB  int                `json:"unique_rgb"`
	Duplicates int                `json:"duplicates"`
	TAStyle    bool               `json:"ta_style"`
	Colors     []palDescribeEntry `json:"colors,omitempty"`
}

type palImageOutput struct {
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	Output string `json:"output"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type palConvertOutput struct {
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	Output string `json:"output"`
	Format string `json:"format"`
}

func makePALDescribeHandler(r *Resolver) server.ToolHandlerFunc {
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

		info, statErr := os.Stat(rf.LocalPath)
		p, err := pal.LoadFromFile(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		unique, dups := p.Histogram()

		out := palDescribeOutput{
			Path:       rf.displayPath(),
			Source:     rf.Source,
			Entries:    pal.EntryCount,
			UniqueRGB:  unique,
			Duplicates: dups,
			TAStyle:    p.IsLikelyTAPalette(),
		}
		if statErr == nil {
			out.FileSize = info.Size()
		}
		if req.GetBool("list_entries", false) {
			out.Colors = make([]palDescribeEntry, pal.EntryCount)
			for i := 0; i < pal.EntryCount; i++ {
				c := p.Colors[i]
				out.Colors[i] = palDescribeEntry{
					Index: i,
					Hex:   fmt.Sprintf("#%02X%02X%02X", c.R, c.G, c.B),
					R:     c.R, G: c.G, B: c.B,
				}
			}
		}
		return jsonResult(out)
	}
}

func makePALSwatchHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		output, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		gameData := req.GetString("game_data", "")
		rf, err := r.ResolveFile(path, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()
		outPath, err := r.ResolveOutput(output, gameData)
		if err != nil {
			return errorResult(err), nil
		}

		p, err := pal.LoadFromFile(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		cell := int(req.GetFloat("cell", 16))
		img := p.RenderSwatch(cell)
		if err := writeRenderedPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(palImageOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: outPath,
			Width:  img.Bounds().Dx(),
			Height: img.Bounds().Dy(),
		})
	}
}

func makePALConvertHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		output, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		format := strings.ToLower(req.GetString("format", ""))
		if format == "" {
			switch strings.ToLower(filepath.Ext(output)) {
			case ".gpl":
				format = "gpl"
			case ".pal", ".txt", ".jasc":
				format = "jasc"
			default:
				return errorResult(fmt.Errorf("format not specified and not inferrable from output extension")), nil
			}
		}

		gameData := req.GetString("game_data", "")
		rf, err := r.ResolveFile(path, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()
		outPath, err := r.ResolveOutput(output, gameData)
		if err != nil {
			return errorResult(err), nil
		}

		p, err := pal.LoadFromFile(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			return errorResult(fmt.Errorf("create output dir: %w", err)), nil
		}
		f, err := os.Create(outPath)
		if err != nil {
			return errorResult(fmt.Errorf("create output: %w", err)), nil
		}
		defer func() { _ = f.Close() }()

		switch format {
		case "jasc":
			err = p.WriteJASC(f)
		case "gpl":
			err = p.WriteGPL(f, req.GetString("name", ""))
		case "pal":
			err = p.Write(f)
		default:
			return errorResult(fmt.Errorf("unknown format %q (want jasc, gpl, pal)", format)), nil
		}
		if err != nil {
			return errorResult(fmt.Errorf("write %s: %w", format, err)), nil
		}
		return jsonResult(palConvertOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: outPath,
			Format: format,
		})
	}
}

func makePALLookupHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		output, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		gameData := req.GetString("game_data", "")
		rf, err := r.ResolveFile(path, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()
		outPath, err := r.ResolveOutput(output, gameData)
		if err != nil {
			return errorResult(err), nil
		}

		table, err := pal.LoadLookupFromFile(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}

		var p *pal.Palette
		if palArg := req.GetString("palette", ""); palArg != "" {
			rp, err := r.ResolveFile(palArg, gameData)
			if err != nil {
				return errorResult(fmt.Errorf("palette: %w", err)), nil
			}
			defer func() { _ = rp.Close() }()
			p, err = pal.LoadFromFile(rp.LocalPath)
			if err != nil {
				return errorResult(fmt.Errorf("load palette: %w", err)), nil
			}
		} else {
			p, err = embeddedTAPalette()
			if err != nil {
				return errorResult(err), nil
			}
		}

		cell := int(req.GetFloat("cell", 4))
		img, err := pal.RenderLookupSwatch(table, p, cell)
		if err != nil {
			return errorResult(err), nil
		}
		if err := writeRenderedPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(palImageOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: outPath,
			Width:  img.Bounds().Dx(),
			Height: img.Bounds().Dy(),
		})
	}
}
