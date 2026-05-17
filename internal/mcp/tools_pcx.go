package mcp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/pcx"
)

func registerPCXTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("pcx_describe",
			mcplib.WithDescription(
				"Inspect a PCX image: version, encoding, dimensions, bit depth, "+
					"plane count, DPI and a friendly colour-type description.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .pcx file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makePCXDescribeHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("pcx_convert",
			mcplib.WithDescription(
				"Convert a PCX image to PNG, GIF or BMP.  Output paths are anchored "+
					"to the game-data folder when relative.  Format may be omitted if "+
					"the output extension is recognised.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .pcx file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithString("output",
				mcplib.Required(),
				mcplib.Description("Destination path for the converted image."),
			),
			mcplib.WithString("format",
				mcplib.Description("Output format: 'png', 'gif' or 'bmp'.  Inferred from the output extension when omitted."),
			),
			withGameData(),
		),
		makePCXConvertHandler(r),
	)
}

type pcxDescribeOutput struct {
	Path         string `json:"path"`
	Source       string `json:"source,omitempty"`
	FileSize     int64  `json:"file_size"`
	Version      uint8  `json:"version"`
	Encoding     string `json:"encoding"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	BitsPerPixel int    `json:"bits_per_pixel"`
	NumPlanes    uint8  `json:"num_planes"`
	BytesPerLine uint16 `json:"bytes_per_line"`
	HorzDPI      uint16 `json:"horz_dpi"`
	VertDPI      uint16 `json:"vert_dpi"`
	ColorType    string `json:"color_type"`
}

func makePCXDescribeHandler(r *Resolver) server.ToolHandlerFunc {
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

		f, err := os.Open(rf.LocalPath)
		if err != nil {
			return errorResult(fmt.Errorf("open pcx: %w", err)), nil
		}
		defer func() { _ = f.Close() }()

		reader, err := pcx.LoadFromReader(f)
		if err != nil {
			return errorResult(fmt.Errorf("parse pcx: %w", err)), nil
		}
		stat, _ := f.Stat()
		header := reader.Header()

		encoding := fmt.Sprintf("Unknown (%d)", header.Encoding)
		if header.Encoding == 1 {
			encoding = "RLE"
		}

		colorType := "Unknown"
		switch {
		case reader.BitsPerPixel() == 1:
			colorType = "Monochrome"
		case reader.BitsPerPixel() == 4:
			colorType = "16-color"
		case reader.BitsPerPixel() == 8 && header.NumPlanes == 1:
			colorType = "256-color (paletted)"
		case reader.BitsPerPixel() == 24 && header.NumPlanes == 3:
			colorType = "True Color (RGB)"
		}

		out := pcxDescribeOutput{
			Path:         rf.displayPath(),
			Source:       rf.Source,
			Version:      header.Version,
			Encoding:     encoding,
			Width:        reader.Width(),
			Height:       reader.Height(),
			BitsPerPixel: reader.BitsPerPixel(),
			NumPlanes:    header.NumPlanes,
			BytesPerLine: header.BytesPerLine,
			HorzDPI:      header.HorzDPI,
			VertDPI:      header.VertDPI,
			ColorType:    colorType,
		}
		if stat != nil {
			out.FileSize = stat.Size()
		}
		return jsonResult(out)
	}
}

type pcxConvertOutput struct {
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	Output string `json:"output"`
	Format string `json:"format"`
}

func makePCXConvertHandler(r *Resolver) server.ToolHandlerFunc {
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
			case ".png":
				format = "png"
			case ".gif":
				format = "gif"
			case ".bmp":
				format = "bmp"
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

		resolvedOut, err := r.ResolveOutput(output, gameData)
		if err != nil {
			return errorResult(fmt.Errorf("output: %w", err)), nil
		}

		in, err := os.Open(rf.LocalPath)
		if err != nil {
			return errorResult(fmt.Errorf("open pcx: %w", err)), nil
		}
		defer func() { _ = in.Close() }()

		if err := os.MkdirAll(filepath.Dir(resolvedOut), 0o755); err != nil {
			return errorResult(fmt.Errorf("create output dir: %w", err)), nil
		}
		out, err := os.Create(resolvedOut)
		if err != nil {
			return errorResult(fmt.Errorf("create output: %w", err)), nil
		}
		defer func() { _ = out.Close() }()

		switch format {
		case "png":
			err = pcx.ConvertToPNG(out, in)
		case "gif":
			err = pcx.ConvertToGIF(out, in)
		case "bmp":
			err = pcx.ConvertToBMP(out, in)
		default:
			return errorResult(fmt.Errorf("unsupported format %q (want png, gif, or bmp)", format)), nil
		}
		if err != nil {
			return errorResult(fmt.Errorf("convert: %w", err)), nil
		}

		return jsonResult(pcxConvertOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: resolvedOut,
			Format: format,
		})
	}
}
