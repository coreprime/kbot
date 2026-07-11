package pcx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/pcx"
)

func newPCXConvertCommand() *cobra.Command {
	var (
		outputFile string
		format     string
	)

	cmd := &cobra.Command{
		Use:   "convert <input.pcx>",
		Short: "Convert a PCX file to another format",
		Long: `Convert a PCX file to PNG, GIF, or BMP format.

Examples:
  kbot pcx convert input.pcx -o output.png
  kbot pcx convert input.pcx -f gif
  kbot pcx convert input.pcx -o output.bmp`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			inputFile := args[0]

			if format == "" && outputFile != "" {
				switch strings.ToLower(filepath.Ext(outputFile)) {
				case ".png":
					format = "png"
				case ".gif":
					format = "gif"
				case ".bmp":
					format = "bmp"
				default:
					return fmt.Errorf("unknown output format from extension: %s", filepath.Ext(outputFile))
				}
			}
			if format == "" {
				return fmt.Errorf("output format not specified (use -f or -o with extension)")
			}
			if outputFile == "" {
				base := strings.TrimSuffix(inputFile, filepath.Ext(inputFile))
				outputFile = fmt.Sprintf("%s.%s", base, format)
			}

			input, err := os.Open(inputFile)
			if err != nil {
				return fmt.Errorf("failed to open input file: %w", err)
			}
			defer func() { _ = input.Close() }()

			output, err := os.Create(outputFile)
			if err != nil {
				return fmt.Errorf("failed to create output file: %w", err)
			}
			defer func() { _ = output.Close() }()

			fmt.Printf("Converting %s to %s format...\n", inputFile, strings.ToUpper(format))

			switch strings.ToLower(format) {
			case "png":
				err = pcx.ConvertToPNG(output, input)
			case "gif":
				err = pcx.ConvertToGIF(output, input)
			case "bmp":
				err = pcx.ConvertToBMP(output, input)
			default:
				return fmt.Errorf("unsupported format: %s (supported: png, gif, bmp)", format)
			}
			if err != nil {
				return fmt.Errorf("conversion failed: %w", err)
			}

			fmt.Printf("Successfully converted to: %s\n", outputFile)
			return nil
		},
	}

	cmd.Flags().StringVarP(&outputFile, "output", "o", "", "Output file path")
	cmd.Flags().StringVarP(&format, "format", "f", "", "Output format (png, gif, bmp)")

	return cmd
}
