package taf

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tsf"
)

func newTAFDecompileCommand() *cobra.Command {
	var (
		vfsRoot string
		target  string
		base    string
	)
	cmd := &cobra.Command{
		Use:   "decompile <file.taf>",
		Short: "Explode a TAF into a TSF document plus per-frame PNGs",
		Long: `Decompile a binary TAF into its editable text form: one TSF document
plus one PNG per frame.  Recompiling the result with "kbot taf compile"
reproduces the original bytes exactly, so this is the lossless
round-trip entry point.

The TSF and its images are written into a target directory (created if
needed); image filenames are <base>_<n>.png.

Examples:
  kbot taf decompile frontend.taf --target ./frontend
  kbot taf decompile anims/spark.taf --target ./spark --base spark`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			taf, hit, cleanup, err := loadTAF(args[0], vfsRoot, false)
			defer cleanup()
			if err != nil {
				return err
			}

			if base == "" {
				base = strings.TrimSuffix(filepath.Base(hit.Source), filepath.Ext(hit.Source))
			}
			if target == "" {
				target = base
			}
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("create output dir: %w", err)
			}

			doc, images, err := tsf.Decompile(taf, base)
			if err != nil {
				return err
			}

			tsfPath := filepath.Join(target, base+".tsf")
			if err := os.WriteFile(tsfPath, []byte(doc.String()), 0o644); err != nil {
				return fmt.Errorf("write tsf: %w", err)
			}
			for _, img := range images {
				p := filepath.Join(target, img.Name)
				if err := os.WriteFile(p, img.Data, 0o644); err != nil {
					return fmt.Errorf("write %s: %w", img.Name, err)
				}
			}

			fmt.Fprintf(os.Stderr, "Decompiled %d frame(s) → %s (+ %d PNG layer(s))\n",
				len(taf.Frames), tsfPath, len(images))
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output directory (default: the TAF base name)")
	cmd.Flags().StringVar(&base, "base", "", "Base name for the .tsf and image files (default: derived from input)")
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}
