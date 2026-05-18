package main

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/sct"
)

func newSCTInfoCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "info <file.sct>",
		Short: "Print a one-line summary of a section",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read sct: %w", err)
			}
			s, err := sct.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse sct: %w", err)
			}
			fmt.Printf("%s: v%d  %dx%d tiles (%dx%d px)  unique_tiles=%d  height=%v  minimap=%v\n",
				args[0],
				s.Header.Version,
				s.Header.Width, s.Header.Height,
				s.Header.Width*32, s.Header.Height*32,
				len(s.Tiles),
				s.HeightMap != nil,
				s.Minimap != nil,
			)
			return nil
		},
	}
}
