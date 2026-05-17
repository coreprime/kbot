package main

import (
	"bytes"
	"fmt"
	"image/gif"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/formats/gaf"
)

func newGAFExportCommand() *cobra.Command {
	var (
		stream   bool
		target   string
		format   string
		sequence int
	)

	cmd := &cobra.Command{
		Use:   "export <file.gaf>",
		Short: "Export a GAF sequence as PNG or GIF",
		Long: `Export one or all sequences from a GAF file.

When --sequence is omitted, the first sequence (index 0) is exported.
Use --format to choose between PNG (animated APNG) and GIF.
Output goes to --target or defaults to <input>.<format>.

Examples:
  kbot gaf export units.gaf --format gif
  kbot gaf export units.gaf --format png --sequence 3
  kbot gaf export units.gaf --format gif --target walk.gif`,
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

			reader, err := gaf.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("failed to parse GAF: %w", err)
			}
			defer func() { _ = reader.Close() }()

			sequences, err := reader.ReadSequences()
			if err != nil {
				return fmt.Errorf("failed to read sequences: %w", err)
			}

			if sequence < 0 || sequence >= len(sequences) {
				return fmt.Errorf("sequence index %d out of range (0..%d)", sequence, len(sequences)-1)
			}

			palette, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
			if err != nil {
				return fmt.Errorf("failed to load palette: %w", err)
			}

			seq := sequences[sequence]

			// Determine output path.
			outPath := target
			if outPath == "" {
				if len(args) > 0 {
					base := strings.TrimSuffix(args[0], filepath.Ext(args[0]))
					outPath = fmt.Sprintf("%s.%s", base, format)
				} else {
					outPath = fmt.Sprintf("output.%s", format)
				}
			}

			outFile, err := os.Create(outPath)
			if err != nil {
				return fmt.Errorf("failed to create output: %w", err)
			}
			defer func() { _ = outFile.Close() }()

			switch format {
			case "gif":
				g, err := seq.ToGIF(palette)
				if err != nil {
					return fmt.Errorf("GIF conversion failed: %w", err)
				}
				if err := gif.EncodeAll(outFile, g); err != nil {
					return fmt.Errorf("GIF encode failed: %w", err)
				}

			case "png":
				if err := seq.ToAPNG(palette, outFile); err != nil {
					return fmt.Errorf("APNG conversion failed: %w", err)
				}
			}

			fmt.Fprintf(os.Stderr, "Exported sequence %d (%s, %d frames) → %s\n",
				sequence, seq.Name, len(seq.Frames), outPath)
			return nil
		},
	}

	cmd.Flags().BoolVar(&stream, "stream", false, "Read input from stdin")
	cmd.Flags().StringVar(&target, "target", "", "Output file path (default: <input>.<format>)")
	cmd.Flags().StringVar(&format, "format", "gif", "Output format: png or gif")
	cmd.Flags().IntVar(&sequence, "sequence", 0, "Sequence index to export (default: 0)")

	return cmd
}
