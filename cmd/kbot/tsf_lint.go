package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tsf"
)

func newTSFLintCommand() *cobra.Command {
	var vfsRoot string
	cmd := &cobra.Command{
		Use:   "lint <file.tsf>",
		Short: "Check the document matches the compiler's expectations",
		Long: `Validate a TSF document's shape: a single animation section whose frames
each hold exactly one layer with a Filename, and recognised pixel
formats.  Findings print one per line; error-level findings make the
command exit non-zero.

This does not load the referenced layer images — use "kbot taf compile"
to exercise the full pipeline.

Examples:
  kbot tsf lint ./frontend/frontend.tsf`,
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, args []string) error {
			hit, _, cleanup, err := resolveTSFInput(args[0], vfsRoot, false)
			defer cleanup()
			if err != nil {
				return err
			}
			doc, err := tsf.ParseTSF(string(hit.Data))
			if err != nil {
				return fmt.Errorf("parse tsf: %w", err)
			}

			diags := tsf.LintDocument(doc)
			fmt.Fprintf(os.Stderr, "TSF: %s\n", hit.Source)
			if len(diags) == 0 {
				fmt.Fprintln(os.Stderr, "clean: no issues found")
				return nil
			}
			errs := 0
			for _, d := range diags {
				loc := "document"
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
