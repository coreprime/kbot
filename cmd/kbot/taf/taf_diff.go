package taf

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tsf"
)

func newTAFDiffCommand() *cobra.Command {
	var vfsRoot string
	cmd := &cobra.Command{
		Use:   "diff <a.taf> <b.taf>",
		Short: "Compare two TAF files",
		Long: `Structurally compare two TAFs: sequence name, frame count and each
frame's dimensions, origin, format, duration and pixel data.  Differences
are printed one per line; the command exits non-zero when the files
differ.

Examples:
  kbot taf diff original.taf rebuilt.taf`,
		Args:          cobra.ExactArgs(2),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, args []string) error {
			a, ha, ca, err := loadTAF(args[0], vfsRoot, true)
			defer ca()
			if err != nil {
				return err
			}
			b, hb, cb, err := loadTAF(args[1], vfsRoot, true)
			defer cb()
			if err != nil {
				return err
			}

			diffs := diffTAF(a, b)
			fmt.Fprintf(os.Stderr, "A: %s (%d frames)\nB: %s (%d frames)\n",
				ha.Source, len(a.Frames), hb.Source, len(b.Frames))
			if len(diffs) == 0 {
				fmt.Fprintln(os.Stderr, "identical: the two animations match")
				return nil
			}
			for _, d := range diffs {
				fmt.Fprintf(os.Stderr, "  %s\n", d)
			}
			return fmt.Errorf("%d difference(s)", len(diffs))
		},
	}
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}

// diffTAF returns human-readable differences between two animations.
func diffTAF(a, b *tsf.TAF) []string {
	var out []string
	if a.Name != b.Name {
		out = append(out, fmt.Sprintf("name: %q vs %q", a.Name, b.Name))
	}
	if len(a.Frames) != len(b.Frames) {
		out = append(out, fmt.Sprintf("frame count: %d vs %d", len(a.Frames), len(b.Frames)))
	}
	n := len(a.Frames)
	if len(b.Frames) < n {
		n = len(b.Frames)
	}
	for i := 0; i < n; i++ {
		fa, fb := a.Frames[i], b.Frames[i]
		if fa.Width != fb.Width || fa.Height != fb.Height {
			out = append(out, fmt.Sprintf("frame %d size: %dx%d vs %dx%d", i, fa.Width, fa.Height, fb.Width, fb.Height))
		}
		if fa.OriginX != fb.OriginX || fa.OriginY != fb.OriginY {
			out = append(out, fmt.Sprintf("frame %d origin: %d,%d vs %d,%d", i, fa.OriginX, fa.OriginY, fb.OriginX, fb.OriginY))
		}
		if fa.Format != fb.Format {
			out = append(out, fmt.Sprintf("frame %d format: %s vs %s", i, fa.Format, fb.Format))
		}
		if fa.Duration != fb.Duration {
			out = append(out, fmt.Sprintf("frame %d duration: %d vs %d", i, fa.Duration, fb.Duration))
		}
		if !bytes.Equal(fa.Pixels, fb.Pixels) {
			out = append(out, fmt.Sprintf("frame %d pixels differ", i))
		}
	}
	return out
}
