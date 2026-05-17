package main

import (
	"bytes"
	"fmt"
	"image/png"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/tnt"
)

func newTNTImageCommand() *cobra.Command {
	var target string
	cmd := &cobra.Command{
		Use:   "image <file.tnt>",
		Short: "Export the full map as a PNG",
		Long:  `Render the tile grid into a single RGBA PNG image (32px per tile).`,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read tnt: %w", err)
			}
			m, err := tnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}
			pal, err := tntPalette()
			if err != nil {
				return err
			}
			img := m.RenderTileMap(pal)
			out, err := openOutput(target)
			if err != nil {
				return err
			}
			defer closeOutput(out, target)
			if err := png.Encode(out, img); err != nil {
				return fmt.Errorf("encode png: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	return cmd
}

func openOutput(path string) (*os.File, error) {
	if path == "" {
		return os.Stdout, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("create %s: %w", path, err)
	}
	return f, nil
}

func closeOutput(f *os.File, path string) {
	if path != "" {
		_ = f.Close()
	}
}
