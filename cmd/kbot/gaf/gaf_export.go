package gaf

import (
	"bytes"
	"fmt"
	"image/gif"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/pcx"
	"github.com/coreprime/kbot-io/palettes"
)

func newGAFExportCommand() *cobra.Command {
	var (
		stream      bool
		target      string
		format      string
		sequence    int
		palettePath string
	)

	cmd := &cobra.Command{
		Use:   "export <file.gaf>",
		Short: "Export a GAF sequence as PNG or GIF",
		Long: `Export one or all sequences from a GAF file.

When --sequence is omitted, the first sequence (index 0) is exported.
Use --format to choose between PNG (animated APNG) and GIF.
Output goes to --target or defaults to <input>.<format>.

By default the embedded TA palette is used, which is correct for Total
Annihilation palettes. TA: Kingdoms ships per-asset palettes in same-named
.pcx sidecars (e.g. anims/actionbuttons.pcx for anims/actionbuttons.gaf)
or side palettes under palettes/{aramon,taros,veruna,zhon,aiden,creon}.pcx.
Point --palette at the .pal or .pcx file that matches the GAF being
exported.

Examples:
  kbot gaf export units.gaf --format gif
  kbot gaf export units.gaf --format png --sequence 3
  kbot gaf export units.gaf --format gif --target walk.gif
  kbot gaf export anims/actionbuttons.gaf --palette anims/actionbuttons.pcx
  kbot gaf export units/araat.gaf --palette palettes/aramon.pcx`,
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

			palette, err := loadGAFRenderPalette(palettePath)
			if err != nil {
				return err
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
	cmd.Flags().StringVar(&palettePath, "palette", "",
		"Palette source: .pal file or .pcx with embedded palette (default: embedded TA palette)")

	return cmd
}

// loadGAFRenderPalette resolves a palette for CLI GAF rendering. When path is
// empty it returns the embedded TA palette (the historical default, correct
// for vanilla TA assets). Otherwise the file extension picks the loader; an
// unrecognised extension is attempted as .pal first then .pcx.
func loadGAFRenderPalette(path string) (*gaf.Palette, error) {
	if path == "" {
		pal, err := gaf.LoadPaletteFromBytes(palettes.DefaultPalette)
		if err != nil {
			return nil, fmt.Errorf("load embedded palette: %w", err)
		}
		return pal, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read palette %s: %w", path, err)
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".pcx":
		return paletteFromPCXBytes(data, path)
	case ".pal":
		return paletteFromPALBytes(data, path)
	}
	// Unknown extension — try PAL first (fixed 1024 bytes), then PCX.
	if pal, err := paletteFromPALBytes(data, path); err == nil {
		return pal, nil
	}
	return paletteFromPCXBytes(data, path)
}

func paletteFromPALBytes(data []byte, src string) (*gaf.Palette, error) {
	pal, err := gaf.LoadPaletteFromBytes(data)
	if err != nil {
		return nil, fmt.Errorf("parse palette %s: %w", src, err)
	}
	return pal, nil
}

func paletteFromPCXBytes(data []byte, src string) (*gaf.Palette, error) {
	r, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("parse palette %s: %w", src, err)
	}
	pal := r.EmbeddedPalette()
	if pal == nil {
		return nil, fmt.Errorf("%s has no embedded palette", src)
	}
	return pal, nil
}
