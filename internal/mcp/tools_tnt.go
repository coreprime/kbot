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

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/internal/maplint"
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
		mcplib.NewTool("tnt_buildmap",
			mcplib.WithDescription(
				"Render a per-cell buildability classification PNG (one pixel per 16×16 "+
					"attribute cell).  Black = engine-void (Feature == 0xFFFC), red = a "+
					"feature is placed in the cell, blue = underwater (Height < sea level), "+
					"yellow = cliff edge (|Δheight| to a 4-neighbour > 32), green = "+
					"buildable.  By default the .tnt header's SeaLevel is used; pass "+
					"sealevel to override (0 disables the underwater check).",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .tnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			mcplib.WithNumber("sealevel", mcplib.Description("Override sea level for the underwater check (default: TNT header value, 0 disables).")),
			withGameData(),
		),
		makeTNTBuildmapHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("tnt_voidmap",
			mcplib.WithDescription(
				"Render the engine-void mask as a PNG (one pixel per 16×16 attribute "+
					"cell).  Cells whose Feature is 0xFFFC are opaque red; everything else "+
					"is transparent so the result can be overlaid on a tnt_image render.  "+
					"0xFFFD / 0xFFFE are not classified as void — see docs/formats/tnt.md.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .tnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			withGameData(),
		),
		makeTNTVoidmapHandler(r),
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
					"sprite plus a numbered marker at every StartPos in the selected schema "+
					"(default Schema 0; pass schema=<n> for a different one) found in the "+
					"sister .ota.  Requires a game-data folder so feature sprites (features/*.tdf, "+
					"anims/*.gaf) and the .ota can be resolved; without one this degrades to "+
					"the same render as tnt_image.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .tnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination PNG path.")),
			mcplib.WithNumber("schema", mcplib.Description("Schema index whose StartPos markers are drawn (0-based; default 0).")),
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

	s.AddTool(
		mcplib.NewTool("tnt_lint",
			mcplib.WithDescription(
				"Inspect a TNT map and report two classes of issues without modifying it: "+
					"tile-pool diagnostics (mirroring tnt_optimize — duplicate, similar, unused "+
					"tile graphics) and map-quality checks identical to Studio's Quality Checker "+
					"(missing OTA metadata, unreachable / void start positions, schema player-slot "+
					"coverage, metal proximity, void islands, height discontinuities, duplicate "+
					"tile graphics).  Returns a JSON list of diagnostics with severity + message.  "+
					"`path` accepts an absolute disk path, a virtual path inside the supplied "+
					"`game_data` (e.g. \"maps/the pass.tnt\"), or a bare basename (\"the pass.tnt\") "+
					"which is searched against the VFS.  The sibling .ota and the metal-proximity "+
					"feature registry are resolved through the same VFS automatically.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the .tnt file — absolute, virtual ('maps/foo.tnt'), or bare basename.")),
			mcplib.WithString("ota_path",
				mcplib.Description("Override the sister .ota path (default: <tnt-basename>.ota next to the .tnt)."),
			),
			mcplib.WithNumber("similarity",
				mcplib.Description("Mean per-channel pixel-difference threshold (% of 255) for the similar-tiles rule; 0 disables.  Defaults to 1.0."),
			),
			mcplib.WithBoolean("quality",
				mcplib.Description("Run the map-quality pass alongside tile-pool diagnostics (default true)."),
			),
			withGameData(),
		),
		makeTNTLintHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("tnt_optimize",
			mcplib.WithDescription(
				"Rewrite a TNT map with redundant tile graphics consolidated.  Three "+
					"passes run in order: byte-identical tile graphics are merged, "+
					"visually-similar tiles whose tilemap placements share the same "+
					"heightmap footprint are merged (configurable via similarity), and "+
					"any tile graphic the tilemap no longer references is dropped.  The "+
					"on-disk heightmap and feature placements are preserved verbatim.  "+
					"Returns a JSON summary of the merges plus the bytes saved.",
			),
			mcplib.WithString("path", mcplib.Required(), mcplib.Description("Path to the source .tnt file.")),
			mcplib.WithString("output", mcplib.Required(), mcplib.Description("Destination .tnt path for the optimised map.")),
			mcplib.WithNumber("similarity",
				mcplib.Description("Maximum mean per-channel pixel difference (% of 255) for visual-similarity merging.  0 disables the similarity pass.  Defaults to 1.0."),
			),
			mcplib.WithBoolean("keep_unused",
				mcplib.Description("Keep tile graphics that no map cell references (default false)."),
			),
			withGameData(),
		),
		makeTNTOptimizeHandler(r),
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

type tntOptimizeOutput struct {
	Path              string  `json:"path"`
	Output            string  `json:"output"`
	SimilarityPercent float64 `json:"similarity_percent"`
	KeepUnused        bool    `json:"keep_unused"`
	TilesBefore       int     `json:"tiles_before"`
	TilesAfter        int     `json:"tiles_after"`
	ExactMerges       int     `json:"exact_merges"`
	SimilarityMerges  int     `json:"similarity_merges"`
	UnusedRemoved     int     `json:"unused_removed"`
	TileBytesSaved    int     `json:"tile_bytes_saved"`
	OutputFileSize    int64   `json:"output_file_size"`
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
		// Negative default keeps "not provided" indistinguishable from
		// the previous behaviour (Schema 0).
		schema := 0
		if v := req.GetFloat("schema", -1); v >= 0 {
			schema = int(v)
		}
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
			stats, cErr := tntpreview.ComposeWith(base, m, feats, vfs, spritePal, basename, "", tntpreview.Options{SchemaIndex: schema})
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

func makeTNTBuildmapHandler(r *Resolver) server.ToolHandlerFunc {
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
		// Negative default acts as "not provided" — anything ≥ 0 wins
		// over the .tnt header's sea level, so callers can pass 0 to
		// disable the underwater check explicitly.
		sea := m.Header.SeaLevel
		if v := req.GetFloat("sealevel", -1); v >= 0 {
			sea = uint32(v)
		}
		img := m.RenderBuildMap(sea)
		if img == nil {
			return errorResult(fmt.Errorf("map has no attribute grid")), nil
		}
		if err := writeServerPNG(outPath, img); err != nil {
			return errorResult(err), nil
		}
		return jsonResult(tntImageOutput{Path: rf.displayPath(), Output: outPath, Width: img.Bounds().Dx(), Height: img.Bounds().Dy()})
	}
}

func makeTNTVoidmapHandler(r *Resolver) server.ToolHandlerFunc {
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
		img := m.RenderVoidMap()
		if img == nil {
			return errorResult(fmt.Errorf("map has no attribute grid")), nil
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

func makeTNTOptimizeHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		outArg, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		similarity := req.GetFloat("similarity", 1.0)
		keepUnused := req.GetBool("keep_unused", false)
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

		opts := tnt.OptimizeOptions{
			SimilarityPercent: similarity,
			KeepUnused:        keepUnused,
		}
		if similarity > 0 {
			pal, palErr := tntServerPalette()
			if palErr != nil {
				return errorResult(palErr), nil
			}
			opts.Palette = pal
		}

		stats, err := m.Optimize(opts)
		if err != nil {
			return errorResult(err), nil
		}

		// Write to a tempfile in the destination directory and rename so
		// that a mid-write crash never leaves a half-written .tnt where
		// the caller asked for a finished one.
		dir := filepath.Dir(outPath)
		tmp, err := os.CreateTemp(dir, ".tnt-optimize-*.tmp")
		if err != nil {
			return errorResult(fmt.Errorf("create temp: %w", err)), nil
		}
		tmpName := tmp.Name()
		if err := m.Save(tmp, feats); err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
			return errorResult(fmt.Errorf("save tnt: %w", err)), nil
		}
		if err := tmp.Close(); err != nil {
			_ = os.Remove(tmpName)
			return errorResult(fmt.Errorf("close temp: %w", err)), nil
		}
		if err := os.Rename(tmpName, outPath); err != nil {
			_ = os.Remove(tmpName)
			return errorResult(fmt.Errorf("rename to %s: %w", outPath, err)), nil
		}

		var outSize int64
		if info, statErr := os.Stat(outPath); statErr == nil {
			outSize = info.Size()
		}

		return jsonResult(tntOptimizeOutput{
			Path:              rf.displayPath(),
			Output:            outPath,
			SimilarityPercent: similarity,
			KeepUnused:        keepUnused,
			TilesBefore:       stats.TilesBefore,
			TilesAfter:        stats.TilesAfter,
			ExactMerges:       stats.ExactMerges,
			SimilarityMerges:  stats.SimilarityMerges,
			UnusedRemoved:     stats.UnusedRemoved,
			TileBytesSaved:    (stats.TilesBefore - stats.TilesAfter) * tnt.TileGfxSize,
			OutputFileSize:    outSize,
		})
	}
}

// tntLintOutput is the JSON shape returned by the tnt_lint MCP tool.
type tntLintOutput struct {
	Path              string                  `json:"path"`
	Source            string                  `json:"source,omitempty"`
	TileGraphics      int                     `json:"tile_graphics"`
	AttrWidth         int                     `json:"attr_width"`
	AttrHeight        int                     `json:"attr_height"`
	OTAPath           string                  `json:"ota_path,omitempty"`
	FeatureRegistryOK bool                    `json:"feature_registry_loaded"`
	TilePool          []tntLintTilePoolEntry  `json:"tile_pool_diagnostics"`
	Quality           []tntLintQualityEntry   `json:"quality"`
	IssueCount        int                     `json:"issue_count"`
}

type tntLintTilePoolEntry struct {
	Rule       string `json:"rule"`
	Severity   string `json:"severity"`
	Message    string `json:"message"`
	Count      int    `json:"count,omitempty"`
	BytesSaved int    `json:"bytes_saved,omitempty"`
}

type tntLintQualityEntry struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

func makeTNTLintHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		path, err := req.RequireString("path")
		if err != nil {
			return errorResult(err), nil
		}
		gameData := req.GetString("game_data", "")
		otaOverride := req.GetString("ota_path", "")
		similarity := req.GetFloat("similarity", 1.0)
		runQuality := req.GetBool("quality", true)

		rf, err := r.ResolveFile(path, gameData)
		if err != nil {
			return errorResult(err), nil
		}
		defer func() { _ = rf.Close() }()

		m, _, data, err := loadTNT(rf.LocalPath)
		if err != nil {
			return errorResult(err), nil
		}

		// Tile-pool diagnostics.
		opts := tnt.LintOptions{SimilarityPercent: similarity}
		if similarity > 0 {
			pal, palErr := tntServerPalette()
			if palErr != nil {
				return errorResult(palErr), nil
			}
			opts.Palette = pal
		}
		diags, err := m.Lint(opts)
		if err != nil {
			return errorResult(err), nil
		}
		out := tntLintOutput{
			Path:         rf.displayPath(),
			Source:       rf.Source,
			TileGraphics: len(m.Tiles),
			AttrWidth:    m.AttrW,
			AttrHeight:   m.AttrH,
		}
		issueCount := 0
		for _, d := range diags {
			out.TilePool = append(out.TilePool, tntLintTilePoolEntry{
				Rule:       d.Rule,
				Severity:   string(d.Severity),
				Message:    d.Message,
				Count:      d.Count,
				BytesSaved: d.BytesSaved,
			})
			issueCount++
		}

		// Map-quality pass.
		if runQuality {
			lintIn := maplint.Input{Map: m}

			// OTA — explicit override > sibling on the same backing store as
			// the TNT.  When the TNT was extracted from an archive, rf.LocalPath
			// is a temp file with no sibling on disk; the VFS-aware lookup
			// below catches that case so the quality pass doesn't degrade to
			// "no schemas to check" purely because of where the TNT lives.
			if otaData, otaSrc := tntLintReadSiblingOTA(rf, otaOverride, r, gameData); otaData != nil {
				if ota, parseErr := maplint.ParseOTA(string(otaData)); parseErr == nil && ota != nil {
					lintIn.OTA = ota
					out.OTAPath = otaSrc
				}
			}

			// Feature placements baked into the TNT.
			featTable, _ := m.LoadFeatures(bytes.NewReader(data))
			for _, p := range m.GetFeaturePlacements() {
				if p.FeatureIdx < 0 || p.FeatureIdx >= len(featTable) {
					continue
				}
				name := strings.TrimSpace(featTable[p.FeatureIdx].Name)
				if name == "" {
					continue
				}
				lintIn.Features = append(lintIn.Features, maplint.FeaturePlacement{
					Name: name, AX: p.AttrX, AY: p.AttrY,
				})
			}

			// Feature registry from the resolved game-data VFS (when one
			// was bound — game_data="" leaves this nil, in which case the
			// metal-proximity check skips itself with a friendly message).
			if gd, gdErr := r.registry.Get(gameData); gdErr == nil && gd != nil {
				if vfs, vfsErr := gd.VFS(); vfsErr == nil && vfs != nil {
					if reg := tntScanFeatureRegistry(vfs); len(reg) > 0 {
						lintIn.FeatureRegistry = reg
						out.FeatureRegistryOK = true
					}
				}
			}

			for _, d := range maplint.Run(lintIn) {
				out.Quality = append(out.Quality, tntLintQualityEntry{
					ID:       d.ID,
					Label:    d.Label,
					Severity: string(d.Severity),
					Message:  d.Message,
				})
				if d.Severity != maplint.SeverityOK {
					issueCount++
				}
			}
		}

		out.IssueCount = issueCount
		return jsonResult(out)
	}
}

// tntLintReadSiblingOTA mirrors the CLI's lookup order: an explicit
// override wins; otherwise we look for the sibling .ota on whatever
// backing store produced the TNT.  TNTs that came from an archive
// have a non-empty VirtualPath, and their LocalPath is a temp file
// without a sibling on disk — that case is what makes a plain disk
// fallback unreliable in MCP runs.
func tntLintReadSiblingOTA(rf *ResolvedFile, otaOverride string, r *Resolver, gameData string) ([]byte, string) {
	if otaOverride != "" {
		return tntLintReadOTAVia(r, otaOverride, gameData)
	}
	if rf.VirtualPath != "" {
		sib := strings.TrimSuffix(rf.VirtualPath, filepath.Ext(rf.VirtualPath)) + ".ota"
		return tntLintReadOTAVia(r, sib, gameData)
	}
	sib := strings.TrimSuffix(rf.LocalPath, filepath.Ext(rf.LocalPath)) + ".ota"
	if data, err := os.ReadFile(sib); err == nil {
		return data, sib
	}
	return nil, ""
}

// tntLintReadOTAVia resolves an OTA path through the Resolver so that
// virtual paths, bare names and absolute paths all work the same way
// the CLI handles them.
func tntLintReadOTAVia(r *Resolver, p, gameData string) ([]byte, string) {
	otaRF, err := r.ResolveFile(p, gameData)
	if err != nil {
		return nil, ""
	}
	defer func() { _ = otaRF.Close() }()
	data, readErr := os.ReadFile(otaRF.LocalPath)
	if readErr != nil {
		return nil, ""
	}
	return data, otaRF.displayPath()
}

// tntScanFeatureRegistry walks features/*.tdf in the supplied VFS and
// returns a lowercased-feature-name → metal-yield map for use by the
// maplint metal-proximity check.
func tntScanFeatureRegistry(vfs *filesystem.VirtualFileSystem) map[string]int {
	out := map[string]int{}
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "features/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		data, err := vfs.ReadFile(p)
		if err != nil {
			continue
		}
		doc, err := tdf.ParseString(string(data))
		if err != nil {
			continue
		}
		for _, s := range doc.Sections() {
			metal := s.Int("metal")
			if metal > 0 {
				out[strings.ToLower(s.Name())] = metal
			}
		}
	}
	return out
}
