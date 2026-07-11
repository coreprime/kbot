package fnt

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/fnt"
)

func newFNTInfoCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "info <file.fnt>",
		Short: "Print a one-line summary of a font",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read fnt: %w", err)
			}
			f, err := fnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse fnt: %w", err)
			}
			fmt.Printf("%s: height=%d  glyphs=%d  flags=0x%04X\n",
				args[0], f.Height, f.GlyphCount(), f.Flags)
			return nil
		},
	}
}
