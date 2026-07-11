package taf

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/tsf"
)

func newTAFLintCommand() *cobra.Command {
	var vfsRoot string
	cmd := &cobra.Command{
		Use:   "lint <file.taf>",
		Short: "Report structural problems and curiosities",
		Long: `Validate a TAF's structure: frame dimensions, pixel-buffer sizes,
recognised pixel formats and the frame-flag byte.  Findings are printed
one per line; when any error-level finding is present the command exits
non-zero so it can gate CI.

Examples:
  kbot taf lint frontend.taf`,
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, args []string) error {
			taf, hit, cleanup, err := loadTAF(args[0], vfsRoot, false)
			defer cleanup()
			if err != nil {
				return err
			}

			diags := taf.Lint()
			fmt.Fprintf(os.Stderr, "TAF: %s — %d frame(s)\n", hit.Source, len(taf.Frames))
			if len(diags) == 0 {
				fmt.Fprintln(os.Stderr, "clean: no issues found")
				return nil
			}

			errs := 0
			for _, d := range diags {
				loc := "file"
				if d.Frame >= 0 {
					loc = fmt.Sprintf("frame %d", d.Frame)
				}
				fmt.Fprintf(os.Stderr, "  [%s] %s: %s\n", d.Level, loc, d.Message)
				if d.Level == tsf.LintError {
					errs++
				}
			}
			if errs > 0 {
				return fmt.Errorf("%d error-level finding(s)", errs)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}
