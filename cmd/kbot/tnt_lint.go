package main

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tnt"
)

func newTNTLintCommand() *cobra.Command {
	var similarity float64
	cmd := &cobra.Command{
		Use:   "lint <file.tnt>",
		Short: "Report size-reduction opportunities in a TNT map",
		Long: `Inspect a TNT file and list redundant tile graphics that
` + "`kbot tnt optimize`" + ` would remove.  Three rules run by default,
mirroring optimize's three passes:

  duplicate-tiles  byte-identical tile graphics
  similar-tiles    visually-similar tile graphics whose placements share
                   the same heightmap footprint (configured by --similarity;
                   set to 0 to skip)
  unused-tiles     tile graphics that no map cell references

The map is not modified.  When at least one issue is reported, the exit
code is 1 so the command can be used in CI; clean maps exit 0.`,
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, args []string) error {
			path := args[0]
			data, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("read tnt: %w", err)
			}
			m, err := tnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}

			opts := tnt.LintOptions{SimilarityPercent: similarity}
			if similarity > 0 {
				pal, palErr := tntPalette()
				if palErr != nil {
					return palErr
				}
				opts.Palette = pal
			}

			diags, err := m.Lint(opts)
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "TNT file:        %s\n", path)
			fmt.Fprintf(os.Stderr, "Tile graphics:   %d\n", len(m.Tiles))
			fmt.Fprintf(os.Stderr, "Map size:        %dx%d cells (%dx%d tiles)\n",
				m.AttrW, m.AttrH, m.TileW, m.TileH)

			if len(diags) == 0 {
				fmt.Fprintln(os.Stderr)
				fmt.Fprintln(os.Stderr, "  ✅  no issues found")
				fmt.Fprintln(os.Stderr)
				return nil
			}

			fmt.Fprintln(os.Stderr)
			totalCount := 0
			totalBytes := 0
			for _, d := range diags {
				icon := severityIcon(d.Severity)
				fmt.Fprintf(os.Stderr, "  %s  %-16s %s\n", icon, d.Rule, d.Message)
				totalCount += d.Count
				totalBytes += d.BytesSaved
			}
			fmt.Fprintln(os.Stderr)
			fmt.Fprintf(os.Stderr,
				"  %d tile graphic%s (%d bytes) could be removed by `kbot tnt optimize`.\n",
				totalCount, sIfPlural(totalCount), totalBytes)
			fmt.Fprintln(os.Stderr)
			return fmt.Errorf("lint found %d issue%s", len(diags), sIfPlural(len(diags)))
		},
	}
	cmd.Flags().Float64Var(&similarity, "similarity", 1.0,
		"Mean per-channel pixel-difference threshold (% of 255) for the similar-tiles rule; 0 disables")
	return cmd
}

func severityIcon(s tnt.LintSeverity) string {
	switch s {
	case tnt.LintWarning:
		return "⚠️"
	default:
		return "ℹ️"
	}
}

func sIfPlural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
