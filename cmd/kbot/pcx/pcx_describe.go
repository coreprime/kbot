package pcx

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/pcx"
)

func newPCXDescribeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "describe <file.pcx>",
		Short: "Describe a PCX file",
		Long:  `Display detailed information about a PCX file including resolution and bit depth.`,
		Args:  cobra.ExactArgs(1),
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

			return nil
		},
	}
}

func pcxEncodingName(encoding byte) string {
	if encoding == 1 {
		return "RLE (Run-Length Encoding)"
	}
	return fmt.Sprintf("Unknown (%d)", encoding)
}
