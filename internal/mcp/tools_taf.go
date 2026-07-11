package mcp

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"image/color"
	"image/gif"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot-io/formats/tsf"
)

// tafTicksPerSecond is the TAF playback clock — durations are expressed in
// 1/30th-second game ticks, matching GAF.
const tafTicksPerSecond = 30.0

func registerTAFTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("taf_info",
			mcplib.WithDescription(
				"Summarise a TAF (TA: Kingdoms truecolor animation) file: sequence "+
					"name, frame count, total duration and a per-frame table of size, "+
					"origin, pixel format and timing.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .taf file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeTAFInfoHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("taf_list",
			mcplib.WithDescription(
				"One-line summary of a TAF file: sequence name, frame count, total "+
					"duration and pixel format.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .taf file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeTAFListHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("taf_render",
			mcplib.WithDescription(
				"Render a single TAF frame and return it inline as a PNG image so it "+
					"can be shown directly. Optionally also write the PNG to disk.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .taf file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithNumber("frame",
				mcplib.Description("Zero-based frame index to render (default 0)."),
			),
			mcplib.WithString("output",
				mcplib.Description("Optional destination path to also save the PNG."),
			),
			withGameData(),
		),
		makeTAFRenderHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("taf_sheet",
			mcplib.WithDescription(
				"Render every TAF frame into a grid sprite sheet and return it inline "+
					"as a PNG so the whole animation can be shown at a glance. "+
					"Optionally also write the PNG to disk.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .taf file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithNumber("columns",
				mcplib.Description("Number of columns in the grid (default 8)."),
			),
			mcplib.WithString("background",
				mcplib.Description("Optional hex background colour (e.g. #000000); default transparent."),
			),
			mcplib.WithString("output",
				mcplib.Description("Optional destination path to also save the PNG."),
			),
			withGameData(),
		),
		makeTAFSheetHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("taf_export",
			mcplib.WithDescription(
				"Export a TAF animation as an animated GIF or APNG. GIF quantises to a "+
					"255-colour table plus a transparent slot; APNG (format 'png') "+
					"preserves the full alpha channel. Output paths are anchored to the "+
					"game-data folder when relative.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .taf file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithString("format",
				mcplib.Description("Output format: 'apng'/'png' (default) or 'gif'."),
			),
			mcplib.WithString("output",
				mcplib.Required(),
				mcplib.Description("Destination path for the rendered animation."),
			),
			withGameData(),
		),
		makeTAFExportHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("taf_lint",
			mcplib.WithDescription(
				"Validate a TAF file's structure and report findings (errors, warnings "+
					"and notes) one per entry. An empty result means the animation is "+
					"clean and serialises byte-for-byte.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .taf file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeTAFLintHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("tsf_info",
			mcplib.WithDescription(
				"Summarise a TSF document (the text form of a TAF): animation name, "+
					"looping flag and a per-frame table of delay, pixel format and the "+
					"referenced layer image.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .tsf file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeTSFInfoHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("tsf_lint",
			mcplib.WithDescription(
				"Validate a TSF document's shape — a single animation whose frames each "+
					"hold one layer with a Filename and a recognised pixel format — and "+
					"report findings one per entry.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .tsf file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeTSFLintHandler(r),
	)
}

// loadMCPTAF resolves and parses a TAF file for an MCP handler. The caller
// must call the returned closer to release any temp backing file.
func loadMCPTAF(r *Resolver, req mcplib.CallToolRequest) (*tsf.TAF, *ResolvedFile, func(), error) {
	path, err := req.RequireString("path")
	if err != nil {
		return nil, nil, func() {}, err
	}
	rf, err := r.ResolveFile(path, req.GetString("game_data", ""))
	if err != nil {
		return nil, nil, func() {}, err
	}
	closer := func() { _ = rf.Close() }
	data, err := os.ReadFile(rf.LocalPath)
	if err != nil {
		closer()
		return nil, nil, func() {}, fmt.Errorf("read taf: %w", err)
	}
	taf, err := tsf.ParseTAF(data)
	if err != nil {
		closer()
		return nil, nil, func() {}, fmt.Errorf("parse taf: %w", err)
	}
	return taf, rf, closer, nil
}

type tafFrameInfo struct {
	Index         int     `json:"index"`
	Width         uint16  `json:"width"`
	Height        uint16  `json:"height"`
	OriginX       int16   `json:"origin_x"`
	OriginY       int16   `json:"origin_y"`
	Format        string  `json:"format"`
	DurationTicks uint32  `json:"duration_ticks"`
	DurationSecs  float64 `json:"duration_seconds"`
	Flag          uint8   `json:"flag"`
}

type tafInfoOutput struct {
	Path          string         `json:"path"`
	Source        string         `json:"source,omitempty"`
	Name          string         `json:"name"`
	Frames        int            `json:"frames"`
	DurationTicks uint32         `json:"duration_ticks"`
	DurationSecs  float64        `json:"duration_seconds"`
	Format        string         `json:"format,omitempty"`
	FrameList     []tafFrameInfo `json:"frame_list"`
}

func tafTotalTicks(t *tsf.TAF) uint32 {
	var ticks uint32
	for _, f := range t.Frames {
		ticks += f.Duration
	}
	return ticks
}

func makeTAFInfoHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		taf, rf, closer, err := loadMCPTAF(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer closer()

		ticks := tafTotalTicks(taf)
		out := tafInfoOutput{
			Path:          rf.displayPath(),
			Source:        rf.Source,
			Name:          taf.Name,
			Frames:        len(taf.Frames),
			DurationTicks: ticks,
			DurationSecs:  float64(ticks) / tafTicksPerSecond,
			FrameList:     make([]tafFrameInfo, 0, len(taf.Frames)),
		}
		if len(taf.Frames) > 0 {
			out.Format = taf.Frames[0].Format.String()
		}
		for i, f := range taf.Frames {
			out.FrameList = append(out.FrameList, tafFrameInfo{
				Index:         i,
				Width:         f.Width,
				Height:        f.Height,
				OriginX:       f.OriginX,
				OriginY:       f.OriginY,
				Format:        f.Format.String(),
				DurationTicks: f.Duration,
				DurationSecs:  float64(f.Duration) / tafTicksPerSecond,
				Flag:          f.FlagByte(),
			})
		}
		return jsonResult(out)
	}
}

type tafListOutput struct {
	Path          string  `json:"path"`
	Source        string  `json:"source,omitempty"`
	Name          string  `json:"name"`
	Frames        int     `json:"frames"`
	DurationTicks uint32  `json:"duration_ticks"`
	DurationSecs  float64 `json:"duration_seconds"`
	Format        string  `json:"format,omitempty"`
}

func makeTAFListHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		taf, rf, closer, err := loadMCPTAF(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer closer()

		ticks := tafTotalTicks(taf)
		out := tafListOutput{
			Path:          rf.displayPath(),
			Source:        rf.Source,
			Name:          taf.Name,
			Frames:        len(taf.Frames),
			DurationTicks: ticks,
			DurationSecs:  float64(ticks) / tafTicksPerSecond,
		}
		if len(taf.Frames) > 0 {
			out.Format = taf.Frames[0].Format.String()
		}
		return jsonResult(out)
	}
}

// imageResult returns a tool result carrying a base64 PNG image plus a short
// text caption, so MCP clients can show the rendered frame directly.
func imageResult(caption string, pngData []byte) *mcplib.CallToolResult {
	enc := base64.StdEncoding.EncodeToString(pngData)
	return mcplib.NewToolResultImage(caption, enc, "image/png")
}

func makeTAFRenderHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		taf, _, closer, err := loadMCPTAF(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer closer()

		frame := int(req.GetFloat("frame", 0))
		if frame < 0 || frame >= len(taf.Frames) {
			return errorResult(fmt.Errorf("frame %d out of range (0..%d)", frame, len(taf.Frames)-1)), nil
		}
		img, err := taf.FrameImage(frame)
		if err != nil {
			return errorResult(fmt.Errorf("render frame: %w", err)), nil
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			return errorResult(fmt.Errorf("encode png: %w", err)), nil
		}

		caption := fmt.Sprintf("%s frame %d (%dx%d)", taf.Name, frame, img.Bounds().Dx(), img.Bounds().Dy())
		if output := req.GetString("output", ""); output != "" {
			saved, werr := writeMCPImage(r, output, req.GetString("game_data", ""), buf.Bytes())
			if werr != nil {
				return errorResult(werr), nil
			}
			caption += " → " + saved
		}
		return imageResult(caption, buf.Bytes()), nil
	}
}

func makeTAFSheetHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		taf, _, closer, err := loadMCPTAF(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer closer()

		cols := int(req.GetFloat("columns", 8))
		if cols < 1 {
			cols = 1
		}
		var bg color.Color
		if hex := req.GetString("background", ""); hex != "" {
			c, perr := parseColorOrDefault(hex, color.RGBA{})
			if perr != nil {
				return errorResult(perr), nil
			}
			bg = c
		}
		sheet, err := taf.RenderSheet(cols, bg)
		if err != nil {
			return errorResult(fmt.Errorf("render sheet: %w", err)), nil
		}
		var buf bytes.Buffer
		if err := png.Encode(&buf, sheet); err != nil {
			return errorResult(fmt.Errorf("encode png: %w", err)), nil
		}

		caption := fmt.Sprintf("%s sheet: %d frame(s), %d column(s)", taf.Name, len(taf.Frames), cols)
		if output := req.GetString("output", ""); output != "" {
			saved, werr := writeMCPImage(r, output, req.GetString("game_data", ""), buf.Bytes())
			if werr != nil {
				return errorResult(werr), nil
			}
			caption += " → " + saved
		}
		return imageResult(caption, buf.Bytes()), nil
	}
}

type tafExportOutput struct {
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	Name   string `json:"name"`
	Frames int    `json:"frames"`
	Output string `json:"output"`
	Format string `json:"format"`
}

func makeTAFExportHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		output, err := req.RequireString("output")
		if err != nil {
			return errorResult(err), nil
		}
		format := strings.ToLower(req.GetString("format", "apng"))
		switch format {
		case "apng", "png":
			format = "apng"
		case "gif":
		default:
			return errorResult(fmt.Errorf("format must be apng, png or gif, got %q", format)), nil
		}

		taf, rf, closer, err := loadMCPTAF(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer closer()

		gameData := req.GetString("game_data", "")
		resolvedOut, err := r.ResolveOutput(output, gameData)
		if err != nil {
			return errorResult(fmt.Errorf("output: %w", err)), nil
		}
		if err := os.MkdirAll(filepath.Dir(resolvedOut), 0o755); err != nil {
			return errorResult(fmt.Errorf("create output dir: %w", err)), nil
		}
		dst, err := os.Create(resolvedOut)
		if err != nil {
			return errorResult(fmt.Errorf("create output: %w", err)), nil
		}
		defer func() { _ = dst.Close() }()

		switch format {
		case "gif":
			g, gerr := taf.ToGIF()
			if gerr != nil {
				return errorResult(fmt.Errorf("gif conversion: %w", gerr)), nil
			}
			if gerr := gif.EncodeAll(dst, g); gerr != nil {
				return errorResult(fmt.Errorf("gif encode: %w", gerr)), nil
			}
		case "apng":
			if perr := taf.ToAPNG(dst); perr != nil {
				return errorResult(fmt.Errorf("apng conversion: %w", perr)), nil
			}
		}

		return jsonResult(tafExportOutput{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Name:   taf.Name,
			Frames: len(taf.Frames),
			Output: resolvedOut,
			Format: format,
		})
	}
}

type tafDiagnostic struct {
	Level   string `json:"level"`
	Frame   int    `json:"frame"`
	Message string `json:"message"`
}

type tafLintOutput struct {
	Path        string          `json:"path"`
	Source      string          `json:"source,omitempty"`
	Clean       bool            `json:"clean"`
	Errors      int             `json:"errors"`
	Diagnostics []tafDiagnostic `json:"diagnostics"`
}

func makeTAFLintHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		taf, rf, closer, err := loadMCPTAF(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer closer()

		diags := taf.Lint()
		out := tafLintOutput{
			Path:        rf.displayPath(),
			Source:      rf.Source,
			Clean:       len(diags) == 0,
			Diagnostics: make([]tafDiagnostic, 0, len(diags)),
		}
		for _, d := range diags {
			if d.Level == tsf.LintError {
				out.Errors++
			}
			out.Diagnostics = append(out.Diagnostics, tafDiagnostic{
				Level:   d.Level.String(),
				Frame:   d.Frame,
				Message: d.Message,
			})
		}
		return jsonResult(out)
	}
}

// loadMCPTSF resolves and parses a TSF document for an MCP handler.
func loadMCPTSF(r *Resolver, req mcplib.CallToolRequest) (*tsf.Document, *ResolvedFile, func(), error) {
	path, err := req.RequireString("path")
	if err != nil {
		return nil, nil, func() {}, err
	}
	rf, err := r.ResolveFile(path, req.GetString("game_data", ""))
	if err != nil {
		return nil, nil, func() {}, err
	}
	closer := func() { _ = rf.Close() }
	data, err := os.ReadFile(rf.LocalPath)
	if err != nil {
		closer()
		return nil, nil, func() {}, fmt.Errorf("read tsf: %w", err)
	}
	doc, err := tsf.ParseTSF(string(data))
	if err != nil {
		closer()
		return nil, nil, func() {}, fmt.Errorf("parse tsf: %w", err)
	}
	return doc, rf, closer, nil
}

type tsfFrameInfo struct {
	Index    int    `json:"index"`
	Delay    string `json:"delay,omitempty"`
	Format   string `json:"format"`
	Layer    string `json:"layer,omitempty"`
	Filename string `json:"filename,omitempty"`
}

type tsfInfoOutput struct {
	Path      string         `json:"path"`
	Source    string         `json:"source,omitempty"`
	Animation string         `json:"animation"`
	Looping   string         `json:"looping,omitempty"`
	Frames    int            `json:"frames"`
	FrameList []tsfFrameInfo `json:"frame_list"`
}

func makeTSFInfoHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		doc, rf, closer, err := loadMCPTSF(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer closer()
		if len(doc.Sections) == 0 {
			return errorResult(fmt.Errorf("tsf has no animation section")), nil
		}

		anim := doc.Sections[0]
		frames := anim.Subsections()
		out := tsfInfoOutput{
			Path:      rf.displayPath(),
			Source:    rf.Source,
			Animation: anim.Name,
			Frames:    len(frames),
			FrameList: make([]tsfFrameInfo, 0, len(frames)),
		}
		if v, ok := anim.Get("Looping"); ok {
			out.Looping = v
		}
		for i, fr := range frames {
			delay, _ := fr.Get("Delay")
			format, ok := fr.Get("Format")
			if !ok {
				format = "ARGB4444*"
			}
			info := tsfFrameInfo{Index: i, Delay: delay, Format: format}
			if layers := fr.Subsections(); len(layers) > 0 {
				info.Layer = layers[0].Name
				if fn, ok := layers[0].Get("Filename"); ok {
					info.Filename = fn
				}
			}
			out.FrameList = append(out.FrameList, info)
		}
		return jsonResult(out)
	}
}

type tsfLintOutput struct {
	Path        string          `json:"path"`
	Source      string          `json:"source,omitempty"`
	Clean       bool            `json:"clean"`
	Errors      int             `json:"errors"`
	Diagnostics []tafDiagnostic `json:"diagnostics"`
}

func makeTSFLintHandler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		doc, rf, closer, err := loadMCPTSF(r, req)
		if err != nil {
			return errorResult(err), nil
		}
		defer closer()

		diags := tsf.LintDocument(doc)
		out := tsfLintOutput{
			Path:        rf.displayPath(),
			Source:      rf.Source,
			Clean:       len(diags) == 0,
			Diagnostics: make([]tafDiagnostic, 0, len(diags)),
		}
		for _, d := range diags {
			if d.Level == tsf.LintError {
				out.Errors++
			}
			out.Diagnostics = append(out.Diagnostics, tafDiagnostic{
				Level:   d.Level.String(),
				Frame:   d.Frame,
				Message: d.Message,
			})
		}
		return jsonResult(out)
	}
}

// writeMCPImage anchors output via the resolver and writes the PNG bytes,
// returning the resolved on-disk path.
func writeMCPImage(r *Resolver, output, gameData string, data []byte) (string, error) {
	resolved, err := r.ResolveOutput(output, gameData)
	if err != nil {
		return "", fmt.Errorf("output: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
		return "", fmt.Errorf("create output dir: %w", err)
	}
	if err := os.WriteFile(resolved, data, 0o644); err != nil {
		return "", fmt.Errorf("write output: %w", err)
	}
	return resolved, nil
}
