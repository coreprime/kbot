package main

import (
	"bytes"
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/internal/tntpreview"
)

func newTNTPreviewCommand() *cobra.Command {
	var (
		target  string
		vfsRoot string
		schema  int
	)
	cmd := &cobra.Command{
		Use:   "preview <file.tnt>",
		Short: "Render the map with start positions and feature sprites overlaid",
		Long: `Render the tile grid like 'kbot tnt image' and, when --vfs points at a
flattened TA install (or any VFS root containing features/ and anims/),
composite each placed feature's sprite onto the map and draw a numbered
circle at every StartPos in the chosen schema (default Schema 0; pass
--schema <n> for a different one).

If --vfs is omitted, the active kbot context (see 'kbot ctx') is used
as the VFS root.  Set KBOT_CONTEXT=<alias> to pick a different
registered context for this invocation.

Without --vfs and without a registered context the output is just the
tile-grid render (no overlays).`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			tntPath := args[0]
			data, err := os.ReadFile(tntPath)
			if err != nil {
				return fmt.Errorf("read tnt: %w", err)
			}
			m, err := tnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}
			features, err := m.LoadFeatures(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("read features: %w", err)
			}

			pal, err := tntPalette()
			if err != nil {
				return err
			}
			base := m.RenderTileMap(pal)

			resolvedRoot, source, err := resolveVFSPath(vfsRoot)
			if err != nil {
				return err
			}
			if resolvedRoot != "" {
				reportContextSource(source)
				vfs, err := filesystem.NewVirtualFileSystem(resolvedRoot, nil)
				if err != nil {
					return fmt.Errorf("mount vfs at %s: %w", resolvedRoot, err)
				}
				defer func() { _ = vfs.Close() }()

				palette, err := vfsOrEmbeddedPalette(vfs)
				if err != nil {
					return err
				}

				// Prefer the on-disk sister .ota so a local edit beats the VFS copy.
				otaText := readOnDiskSisterOTA(tntPath)
				basename := strings.TrimSuffix(filepath.Base(tntPath), filepath.Ext(tntPath))

				stats, err := tntpreview.ComposeWith(base, m, features, vfs, palette, basename, otaText, tntpreview.Options{SchemaIndex: schema})
				if err != nil {
					return err
				}
				fmt.Fprintf(os.Stderr, "Composited %d feature sprites (%d unresolved)\n", stats.SpritesPainted, stats.SpritesMissing)
				if stats.HasSisterOTA {
					fmt.Fprintf(os.Stderr, "Drew %d start position markers\n", stats.StartPositions)
				} else {
					fmt.Fprintln(os.Stderr, "No sister .ota found; skipping start position overlay")
				}
			}

			out, err := openOutput(target)
			if err != nil {
				return err
			}
			defer closeOutput(out, target)
			if err := png.Encode(out, base); err != nil {
				return fmt.Errorf("encode png: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().StringVar(&vfsRoot, "vfs", "",
		"Path to a flattened TA install / VFS root used to resolve feature sprites and the sister .ota (defaults to active kbot context)")
	cmd.Flags().IntVar(&schema, "schema", 0,
		"Schema index whose StartPos markers are drawn (0-based; default 0)")
	return cmd
}

// vfsOrEmbeddedPalette prefers palettes/palette.pal from the VFS, falling
// back to the embedded TA palette so previews still work against minimal VFS
// roots that don't ship a palette file.
func vfsOrEmbeddedPalette(vfs *filesystem.VirtualFileSystem) (*gaf.Palette, error) {
	if data, err := vfs.ReadFile("palettes/palette.pal"); err == nil {
		return gaf.LoadPaletteFromBytes(data)
	}
	return tntPaletteRaw()
}

func tntPaletteRaw() (*gaf.Palette, error) {
	pal, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	if err != nil {
		return nil, fmt.Errorf("load TA palette: %w", err)
	}
	return pal, nil
}

// readOnDiskSisterOTA returns the text of the .ota next to tntPath on disk, or
// "" if no such file exists.  Composing prefers this over the VFS copy so a
// user editing an .ota locally sees their changes.
func readOnDiskSisterOTA(tntPath string) string {
	ext := filepath.Ext(tntPath)
	candidate := strings.TrimSuffix(tntPath, ext) + ".ota"
	if b, err := os.ReadFile(candidate); err == nil {
		return string(b)
	}
	return ""
}
