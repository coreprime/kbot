package mcp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot-io/formats/bik"
)

func registerBIKTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("bik_info",
			mcplib.WithDescription(
				"Inspect a Bink (.bik) video — the cutscene format TA: Kingdoms uses "+
					"instead of Smacker/ZRB. Returns geometry, frame count, frame rate, "+
					"duration, alpha/grayscale flags and per-track audio details.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .bik file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeBIKInfoHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("bik_to_mp4",
			mcplib.WithDescription(
				"Decode a Bink (.bik) video to MP4 (H.264/AAC) using FFmpeg. Decode-only: "+
					"no Bink encoder exists outside RAD's tools, so there is no reverse "+
					"conversion. Output paths are anchored to the game-data folder when relative.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .bik file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithString("output",
				mcplib.Required(),
				mcplib.Description("Destination path for the .mp4 file."),
			),
			withGameData(),
		),
		makeBIKToMP4Handler(r),
	)
}

type bikAudioTrack struct {
	SampleRate int    `json:"sample_rate"`
	Channels   int    `json:"channels"`
	Bits       int    `json:"bits"`
	Codec      string `json:"codec"`
}

type bikInfoOutput struct {
	Path        string          `json:"path"`
	Source      string          `json:"source,omitempty"`
	Version     string          `json:"version"`
	Width       int             `json:"width"`
	Height      int             `json:"height"`
	Frames      int             `json:"frames"`
	FrameRate   float64         `json:"frame_rate"`
	Duration    float64         `json:"duration_seconds"`
	Alpha       bool            `json:"alpha"`
	Grayscale   bool            `json:"grayscale"`
	AudioTracks []bikAudioTrack `json:"audio_tracks"`
}

func makeBIKInfoHandler(r *Resolver) server.ToolHandlerFunc {
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

		reader, err := bik.OpenReader(rf.LocalPath)
		if err != nil {
			return errorResult(fmt.Errorf("parse bik: %w", err)), nil
		}
		defer func() { _ = reader.Close() }()

		out := bikInfoOutput{
			Path:      rf.displayPath(),
			Source:    rf.Source,
			Version:   reader.Version(),
			Width:     reader.Width(),
			Height:    reader.Height(),
			Frames:    reader.FrameCount(),
			FrameRate: reader.FrameRate(),
			Duration:  reader.Duration(),
			Alpha:     reader.HasAlpha(),
			Grayscale: reader.IsGrayscale(),
		}
		for _, t := range reader.Header().AudioTracks {
			out.AudioTracks = append(out.AudioTracks, bikAudioTrack{
				SampleRate: t.SampleRate,
				Channels:   t.Channels,
				Bits:       t.Bits,
				Codec:      t.Codec,
			})
		}
		return jsonResult(out)
	}
}

type bikToMP4Output struct {
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	Output string `json:"output"`
}

func makeBIKToMP4Handler(r *Resolver) server.ToolHandlerFunc {
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

		resolvedOut, err := r.ResolveOutput(output, gameData)
		if err != nil {
			return errorResult(fmt.Errorf("output: %w", err)), nil
		}
		if err := os.MkdirAll(filepath.Dir(resolvedOut), 0o755); err != nil {
			return errorResult(fmt.Errorf("create output dir: %w", err)), nil
		}

		if err := bik.ConvertToMP4(rf.LocalPath, resolvedOut); err != nil {
			return errorResult(err), nil
		}

		return jsonResult(bikToMP4Output{
			Path:   rf.displayPath(),
			Source: rf.Source,
			Output: resolvedOut,
		})
	}
}
