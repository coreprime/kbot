package mcp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	mcplib "github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/coreprime/kbot-io/formats/smacker"
)

func registerSmackerTools(s *server.MCPServer, r *Resolver) {
	s.AddTool(
		mcplib.NewTool("zrb_info",
			mcplib.WithDescription(
				"Inspect a Smacker (.zrb/.smk) video — the cutscene format the original "+
					"Total Annihilation ships under data/*.zrb. Returns signature, stored and "+
					"display geometry (the retail 640x240 movies are interlaced and shown as "+
					"640x480), frame count, frame rate, duration and the audio tracks the game "+
					"plays (those with the present bit set), each with sample rate, channels, "+
					"sample size and compression.",
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
					"ships a native Smacker decoder. The MP4 shows the movie as the game does: "+
					"at its display height (an interlaced 640x240 movie becomes 640x480 with "+
					"every second line black) with square pixels. Output paths are anchored to "+
					"the game-data folder when relative.",
			),
			mcplib.WithString("path",
				mcplib.Required(),
				mcplib.Description("Path to the .zrb/.smk file (absolute, virtual, or bare filename)."),
			),
			mcplib.WithString("output",
				mcplib.Required(),
				mcplib.Description("Destination path for the .mp4 file."),
			),
			mcplib.WithBoolean("line_double",
				mcplib.Description("Fill an interlaced movie's extra lines by repeating each line instead of black (default false)."),
			),
			mcplib.WithBoolean("stored_height",
				mcplib.Description("Keep the stored frame height instead of the height the game shows (default false)."),
			),
			withGameData(),
		),
		makeZRBToMP4Handler(r),
	)

	s.AddTool(
		mcplib.NewTool("zrb_from_mp4",
			mcplib.WithDescription(
				"MP4 to Smacker (.zrb/.smk) is not available: no Smacker encoder exists. Stock "+
					"FFmpeg has no smackvid/smackaud encoder and no SMK muxer, and kbot has no Smacker "+
					"writer, so this tool returns an error saying so; it only attempts a conversion "+
					"when the installed FFmpeg lists both a smackvid encoder and an smk muxer. TA "+
					"plays SMK2 movies made with RAD Game Tools' Smacker tools.",
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
	Track         int    `json:"track"`
	SampleRate    uint32 `json:"sample_rate"`
	Channels      int    `json:"channels"`
	BitsPerSample int    `json:"bits_per_sample"`
	Compressed    bool   `json:"compressed"`
}

type zrbInfoOutput struct {
	Path          string          `json:"path"`
	Source        string          `json:"source,omitempty"`
	Signature     string          `json:"signature"`
	Width         int             `json:"width"`
	Height        int             `json:"height"`
	DisplayHeight int             `json:"display_height"`
	HeightMode    string          `json:"height_mode"`
	RingFrame     bool            `json:"ring_frame"`
	Frames        int             `json:"frames"`
	FrameRate     float64         `json:"frame_rate"`
	Duration      float64         `json:"duration_seconds"`
	AudioTracks   []zrbAudioTrack `json:"audio_tracks"`
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
			Path:          rf.displayPath(),
			Source:        rf.Source,
			Signature:     reader.SignatureString(),
			Width:         reader.Width(),
			Height:        reader.Height(),
			DisplayHeight: reader.DisplayHeight(),
			HeightMode:    reader.HeightMode().String(),
			RingFrame:     reader.HasRingFrame(),
			Frames:        reader.FrameCount(),
			FrameRate:     reader.FrameRate(),
			Duration:      reader.Duration(),
			AudioTracks:   []zrbAudioTrack{},
		}
		// Only tracks with the present bit set are played by the game.
		for _, tr := range reader.AudioTracks() {
			out.AudioTracks = append(out.AudioTracks, zrbAudioTrack{
				Track:         tr.Index,
				SampleRate:    tr.SampleRate,
				Channels:      tr.Channels(),
				BitsPerSample: tr.BitsPerSample(),
				Compressed:    tr.Compressed,
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
		opts := smacker.MP4Options{StoredHeight: req.GetBool("stored_height", false)}
		if req.GetBool("line_double", false) {
			opts.Interlace = smacker.InterlaceLineDouble
		}
		return runZRBConvert(r, req, func(in, out string) error {
			return smacker.ConvertToMP4WithOptions(in, out, opts)
		})
	}
}

// errNoSmackerEncoder is what zrb_from_mp4 reports when nothing can write
// Smacker: stock FFmpeg has no Smacker encoder or muxer.
var errNoSmackerEncoder = errors.New("no Smacker encoder is available: FFmpeg has no Smacker encoder or muxer and kbot has no Smacker writer; make SMK2 movies with RAD's Smacker tools")

func makeZRBFromMP4Handler(r *Resolver) server.ToolHandlerFunc {
	return func(_ context.Context, req mcplib.CallToolRequest) (*mcplib.CallToolResult, error) {
		return runZRBConvert(r, req, func(in, out string) error {
			if !smacker.FFmpegAvailable() {
				return errNoSmackerEncoder
			}
			if err := smacker.ConvertFromMP4(in, out); err != nil {
				if errors.Is(err, smacker.ErrNoSmackerWriter) {
					return errNoSmackerEncoder
				}
				return err
			}
			return nil
		})
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
