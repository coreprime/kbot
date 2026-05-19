package main

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"image/gif"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/gaf"
)

func newGAFDumpCommand() *cobra.Command {
	var (
		stream      bool
		target      string
		format      string
		palettePath string
	)

	cmd := &cobra.Command{
		Use:   "dump <file.gaf>",
		Short: "Dump all GAF sequences and frames to a folder",
		Long: `Export every sequence and frame from a GAF file into a directory tree.

For each sequence a sub-folder is created containing:
  - Numbered frame files (0.png, 1.png, … or 0.gif, 1.gif, …)
  - An animated file for the full sequence (animated.gif or animated.png)
  - A frames.csv listing frame index, dimensions, origin, transparency,
    and duration in game ticks

Directory layout:
  <target>/
    <SequenceName>/
      animated.gif
      frames.csv
      0.gif
      1.gif
      ...

Examples:
  kbot gaf dump units.gaf --target ./units_frames
  kbot gaf dump units.gaf --target ./out --format png`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := readInput(args, stream)
			if err != nil {
				return err
			}

			format = strings.ToLower(format)
			if format != "png" && format != "gif" {
				return fmt.Errorf("--format must be png or gif")
			}

			if target == "" {
				if len(args) > 0 {
					target = strings.TrimSuffix(args[0], filepath.Ext(args[0]))
				} else {
					target = "gaf_dump"
				}
			}

			reader, err := gaf.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("failed to parse GAF: %w", err)
			}
			defer func() { _ = reader.Close() }()

			sequences, err := reader.ReadSequences()
			if err != nil {
				return fmt.Errorf("failed to read sequences: %w", err)
			}

			palette, err := loadGAFRenderPalette(palettePath)
			if err != nil {
				return err
			}

			totalFrames := 0
			for si, seq := range sequences {
				seqDir := filepath.Join(target, safeName(seq.Name))
				if err := os.MkdirAll(seqDir, 0o755); err != nil {
					return fmt.Errorf("failed to create directory %s: %w", seqDir, err)
				}

				// Write individual frames.
				for fi, frame := range seq.Frames {
					framePath := filepath.Join(seqDir, fmt.Sprintf("%d.%s", fi, format))
					if err := writeFrame(frame, palette, format, framePath); err != nil {
						fmt.Fprintf(os.Stderr, "  ⚠ seq %d frame %d: %v\n", si, fi, err)
						continue
					}
					totalFrames++
				}

				// Write animated sequence.
				animPath := filepath.Join(seqDir, "animated."+format)
				if err := writeAnimated(seq, palette, format, animPath); err != nil {
					fmt.Fprintf(os.Stderr, "  ⚠ seq %d animated: %v\n", si, err)
				}

				// Write frames.csv.
				csvPath := filepath.Join(seqDir, "frames.csv")
				if err := writeFramesCSV(seq, csvPath); err != nil {
					fmt.Fprintf(os.Stderr, "  ⚠ seq %d csv: %v\n", si, err)
				}

				fmt.Fprintf(os.Stderr, "  ✓ %s — %d frames\n", seq.Name, len(seq.Frames))
			}

			fmt.Fprintf(os.Stderr, "\nDumped %d sequences, %d frames → %s\n",
				len(sequences), totalFrames, target)
			return nil
		},
	}

	cmd.Flags().BoolVar(&stream, "stream", false, "Read input from stdin")
	cmd.Flags().StringVar(&target, "target", "", "Output directory (default: <input> without extension)")
	cmd.Flags().StringVar(&format, "format", "gif", "Frame format: png or gif")
	cmd.Flags().StringVar(&palettePath, "palette", "",
		"Palette source: .pal file or .pcx with embedded palette (default: embedded TA palette)")

	return cmd
}

// safeName makes a sequence name filesystem-safe.
func safeName(name string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_")
	s := r.Replace(name)
	if s == "" {
		s = "unnamed"
	}
	return s
}

func writeFrame(frame *gaf.Frame, palette *gaf.Palette, format, path string) error {
	return writeFrameWith(frame, palette, format, path, gaf.RenderOptions{Mode: gaf.TransparencyModeAuto})
}

// writeFrameWith dumps a frame with caller-supplied transparency options.
// Round-trip tests use this with TransparencyModeMetadata so PNG indices
// stay reversible.
func writeFrameWith(frame *gaf.Frame, palette *gaf.Palette, format, path string, opts gaf.RenderOptions) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	switch format {
	case "png":
		return frame.ToPNGWith(palette, opts, f)
	case "gif":
		img := frame.ToImageWith(palette, opts)
		return gif.Encode(f, img, nil)
	}
	return fmt.Errorf("unsupported format: %s", format)
}

func writeAnimated(seq *gaf.Sequence, palette *gaf.Palette, format, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	switch format {
	case "gif":
		g, err := seq.ToGIF(palette)
		if err != nil {
			return err
		}
		return gif.EncodeAll(f, g)
	case "png":
		return seq.ToAPNG(palette, f)
	}
	return fmt.Errorf("unsupported format: %s", format)
}

func writeFramesCSV(seq *gaf.Sequence, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	w := csv.NewWriter(f)
	defer w.Flush()

	_ = w.Write([]string{"frame", "width", "height", "origin_x", "origin_y", "transparency", "duration_ticks", "duration_sec"})

	for i, frame := range seq.Frames {
		_ = w.Write([]string{
			strconv.Itoa(i),
			strconv.Itoa(int(frame.Width)),
			strconv.Itoa(int(frame.Height)),
			strconv.Itoa(int(frame.OriginX)),
			strconv.Itoa(int(frame.OriginY)),
			strconv.Itoa(int(frame.TransparencyIndex)),
			strconv.Itoa(int(frame.Duration)),
			fmt.Sprintf("%.3f", float64(frame.Duration)/30.0),
		})
	}

	return nil
}
