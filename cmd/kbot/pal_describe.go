package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/pal"
)

func newPALDescribeCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "describe <file.pal>",
		Short: "Show every palette entry with its hex color",
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
			fmt.Printf("PAL File: %s\n", args[0])
			fmt.Printf("File Size: %d bytes\n", info.Size())
			fmt.Printf("Entries: %d  (unique RGB: %d, duplicates: %d)\n",
				pal.EntryCount, unique, dups)
			fmt.Printf("TA-style (zero alpha bytes): %v\n\n", p.IsLikelyTAPalette())

			fmt.Println("Index  Hex      R   G   B")
			fmt.Println("-----  -------  --- --- ---")
			for i := 0; i < pal.EntryCount; i++ {
				c := p.Colors[i]
				marker := ""
				if i == 0 {
					marker = "  (transparent sentinel)"
				}
				fmt.Printf(" %3d   #%02X%02X%02X  %3d %3d %3d%s\n",
					i, c.R, c.G, c.B, c.R, c.G, c.B, marker)
			}
			return nil
		},
	}
}
