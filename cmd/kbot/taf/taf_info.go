package taf

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

func newTAFInfoCommand() *cobra.Command {
	var vfsRoot string
	cmd := &cobra.Command{
		Use:   "info <file.taf>",
		Short: "Show the header and a per-frame breakdown",
		Long: `Parse a TAF and print its sequence name plus a table of every frame:
dimensions, render origin, pixel format, duration and the preserved
frame-flag byte.

Examples:
  kbot taf info frontend.taf
  kbot taf info anims/loadscreen.taf`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			taf, hit, cleanup, err := loadTAF(args[0], vfsRoot, false)
			defer cleanup()
			if err != nil {
				return err
			}

			var total uint32
			for _, f := range taf.Frames {
				total += f.Duration
			}

			fmt.Printf("TAF: %s\n", hit.Source)
			fmt.Printf("Sequence:  %q\n", taf.Name)
			fmt.Printf("Frames:    %d\n", len(taf.Frames))
			fmt.Printf("Duration:  %d ticks (%.2fs)\n", total, float64(total)/30.0)
			fmt.Println()

			w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
			_, _ = fmt.Fprintln(w, "#\tSize\tOrigin\tFormat\tDuration\tFlag")
			_, _ = fmt.Fprintln(w, "─\t────\t──────\t──────\t────────\t────")
			for i, f := range taf.Frames {
				_, _ = fmt.Fprintf(w, "%d\t%dx%d\t%d,%d\t%s\t%d\t0x%02X\n",
					i, f.Width, f.Height, f.OriginX, f.OriginY, f.Format, f.Duration, f.FlagByte())
			}
			return w.Flush()
		},
	}
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}
