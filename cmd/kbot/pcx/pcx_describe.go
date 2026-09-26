package pcx

import (
	"fmt"
	"io"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/pcx"
)

func newPCXDescribeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "describe <file.pcx>",
		Short: "Describe a PCX file and what TA does with it",
		Long: `Display detailed information about a PCX file including resolution and
bit depth, followed by what Total Annihilation 3.1c will do with it.

The game loads only version 5 files, decodes every file as 8-bit single-plane
data with exactly width bytes per row (BytesPerLine is ignored, so padding
shifts later rows), takes the palette from the last 768 bytes whether or not
a 0x0C marker precedes them, and draws backdrops opaque. Image editors read
such files differently, so a file can look right in kbot's previews and
wrong, or not at all, in the game.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			filename := args[0]

			f, err := os.Open(filename)
			if err != nil {
				return fmt.Errorf("failed to open file: %w", err)
			}
			defer func() { _ = f.Close() }()

			reader, err := pcx.LoadFromReader(f)
			if err != nil {
				return fmt.Errorf("failed to read PCX file: %w", err)
			}

			fileInfo, _ := f.Stat()

			fmt.Printf("PCX File: %s\n", filename)
			fmt.Printf("File Size: %d bytes\n\n", fileInfo.Size())

			header := reader.Header()
			fmt.Printf("Format Information:\n")
			fmt.Printf("  Version: %d\n", header.Version)
			fmt.Printf("  Encoding: %s\n", pcxEncodingName(header.Encoding))
			fmt.Printf("  Dimensions: %dx%d pixels\n", reader.Width(), reader.Height())
			fmt.Printf("  Bits Per Pixel: %d\n", reader.BitsPerPixel())
			fmt.Printf("  Color Planes: %d\n", header.NumPlanes)
			fmt.Printf("  Bytes Per Line: %d\n", header.BytesPerLine)
			fmt.Printf("  DPI: %dx%d\n", header.HorzDPI, header.VertDPI)

			colorType := "Unknown"
			bpp := reader.BitsPerPixel()
			switch {
			case bpp == 1:
				colorType = "Monochrome"
			case bpp == 4:
				colorType = "16-color"
			case bpp == 8 && header.NumPlanes == 1:
				colorType = "256-color (paletted)"
			case bpp == 24 && header.NumPlanes == 3:
				colorType = "True Color (RGB)"
			}
			fmt.Printf("  Color Type: %s\n", colorType)

			fmt.Println()
			printPCXCompat(os.Stdout, reader.Compat())
			return nil
		},
	}
}

// printPCXCompat prints what TA 3.1c will do with the file: whether it
// loads it and every way it draws it differently from a standard reader.
func printPCXCompat(w io.Writer, rep pcx.CompatReport) {
	_, _ = fmt.Fprintln(w, "TA 3.1c:")
	switch {
	case rep.OK():
		_, _ = fmt.Fprintln(w, "  ✓ The game loads this file and draws it as shown.")
		return
	case !rep.GameLoads():
		_, _ = fmt.Fprintln(w, "  ✗ The game will refuse to load this file.")
	default:
		_, _ = fmt.Fprintln(w, "  ⚠ The game will load this file but draw it differently:")
	}
	for _, issue := range rep.Issues {
		mark := "⚠"
		if issue.Severity == pcx.CompatError {
			mark = "✗"
		}
		_, _ = fmt.Fprintf(w, "    %s %s\n", mark, issue.Message)
	}
}

func pcxEncodingName(encoding byte) string {
	if encoding == 1 {
		return "RLE (Run-Length Encoding)"
	}
	return fmt.Sprintf("Unknown (%d)", encoding)
}
