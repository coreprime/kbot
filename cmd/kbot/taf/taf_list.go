package taf

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/tsf"
)

func newTAFListCommand() *cobra.Command {
	var vfsRoot string
	cmd := &cobra.Command{
		Use:   "list <file.taf>",
		Short: "Print a one-line sequence summary",
		Long: `Summarise a TAF's single animation sequence: name, frame count, total
duration and the pixel format(s) in use.

Examples:
  kbot taf list frontend.taf`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			taf, hit, cleanup, err := loadTAF(args[0], vfsRoot, false)
			defer cleanup()
			if err != nil {
				return err
			}

			var total uint32
			has4444, has1555 := false, false
			for _, f := range taf.Frames {
				total += f.Duration
				switch f.Format {
				case tsf.FormatARGB4444:
					has4444 = true
				case tsf.FormatARGB1555:
					has1555 = true
				}
			}
			format := "—"
			switch {
			case has4444 && has1555:
				format = "ARGB4444+ARGB1555"
			case has4444:
				format = "ARGB4444"
			case has1555:
				format = "ARGB1555"
			}

			fmt.Printf("%s\t%q\t%d frame(s)\t%d ticks (%.2fs)\t%s\n",
				hit.Source, taf.Name, len(taf.Frames), total, float64(total)/30.0, format)
			return nil
		},
	}
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}
