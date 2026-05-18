package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/pal"
)

func newPALInfoCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "info <file.pal>",
		Short: "Print a one-line summary of a palette",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			info, err := os.Stat(args[0])
			if err != nil {
				return fmt.Errorf("stat: %w", err)
			}
			p, err := pal.LoadFromFile(args[0])
			if err != nil {
				return fmt.Errorf("parse pal: %w", err)
			}
			unique, dups := p.Histogram()
			fmt.Printf("%s: %d bytes  entries=%d  unique=%d  duplicates=%d  ta_style=%v\n",
				args[0], info.Size(), pal.EntryCount, unique, dups, p.IsLikelyTAPalette())
			return nil
		},
	}
}
