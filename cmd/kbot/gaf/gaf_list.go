package gaf

import (
	"bytes"
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/gaf"
)

func newGAFListCommand() *cobra.Command {
	var stream bool

	cmd := &cobra.Command{
		Use:   "list <file.gaf>",
		Short: "List sequences in a GAF file",
		Long: `Print a table of all sequences in a GAF file showing the sequence
name, frame count, and total duration.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := cli.ReadInput(args, stream)
			if err != nil {
				return err
			}

			reader, err := gaf.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("failed to parse GAF: %w", err)
			}
			defer func() { _ = reader.Close() }()

			sequences, err := reader.ReadSequences()
			if err != nil {
				return fmt.Errorf("failed to read sequences: %w", err)
			}

			header := reader.Header()
			fmt.Fprintf(os.Stderr, "GAF: %d sequence(s), version 0x%08X\n\n",
				header.SequenceCount, header.Version)

			w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
			_, _ = fmt.Fprintln(w, "#\tName\tFrames\tDuration (ticks)\tDuration (sec)")
			_, _ = fmt.Fprintln(w, "─\t────\t──────\t────────────────\t──────────────")

			totalFrames := 0
			for i, seq := range sequences {
				frames := len(seq.Frames)
				totalFrames += frames
				ticks := uint32(0)
				for _, f := range seq.Frames {
					ticks += f.Duration
				}
				secs := float64(ticks) / 30.0
				_, _ = fmt.Fprintf(w, "%d\t%s\t%d\t%d\t%.2f\n", i, seq.Name, frames, ticks, secs)
			}
			_ = w.Flush()

			fmt.Fprintf(os.Stderr, "\nTotal: %d sequences, %d frames\n", len(sequences), totalFrames)
			return nil
		},
	}

	cmd.Flags().BoolVar(&stream, "stream", false, "Read input from stdin")

	return cmd
}
