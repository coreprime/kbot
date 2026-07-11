package mcp

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot-io/formats/fnt"
)

func registerFNTTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("fnt_describe",
			mcplib.WithDescription(
				"Inspect a TA bitmap font: glyph height, flag bits, defined-glyph count, "+
					"min/mean/max glyph width and the code-point ranges that have glyph data.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .fnt file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeFNTDescribeHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("fnt_render",
			mcplib.WithDescription(
				"Render a UTF-8 string in the given bitmap font to a PNG.  Codepoints "+
					"beyond U+00FF wrap mod-256 to match how Cavedog's text systems index "+
					"the glyph table.  Foreground and background colors accept #rrggbb, "+
					"#rrggbbaa or 'transparent'.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .fnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			mcplib.WithString("text", mcplib.Required(), mcplib.Description("Text to render.")),
			mcplib.WithString("fg", mcplib.Description("Foreground color (default #ffffff).")),
			mcplib.WithString("bg", mcplib.Description("Background color (default 'transparent').")),
			withGameData(),
		),
		makeFNTRenderHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("fnt_sheet",
			mcplib.WithDescription(
				"Render every defined glyph as a 16-column sprite sheet PNG, sized so each "+
					"cell fits the widest glyph in the font.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .fnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			mcplib.WithString("fg", mcplib.Description("Foreground color (default #ffffff).")),
			mcplib.WithString("bg", mcplib.Description("Background color (default #222222).")),
			withGameData(),
		),
		makeFNTSheetHandler(r),
	)
}

type fntDescribeOutput struct {
	Path        string `json:"path"`
	Source      string `json:"source,omitempty"`
	FileSize    int64  `json:"file_size"`
	Height      int    `json:"height"`
	Flags       uint16 `json:"flags"`
	GlyphCount  int    `json:"glyph_count"`
	MinWidth    int    `json:"min_width"`
	MaxWidth    int    `json:"max_width"`
	MeanWidth   float64 `json:"mean_width"`
	Ranges      string `json:"ranges"`
}

type fntImageOutput struct {
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	Output string `json:"output"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

func loadFNT(path string) (*fnt.Font, int64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, fmt.Errorf("read fnt: %w", err)
	}
	f, err := fnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, 0, fmt.Errorf("parse fnt: %w", err)
	}
	return f, int64(len(data)), nil
}

func fntRanges(f *fnt.Font) string {
	out := ""
	start := -1
	for ch := 0; ch < 256; ch++ {
		if f.Glyphs[ch] != nil {
			if start < 0 {
				start = ch
			}
			continue
		}
		if start >= 0 {
			if out != "" {
				out += ", "
			}
			out += fmt.Sprintf("0x%02X-0x%02X", start, ch-1)
			start = -1
		}
	}
	if start >= 0 {
		if out != "" {
			out += ", "
		}
		out += fmt.Sprintf("0x%02X-0xFF", start)
	}
	if out == "" {
		out = "none"
	}
	return out
}

func makeFNTDescribeHandler(r *Resolver) server.ToolHandlerFunc {
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

		f, size, err := loadFNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}

		minW, maxW, totalW := 1<<31-1, 0, 0
		for _, g := range f.Glyphs {
			if g == nil {
				continue
			}
			if g.Width < minW {
				minW = g.Width
			}
			if g.Width > maxW {
				maxW = g.Width
			}
			totalW += g.Width
		}
		mean := 0.0
		if f.GlyphCount() > 0 {
			mean = float64(totalW) / float64(f.GlyphCount())
		} else {
			minW = 0
		}

		return jsonResult(fntDescribeOutput{
			Path:       rf.displayPath(),
			Source:     rf.Source,
			FileSize:   size,
			Height:     f.Height,
			Flags:      f.Flags,
			GlyphCount: f.GlyphCount(),
			MinWidth:   minW,
			MaxWidth:   maxW,
			MeanWidth:  mean,
			Ranges:     fntRanges(f),
		})
	}
}

func makeFNTRenderHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		output, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		text, err := req.RequireString("text")
		if err != nil {
			return errorResult(err), nil
		}
		fg, err := parseColorOrDefault(req.GetString("fg", ""), color.RGBA{255, 255, 255, 255})
		if err != nil {
			return errorResult(fmt.Errorf("fg: %w", err)), nil
		}
		bg, err := parseColorOrDefault(req.GetString("bg", ""), color.RGBA{0, 0, 0, 0})
		if err != nil {
			return errorResult(fmt.Errorf("bg: %w", err)), nil
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

		f, _, err := loadFNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		img := f.RenderText(text, fg, bg)

		if err := writeRenderedPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(fntImageOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: outPath,
			Width:  img.Bounds().Dx(),
			Height: img.Bounds().Dy(),
		})
	}
}

func makeFNTSheetHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		output, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		fg, err := parseColorOrDefault(req.GetString("fg", ""), color.RGBA{255, 255, 255, 255})
		if err != nil {
			return errorResult(fmt.Errorf("fg: %w", err)), nil
		}
		bg, err := parseColorOrDefault(req.GetString("bg", ""), color.RGBA{34, 34, 34, 255})
		if err != nil {
			return errorResult(fmt.Errorf("bg: %w", err)), nil
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

		f, _, err := loadFNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		img := f.RenderSheet(fg, bg)

		if err := writeRenderedPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(fntImageOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: outPath,
			Width:  img.Bounds().Dx(),
			Height: img.Bounds().Dy(),
		})
	}
}

// parseColorOrDefault accepts the same color encodings as the CLI: "#rrggbb",
// "#rrggbbaa" or "transparent"/"none".  Empty string falls back to dflt.
func parseColorOrDefault(s string, dflt color.RGBA) (color.RGBA, error) {
	if s == "" {
		return dflt, nil
	}
	if s == "transparent" || s == "none" {
		return color.RGBA{0, 0, 0, 0}, nil
	}
	if len(s) > 0 && s[0] == '#' {
		s = s[1:]
	}
	if len(s) != 6 && len(s) != 8 {
		return dflt, fmt.Errorf("expected #rrggbb or #rrggbbaa, got %q", s)
	}
	var r, g, b uint8
	var a uint8 = 255
	if _, err := fmt.Sscanf(s[0:2], "%02x", &r); err != nil {
		return dflt, err
	}
	if _, err := fmt.Sscanf(s[2:4], "%02x", &g); err != nil {
		return dflt, err
	}
	if _, err := fmt.Sscanf(s[4:6], "%02x", &b); err != nil {
		return dflt, err
	}
	if len(s) == 8 {
		if _, err := fmt.Sscanf(s[6:8], "%02x", &a); err != nil {
			return dflt, err
		}
	}
	return color.RGBA{R: r, G: g, B: b, A: a}, nil
}

// writeRenderedPNG creates parent directories, writes a PNG to path and
// cleans up the file handle.  Shared by every render-style MCP handler.
func writeRenderedPNG(path string, img image.Image) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create output dir: %w", err)
	}
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create output: %w", err)
	}
	defer func() { _ = f.Close() }()
	return png.Encode(f, img)
}
