package gaf

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

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
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
		Long: `Export every sequence and frame from a GAF file into a directory tree
that "kbot gaf build" reads back.

For each sequence a sub-folder is created containing:
  - Numbered frame files (0.png, 1.png, … or 0.gif, 1.gif, …)
  - An animated file for the full sequence (animated.png or animated.gif)
  - frames.csv: one row per frame with its index, size, origin,
    transparency index (key), duration in game ticks, storage
    (raw or compressed) and the frame header's +11 byte (blend)
  - sequence.csv: the sequence's position in the file, its exact name,
    its loop word (the game loops the sequence when the low byte is
    non-zero) and the unused +4 word

Frames are drawn as the game draws them: a raw frame's pixels equal to its
key and a compressed frame's skipped pixels are transparent, and palette
index 0 is opaque black. Each image keeps its palette indices, so a
re-build gives back the same pixels. Composite (layered) frames are dumped
flattened. A frame with no pixels (width or height 0) has no image; its
frames.csv row carries it.

Directory layout:
  <target>/
    <SequenceName>/
      animated.png
      frames.csv
      sequence.csv
      0.png
      1.png
      ...

Examples:
  kbot gaf dump units.gaf --target ./units_frames
  kbot gaf dump units.gaf --target ./out --format gif`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := cli.ReadInput(args, stream)
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
			for _, w := range reader.Warnings() {
				fmt.Fprintf(os.Stderr, "  ⚠ %s\n", w)
			}

			palette, err := loadGAFRenderPalette(palettePath)
			if err != nil {
				return err
			}

			totalFrames, err := dumpSequences(sequences, palette, target, dumpOptions{
				Format:   format,
				Animated: true,
				Progress: func(seq *gaf.Sequence) {
					fmt.Fprintf(os.Stderr, "  ✓ %s — %d frames\n", seq.Name, len(seq.Frames))
				},
			})
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "\nDumped %d sequences, %d frames → %s\n",
				len(sequences), totalFrames, target)
			return nil
		},
	}

	cmd.Flags().BoolVar(&stream, "stream", false, "Read input from stdin")
	cmd.Flags().StringVar(&target, "target", "", "Output directory (default: <input> without extension)")
	cmd.Flags().StringVar(&format, "format", "png", "Frame format: png or gif")
	cmd.Flags().StringVar(&palettePath, "palette", "",
		"Palette source: .pal file or .pcx with embedded palette (default: embedded TA palette)")

	return cmd
}

// dumpRenderOptions is how dumped frames are drawn: the game's rule (the
// stored key for raw frames, skipped pixels for compressed ones), with
// palette index 0 opaque. The build step relies on it to recover each
// frame's pixels and coverage.
var dumpRenderOptions = gaf.RenderOptions{Mode: gaf.TransparencyModeMetadata}

// dumpOptions controls dumpSequences.
type dumpOptions struct {
	Format   string // "png" or "gif"
	Animated bool   // also write animated.<format> per sequence
	// Progress, when set, is called after each sequence is written.
	Progress func(seq *gaf.Sequence)
}

// dumpSequences writes the dump folder layout "kbot gaf build" reads: one
// sub-folder per sequence holding its frame images, frames.csv and
// sequence.csv. It returns the number of frame images written. A frame with
// no pixels gets no image (frames.csv records it). A frame image that fails
// to encode, or a folder or CSV error, stops the dump: a missing image
// would make the build lose the sequence. An animated preview that fails is
// only reported.
func dumpSequences(sequences []*gaf.Sequence, palette *gaf.Palette, target string, opts dumpOptions) (int, error) {
	totalFrames := 0
	used := map[string]bool{}
	for si, seq := range sequences {
		dirName := safeName(seq.Name)
		if used[strings.ToLower(dirName)] {
			// Two sequences with the same (or same-looking) name would
			// overwrite each other's frames; sequence.csv keeps the real
			// name and position, so the folder name only has to be unique.
			dirName = fmt.Sprintf("%s_%d", dirName, si)
		}
		used[strings.ToLower(dirName)] = true
		seqDir := filepath.Join(target, dirName)
		if err := os.MkdirAll(seqDir, 0o755); err != nil {
			return totalFrames, fmt.Errorf("failed to create directory %s: %w", seqDir, err)
		}

		drawable := false
		for fi, frame := range seq.Frames {
			if frame.Width == 0 || frame.Height == 0 {
				// No image can hold it; frames.csv records the empty frame
				// and the build restores it from there.
				continue
			}
			drawable = true
			framePath := filepath.Join(seqDir, fmt.Sprintf("%d.%s", fi, opts.Format))
			if err := writeFrame(frame, palette, opts.Format, framePath); err != nil {
				return totalFrames, fmt.Errorf("seq %d frame %d: %w", si, fi, err)
			}
			totalFrames++
		}

		if opts.Animated && drawable {
			animPath := filepath.Join(seqDir, "animated."+opts.Format)
			if err := writeAnimated(seq, palette, opts.Format, animPath); err != nil {
				fmt.Fprintf(os.Stderr, "  ⚠ seq %d animated: %v\n", si, err)
			}
		}

		if err := writeFramesCSV(seq, filepath.Join(seqDir, framesCSVName)); err != nil {
			return totalFrames, fmt.Errorf("seq %d: %s: %w", si, framesCSVName, err)
		}
		if err := writeSequenceCSV(seq, si, filepath.Join(seqDir, sequenceCSVName)); err != nil {
			return totalFrames, fmt.Errorf("seq %d: %s: %w", si, sequenceCSVName, err)
		}
		if opts.Progress != nil {
			opts.Progress(seq)
		}
	}
	return totalFrames, nil
}

// safeName makes a sequence name filesystem-safe.
func safeName(name string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_")
	s := r.Replace(name)
	if s == "" || s == "." || s == ".." {
		s = "unnamed"
	}
	return s
}

// writeFrame dumps one frame drawn with the game's transparency rule. The
// image is encoded in memory first, so a frame that cannot be encoded
// leaves no file behind.
func writeFrame(frame *gaf.Frame, palette *gaf.Palette, format, path string) error {
	var buf bytes.Buffer
	switch format {
	case "png":
		if err := frame.ToPNGWith(palette, dumpRenderOptions, &buf); err != nil {
			return err
		}
	case "gif":
		img := frame.ToImageWith(palette, dumpRenderOptions)
		if err := gif.Encode(&buf, img, nil); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported format: %s", format)
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func writeAnimated(seq *gaf.Sequence, palette *gaf.Palette, format, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	switch format {
	case "gif":
		return seq.WriteGIFWith(f, palette, dumpRenderOptions)
	case "png":
		return seq.ToAPNGWith(palette, dumpRenderOptions, f)
	}
	return fmt.Errorf("unsupported format: %s", format)
}

// Names of the per-sequence metadata files in a dump folder.
const (
	framesCSVName   = "frames.csv"
	sequenceCSVName = "sequence.csv"
)

// framesCSVHeader lists the frames.csv columns. The build step looks columns
// up by name, so older dumps without the storage and blend columns still
// build.
var framesCSVHeader = []string{
	"frame", "width", "height", "origin_x", "origin_y", "transparency",
	"duration_ticks", "duration_sec", "storage", "blend",
}

func writeFramesCSV(seq *gaf.Sequence, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	w := csv.NewWriter(f)
	_ = w.Write(framesCSVHeader)
	for i, frame := range seq.Frames {
		_ = w.Write([]string{
			strconv.Itoa(i),
			strconv.Itoa(int(frame.Width)),
			strconv.Itoa(int(frame.Height)),
			strconv.Itoa(int(frame.OriginX)),
			strconv.Itoa(int(frame.OriginY)),
			strconv.Itoa(int(frame.TransparencyIndex)),
			strconv.Itoa(int(frame.Duration)),
			fmt.Sprintf("%.3f", float64(frame.DisplayTicks())/gaf.TicksPerSecond),
			storageName(frame.Storage),
			strconv.Itoa(int(frame.Blend)),
		})
	}
	w.Flush()
	return w.Error()
}

// storageName is the frames.csv spelling of a frame's storage; frames the
// reader loaded are always raw or compressed.
func storageName(s gaf.FrameStorage) string {
	if s == gaf.StorageDefault {
		return ""
	}
	return s.String()
}

// sequenceCSVHeader lists the sequence.csv columns: the sequence's position
// in the file, its exact name, the loop word (+2) and the unused +4 word.
var sequenceCSVHeader = []string{"index", "name", "loop_flags", "unknown4"}

func writeSequenceCSV(seq *gaf.Sequence, index int, path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	w := csv.NewWriter(f)
	_ = w.Write(sequenceCSVHeader)
	_ = w.Write([]string{
		strconv.Itoa(index),
		seq.Name,
		strconv.Itoa(int(seq.LoopFlags)),
		strconv.FormatUint(uint64(seq.Unknown4), 10),
	})
	w.Flush()
	return w.Error()
}
