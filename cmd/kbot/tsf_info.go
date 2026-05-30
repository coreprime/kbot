package main

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tsf"
)

func newTSFInfoCommand() *cobra.Command {
	var vfsRoot string
	cmd := &cobra.Command{
		Use:   "info <file.tsf>",
		Short: "Summarise the animation, frames and layers",
		Long: `Parse a TSF document and print its animation name plus a table of every
frame's delay, pixel format and referenced layer image.

Examples:
  kbot tsf info ./frontend/frontend.tsf
  kbot tsf info titlescreen.tsf`,
		Args: cobra.ExactArgs(1),
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
			anim := doc.Sections[0]
			frames := anim.Subsections()

			fmt.Printf("TSF: %s\n", hit.Source)
			fmt.Printf("Animation: %q\n", anim.Name)
			if v, ok := anim.Get("Looping"); ok {
				fmt.Printf("Looping:   %s\n", v)
			}
			fmt.Printf("Frames:    %d\n\n", len(frames))

			w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
			_, _ = fmt.Fprintln(w, "#\tDelay\tFormat\tLayer\tFilename")
			_, _ = fmt.Fprintln(w, "─\t─────\t──────\t─────\t────────")
			for i, fr := range frames {
				delay, _ := fr.Get("Delay")
				format, ok := fr.Get("Format")
				if !ok {
					format = "ARGB4444*"
				}
				layers := fr.Subsections()
				layerName, filename := "—", "—"
				if len(layers) > 0 {
					layerName = layers[0].Name
					if fn, ok := layers[0].Get("Filename"); ok {
						filename = fn
					}
				}
				_, _ = fmt.Fprintf(w, "%d\t%s\t%s\t%s\t%s\n", i, dashIfEmpty(delay), format, layerName, filename)
			}
			return w.Flush()
		},
	}
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}

func dashIfEmpty(s string) string {
	if s == "" {
		return "—"
	}
	return s
}
