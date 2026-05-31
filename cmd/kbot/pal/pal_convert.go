package pal

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/pal"
)

func newPALConvertCommand() *cobra.Command {
	var (
		target string
		format string
		name   string
	)
	cmd := &cobra.Command{
		Use:   "convert <file.pal>",
		Short: "Convert a TA palette to an editor-friendly format",
		Long: `Convert a TA .PAL file to one of:
  - jasc / .pal : the JASC-PAL text format (Paint Shop Pro, GIMP)
  - gpl         : the GIMP Palette format
  - pal         : another TA .PAL (useful for re-emitting after RGB edits)

Format is inferred from the --target extension when omitted; .gpl -> gpl,
.txt or .pal -> jasc (use --format pal to force a binary TA palette).`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			p, err := pal.LoadFromFile(args[0])
			if err != nil {
				return fmt.Errorf("parse pal: %w", err)
			}

			if format == "" {
				switch strings.ToLower(filepath.Ext(target)) {
				case ".gpl":
					format = "gpl"
				case ".txt", ".jasc":
					format = "jasc"
				case ".pal":
					format = "jasc"
				default:
					return fmt.Errorf("--format is required when --target has no recognised extension")
				}
			}

			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)

			switch strings.ToLower(format) {
			case "jasc":
				return p.WriteJASC(out)
			case "gpl":
				return p.WriteGPL(out, name)
			case "pal":
				return p.Write(out)
			default:
				return fmt.Errorf("unknown format %q (jasc, gpl, pal)", format)
			}
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output path (default: stdout)")
	cmd.Flags().StringVar(&format, "format", "", "Output format: jasc, gpl, pal")
	cmd.Flags().StringVar(&name, "name", "TA Palette", "Palette name (gpl only)")
	return cmd
}
