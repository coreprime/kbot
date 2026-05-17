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
	"sort"
	"strings"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/internal/tntpreview"
)

func registerTNTTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("tnt_describe",
			mcplib.WithDescription(
				"Summarise a TNT map file: dimensions, unique tile count, sea level, "+
					"feature table size, placement count, elevation stats and the most-placed features.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .tnt file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeTNTDescribeHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("tnt_image",
			mcplib.WithDescription(
				"Render the full TNT terrain layer to a PNG (32 pixels per tile).",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .tnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			withGameData(),
		),
		makeTNTImageHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("tnt_heightmap",
			mcplib.WithDescription(
				"Export the elevation grid as an 8-bit grayscale PNG.  By default the "+
					"pixel value equals the raw elevation byte (round-trip safe).  Pass "+
					"normalize=true for a viewer-friendly stretched image.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .tnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			mcplib.WithBoolean("normalize", mcplib.Description("Stretch elevation range to 0-255 (default false).")),
			withGameData(),
		),
		makeTNTHeightmapHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("tnt_minimap",
			mcplib.WithDescription(
				"Export the embedded minimap as a PNG.  By default outputs an RGBA image "+
					"with void pixels transparent; pass paletted=true for an 8-bit indexed PNG "+
					"preserving raw palette indices.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .tnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			mcplib.WithBoolean("paletted", mcplib.Description("Emit a paletted 8-bit PNG instead of RGBA (default false).")),
			withGameData(),
		),
		makeTNTMinimapHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("tnt_preview",
			mcplib.WithDescription(
				"Render the TNT terrain layer and overlay it with each placed feature's "+
					"sprite plus a numbered marker at every Schema 0 StartPos found in the "+
					"sister .ota.  Requires a game-data folder so feature sprites (features/*.tdf, "+
					"anims/*.gaf) and the .ota can be resolved; without one this degrades to "+
					"the same render as tnt_image.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .tnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			withGameData(),
		),
		makeTNTPreviewHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("tnt_ascii",
			mcplib.WithDescription(
				"Render the height map as compact ASCII art — quick sanity check that "+
					"reveals the map's overall shape.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .tnt file.")),
			mcplib.WithNumber("cols", mcplib.Description("Maximum number of columns to render (default 64).")),
			withGameData(),
		),
		makeTNTASCIIHandler(r),
	)
}

type tntDescribeOutput struct {
	Path             string                  `json:"path"`
	Source           string                  `json:"source,omitempty"`
	FileSize         int64                   `json:"file_size"`
	IDVersion        uint32                  `json:"id_version"`
	AttrWidth        int                     `json:"attr_width"`
	AttrHeight       int                     `json:"attr_height"`
	TileWidth        int                     `json:"tile_width"`
	TileHeight       int                     `json:"tile_height"`
	PixelWidth       int                     `json:"pixel_width"`
	PixelHeight      int                     `json:"pixel_height"`
	SeaLevel         uint32                  `json:"sea_level"`
	UniqueTiles      int                     `json:"unique_tiles"`
	FeatureTableSize int                     `json:"feature_table_size"`
	Placements       int                     `json:"placements"`
	MinimapW         int                     `json:"minimap_width"`
	MinimapH         int                     `json:"minimap_height"`
	HeightMin        uint8                   `json:"height_min"`
	HeightMax        uint8                   `json:"height_max"`
	HeightMean       float64                 `json:"height_mean"`
	CellsBelowSea    int                     `json:"cells_below_sealevel"`
	TopFeatures      []tntDescribeFeatureOut `json:"top_features"`
}

type tntDescribeFeatureOut struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type tntImageOutput struct {
	Path   string `json:"path"`
	Output string `json:"output"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type tntPreviewOutput struct {
	Path            string `json:"path"`
	Output          string `json:"output"`
	Width           int    `json:"width"`
	Height          int    `json:"height"`
	SpritesPainted  int    `json:"sprites_painted"`
	SpritesMissing  int    `json:"sprites_missing"`
	StartPositions  int    `json:"start_positions"`
	SisterOTAFound  bool   `json:"sister_ota_found"`
	OverlayApplied  bool   `json:"overlay_applied"`
}

type tntASCIIOutput struct {
	Path  string `json:"path"`
	ASCII string `json:"ascii"`
	Cols  int    `json:"cols"`
}

func loadTNT(path string) (*tnt.Map, []tnt.Feature, []byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read tnt: %w", err)
	}
	rd := bytes.NewReader(data)
	m, err := tnt.LoadFromReader(rd)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("parse tnt: %w", err)
	}
	feats, err := m.LoadFeatures(rd)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read features: %w", err)
	}
	return m, feats, data, nil
}

func tntServerPalette() (color.Palette, error) {
	p, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	if err != nil {
		return nil, err
	}
	return p.ColorModel(), nil
}

func writeServerPNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create output: %w", err)
	}
	defer func() { _ = f.Close() }()
	return png.Encode(f, img)
}

func makeTNTDescribeHandler(r *Resolver) server.ToolHandlerFunc {
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

		m, feats, data, err := loadTNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}

		var minH, maxH uint8 = 255, 0
		var sum uint64
		belowSea := 0
		for _, a := range m.TileAttr {
			if a.Height < minH {
				minH = a.Height
			}
			if a.Height > maxH {
				maxH = a.Height
			}
			sum += uint64(a.Height)
			if uint32(a.Height) < m.Header.SeaLevel {
				belowSea++
			}
		}
		mean := 0.0
		if len(m.TileAttr) > 0 {
			mean = float64(sum) / float64(len(m.TileAttr))
		}

		counts := m.FeatureCounts()
		placements := 0
		type pair struct{ idx, count int }
		ps := make([]pair, 0, len(counts))
		for i, c := range counts {
			placements += c
			ps = append(ps, pair{i, c})
		}
		sort.Slice(ps, func(i, j int) bool { return ps[i].count > ps[j].count })
		topN := 10
		if len(ps) < topN {
			topN = len(ps)
		}
		top := make([]tntDescribeFeatureOut, 0, topN)
		for i := 0; i < topN; i++ {
			name := ""
			if ps[i].idx < len(feats) {
				name = feats[ps[i].idx].Name
			}
			top = append(top, tntDescribeFeatureOut{Index: ps[i].idx, Name: name, Count: ps[i].count})
		}

		return jsonResult(tntDescribeOutput{
			Path:             rf.displayPath(),
			Source:           rf.Source,
			FileSize:         int64(len(data)),
			IDVersion:        m.Header.IDVersion,
			AttrWidth:        m.AttrW,
			AttrHeight:       m.AttrH,
			TileWidth:        m.TileW,
			TileHeight:       m.TileH,
			PixelWidth:       m.TileW * 32,
			PixelHeight:      m.TileH * 32,
			SeaLevel:         m.Header.SeaLevel,
			UniqueTiles:      len(m.Tiles),
			FeatureTableSize: len(feats),
			Placements:       placements,
			MinimapW:         m.MinimapW,
			MinimapH:         m.MinimapH,
			HeightMin:        minH,
			HeightMax:        maxH,
			HeightMean:       mean,
			CellsBelowSea:    belowSea,
			TopFeatures:      top,
		})
	}
}

func makeTNTImageHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		outArg, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		gameData := req.GetString("game_data", "")
		rf, err := r.ResolveFile(path, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()
		outPath, err := r.ResolveOutput(outArg, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		m, _, _, err := loadTNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		pal, err := tntServerPalette()
		if err != nil {
			return errorResult(err), nil
		}
		img := m.RenderTileMap(pal)
		if err := writeServerPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(tntImageOutput{Path: rf.displayPath(), Output: outPath, Width: img.Bounds().Dx(), Height: img.Bounds().Dy()})
	}
}

func makeTNTPreviewHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		outArg, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		gameData := req.GetString("game_data", "")
		rf, err := r.ResolveFile(path, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()
		outPath, err := r.ResolveOutput(outArg, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		m, feats, _, err := loadTNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		pal, err := tntServerPalette()
		if err != nil {
			return errorResult(err), nil
		}
		base := m.RenderTileMap(pal)

		out := tntPreviewOutput{
			Path:   rf.displayPath(),
			Output: outPath,
			Width:  base.Bounds().Dx(),
			Height: base.Bounds().Dy(),
		}

		gd, _ := r.Registry().Get(rf.GameData)
		if gd != nil {
			vfs, vfsErr := gd.VFS()
			if vfsErr != nil {
				return errorResult(fmt.Errorf("open game-data vfs: %w", vfsErr)), nil
			}
			spritePal, palErr := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
			if palErr != nil {
				return errorResult(palErr), nil
			}
			basename := previewBasename(rf)
			stats, cErr := tntpreview.Compose(base, m, feats, vfs, spritePal, basename, "")
			if cErr != nil {
				return errorResult(cErr), nil
			}
			out.OverlayApplied = true
			out.SpritesPainted = stats.SpritesPainted
			out.SpritesMissing = stats.SpritesMissing
			out.StartPositions = stats.StartPositions
			out.SisterOTAFound = stats.HasSisterOTA
		}

		if err := writeServerPNG(outPath, base); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(out)
	}
}

// previewBasename returns the .tnt's filename without its extension, used to
// locate the sister .ota in the VFS by stem.  Prefers the virtual path so a
// game-data hit yields the in-archive name even when the file was extracted to
// a temp location.
func previewBasename(rf *ResolvedFile) string {
	p := rf.VirtualPath
	if p == "" {
		p = rf.LocalPath
	}
	base := filepath.Base(p)
	return strings.TrimSuffix(base, filepath.Ext(base))
}

func makeTNTHeightmapHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		outArg, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		normalize := req.GetBool("normalize", false)
		gameData := req.GetString("game_data", "")

		rf, err := r.ResolveFile(path, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()
		outPath, err := r.ResolveOutput(outArg, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		m, _, _, err := loadTNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		var img image.Image
		if normalize {
			img = m.RenderHeightMap()
		} else {
			img = m.RenderHeightMapRaw()
		}
		if err := writeServerPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(tntImageOutput{Path: rf.displayPath(), Output: outPath, Width: img.Bounds().Dx(), Height: img.Bounds().Dy()})
	}
}

func makeTNTMinimapHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		outArg, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		paletted := req.GetBool("paletted", false)
		gameData := req.GetString("game_data", "")

		rf, err := r.ResolveFile(path, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()
		outPath, err := r.ResolveOutput(outArg, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		m, _, _, err := loadTNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		if m.Minimap == nil {
			return errorResult(fmt.Errorf("file has no minimap")), nil
		}
		pal, err := tntServerPalette()
		if err != nil {
			return errorResult(err), nil
		}
		var img image.Image
		if paletted {
			img = m.RenderMinimapPaletted(pal)
		} else {
			img = m.RenderMinimap(pal)
		}
		if err := writeServerPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(tntImageOutput{Path: rf.displayPath(), Output: outPath, Width: img.Bounds().Dx(), Height: img.Bounds().Dy()})
	}
}

func makeTNTASCIIHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		cols := int(req.GetFloat("cols", 64))
		if cols <= 0 {
			cols = 64
		}
		rf, err := r.ResolveFile(path, req.GetString("game_data", ""))
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()
		m, _, _, err := loadTNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}
		return jsonResult(tntASCIIOutput{Path: rf.displayPath(), ASCII: m.RenderASCII(cols), Cols: cols})
	}
}
