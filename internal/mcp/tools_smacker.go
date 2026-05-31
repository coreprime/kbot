package mcp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot/formats/smacker"
)

func registerSmackerTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("zrb_info",
			mcplib.WithDescription(
				"Inspect a Smacker (.zrb/.smk) video — the cutscene format the original "+
					"Total Annihilation ships under data/*.zrb. Returns signature, geometry, "+
					"frame count, frame rate, duration and present audio tracks.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .zrb/.smk file (absolute, virtual, or bare filename)."),
			),
			withGameData(),
		),
		makeZRBInfoHandler(r),
	)

	s.AddTool(
		mcplib.NewTool("zrb_to_mp4",
			mcplib.WithDescription(
				"Decode a Smacker (.zrb/.smk) video to MP4 (H.264/AAC) using FFmpeg, which "+
					"ships a native Smacker decoder. Output paths are anchored to the "+
					"game-data folder when relative.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .zrb/.smk file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithString("output",
				mcplib.Required(),
				mcplib.Description("Destination path for the .mp4 file."),
			),
			withGameData(),
		),
		makeZRBToMP4Handler(r),
	)

	s.AddTool(
		mcplib.NewTool("zrb_from_mp4",
			mcplib.WithDescription(
				"Re-encode an MP4 back to Smacker (.zrb/.smk) using FFmpeg's smackvid/smackaud "+
					"encoders. Best-effort: many FFmpeg builds omit these encoders, in which case "+
					"the tool returns a clear error. Unlike Bink, an open-source Smacker encoder exists.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the source .mp4 file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithString("output",
				mcplib.Required(),
				mcplib.Description("Destination path for the .zrb/.smk file."),
			),
			withGameData(),
		),
		makeZRBFromMP4Handler(r),
	)
}

type zrbAudioTrack struct {
	Track      int    `json:"track"`
	SampleRate uint32 `json:"sample_rate"`
	Channels   uint32 `json:"channels"`
}

type zrbInfoOutput struct {
	Path        string          `json:"path"`
	Source      string          `json:"source,omitempty"`
	Signature   string          `json:"signature"`
	Width       int             `json:"width"`
	Height      int             `json:"height"`
	Frames      int             `json:"frames"`
	FrameRate   float64         `json:"frame_rate"`
	Duration    float64         `json:"duration_seconds"`
	AudioTracks []zrbAudioTrack `json:"audio_tracks"`
}

func makeZRBInfoHandler(r *Resolver) server.ToolHandlerFunc {
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

		reader, err := smacker.OpenReader(rf.LocalPath)
		if err != nil {
			return errorResult(fmt.Errorf("parse smacker: %w", err)), nil
		}
		defer func() { _ = reader.Close() }()

		out := zrbInfoOutput{
			Path:      rf.displayPath(),
			Source:    rf.Source,
			Signature: reader.SignatureString(),
			Width:     reader.Width(),
			Height:    reader.Height(),
			Frames:    reader.FrameCount(),
			FrameRate: reader.FrameRate(),
			Duration:  reader.Duration(),
		}
		h := reader.Header()
		for i := 0; i < len(h.AudioFlags); i++ {
			if h.AudioFlags[i] == 0 {
				continue
			}
			channels := (h.AudioFlags[i] >> 16) & 0xFF
			if channels == 0 {
				channels = 1
			}
			out.AudioTracks = append(out.AudioTracks, zrbAudioTrack{
				Track:      i,
				SampleRate: h.AudioRate[i],
				Channels:   channels,
			})
		}
		return jsonResult(out)
	}
}

type zrbConvertOutput struct {
	Path   string `json:"path"`
	Source string `json:"source,omitempty"`
	Output string `json:"output"`
}

func makeZRBToMP4Handler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		return runZRBConvert(r, req, smacker.ConvertToMP4)
	}
}

func makeZRBFromMP4Handler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		return runZRBConvert(r, req, smacker.ConvertFromMP4)
	}
}

func runZRBConvert(r *Resolver, req mcplib.CallToolRequest, convert func(in, out string) error) (*mcplib.CallToolResult, error) {
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

	if err := convert(rf.LocalPath, resolvedOut); err != nil {
		return errorResult(err), nil
	}

	return jsonResult(zrbConvertOutput{
		Path:   rf.displayPath(),
		Source: rf.Source,
		Output: resolvedOut,
	})
}
