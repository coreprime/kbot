package mcp

import (
	"bytes"
	"context"
	"fmt"
	"os"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot-io/formats/sct"
)

func registerSCTTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("sct_describe",
			mcplib.WithDescription(
				"Summarise a TA .SCT map section: version, tile grid size, unique tile "+
					"count, attribute (height) grid size, elevation stats and presence of "+
					"the embedded minimap.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .sct file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeSCTDescribeHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("sct_image",
			mcplib.WithDescription(
				"Render the section's tile grid to a PNG (32 pixels per tile) using the "+
					"embedded TA palette.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .sct file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			withGameData(),
		),
		makeSCTImageHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("sct_heightmap",
			mcplib.WithDescription(
				"Export the section's elevation grid as a normalised grayscale PNG at "+
					"16-pixel resolution.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .sct file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			withGameData(),
		),
		makeSCTHeightmapHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("sct_minimap",
			mcplib.WithDescription(
				"Export the section's embedded 128x128 minimap as a PNG.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .sct file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			withGameData(),
		),
		makeSCTMinimapHandler(r),
	)
}

type sctDescribeOutput struct {
	Path        string  `json:"path"`
	Source      string  `json:"source,omitempty"`
	FileSize    int64   `json:"file_size"`
	Version     uint32  `json:"version"`
	TileWidth   uint32  `json:"tile_width"`
	TileHeight  uint32  `json:"tile_height"`
	PixelWidth  uint32  `json:"pixel_width"`
	PixelHeight uint32  `json:"pixel_height"`
	UniqueTiles int     `json:"unique_tiles"`
	AttrWidth   int     `json:"attr_width"`
	AttrHeight  int     `json:"attr_height"`
	HasMinimap  bool    `json:"has_minimap"`
	HasHeight   bool    `json:"has_height"`
	HeightMin   uint8   `json:"height_min,omitempty"`
	HeightMax   uint8   `json:"height_max,omitempty"`
	HeightMean  float64 `json:"height_mean,omitempty"`
}

type sctImageOutput struct {
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	Output string `json:"output"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

func loadSCT(path string) (*sct.Section, int64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, fmt.Errorf("read sct: %w", err)
	}
	s, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, 0, fmt.Errorf("parse sct: %w", err)
	}
	return s, int64(len(data)), nil
}

func makeSCTDescribeHandler(r *Resolver) server.ToolHandlerFunc {
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

		s, size, err := loadSCT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}

		out := sctDescribeOutput{
			Path:        rf.displayPath(),
			Source:      rf.Source,
			FileSize:    size,
			Version:     s.Header.Version,
			TileWidth:   s.Header.Width,
			TileHeight:  s.Header.Height,
			PixelWidth:  s.Header.Width * 32,
			PixelHeight: s.Header.Height * 32,
			UniqueTiles: len(s.Tiles),
			AttrWidth:   s.AttrW,
			AttrHeight:  s.AttrH,
			HasMinimap:  s.Minimap != nil,
			HasHeight:   len(s.HeightMap) > 0,
		}
		if len(s.HeightMap) > 0 {
			var minH, maxH uint8 = 255, 0
			var sum uint64
			for _, h := range s.HeightMap {
				if h.Height < minH {
					minH = h.Height
				}
				if h.Height > maxH {
					maxH = h.Height
				}
				sum += uint64(h.Height)
			}
			out.HeightMin = minH
			out.HeightMax = maxH
			out.HeightMean = float64(sum) / float64(len(s.HeightMap))
		}
		return jsonResult(out)
	}
}

func makeSCTImageHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		s, rf, outPath, err := sctResolveForRender(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()

		pal, err := tntServerPalette()
		if err != nil {
			return errorResult(err), nil
		}
		img := s.RenderTileMap(pal)
		if err := writeRenderedPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(sctImageOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: outPath,
			Width:  img.Bounds().Dx(),
			Height: img.Bounds().Dy(),
		})
	}
}

func makeSCTHeightmapHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		s, rf, outPath, err := sctResolveForRender(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()

		gray := s.RenderHeightMap()
		if gray == nil {
			return errorResult(fmt.Errorf("section has no height data")), nil
		}
		if err := writeRenderedPNG(outPath, gray); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(sctImageOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: outPath,
			Width:  gray.Bounds().Dx(),
			Height: gray.Bounds().Dy(),
		})
	}
}

func makeSCTMinimapHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		s, rf, outPath, err := sctResolveForRender(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()

		if s.Minimap == nil {
			return errorResult(fmt.Errorf("section has no minimap")), nil
		}
		pal, err := tntServerPalette()
		if err != nil {
			return errorResult(err), nil
		}
		img := s.RenderMinimap(pal)
		if err := writeRenderedPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(sctImageOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: outPath,
			Width:  img.Bounds().Dx(),
			Height: img.Bounds().Dy(),
		})
	}
}

// sctResolveForRender packages the common dance every sct_* render handler
// performs: read path/output, resolve them against the game-data folder, and
// parse the SCT.  Caller still owns rf.Close().
func sctResolveForRender(r *Resolver, req mcplib.CallToolRequest) (*sct.Section, *ResolvedFile, string, error) {
	path, err := req.RequireString("path")
	if err != nil {
		return nil, nil, "", err
	}
	outArg, err := req.RequireString("output")
	if err != nil {
		return nil, nil, "", err
	}
	gameData := req.GetString("game_data", "")
	rf, err := r.ResolveFile(path, gameData)
	if err != nil {
		return nil, nil, "", err
	}
	outPath, err := r.ResolveOutput(outArg, gameData)
	if err != nil {
		_ = rf.Close()
		return nil, nil, "", err
	}
	s, _, err := loadSCT(rf.LocalPath)
	if err != nil {
		_ = rf.Close()
		return nil, nil, "", err
	}
	return s, rf, outPath, nil
}
