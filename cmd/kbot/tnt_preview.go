package main

import (
	"bytes"
	"fmt"
	"image/png"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/assets"
)

func newTNTPreviewCommand() *cobra.Command {
	var (
		target  string
		vfsRoot string
	)
	cmd := &cobra.Command{
		Use:   "preview <file.tnt>",
		Short: "Render the map with start positions and feature sprites overlaid",
		Long: `Render the tile grid like 'kbot tnt image' and, when --vfs points at a
flattened TA install (or any VFS root containing features/ and anims/),
composite each placed feature's sprite onto the map and draw a numbered
circle at every Schema_0 StartPos found in the sister .ota.

Without --vfs the output is just the tile-grid render (no overlays).`,
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

			if vfsRoot != "" {
				vfs, err := filesystem.NewVirtualFileSystem(vfsRoot, nil)
				if err != nil {
					return fmt.Errorf("mount vfs at %s: %w", vfsRoot, err)
				}
				defer func() { _ = vfs.Close() }()

				palette, err := vfsOrEmbeddedPalette(vfs)
				if err != nil {
					return err
				}

				cache := newFeatureSpriteCache(vfs, palette)
				painted, missing := compositeFeatureSprites(base, m, features, cache)
				fmt.Fprintf(os.Stderr, "Composited %d feature sprites (%d unresolved)\n", painted, missing)

				if otaText, ok := loadSisterOTA(tntPath, vfs); ok {
					starts := extractStartPositions(otaText)
					drawStartPositionCircles(base, starts, m.TileW*32, m.TileH*32)
					fmt.Fprintf(os.Stderr, "Drew %d start position markers\n", len(starts))
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
		"Path to a flattened TA install / VFS root used to resolve feature sprites and the sister .ota")
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

// tntPaletteRaw mirrors tntPalette but returns the gaf.Palette struct so we
// can pass it into Frame.ToImage.
func tntPaletteRaw() (*gaf.Palette, error) {
	pal, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
	if err != nil {
		return nil, fmt.Errorf("load TA palette: %w", err)
	}
	return pal, nil
}

// loadSisterOTA returns the text of the .ota that lives next to the given
// .tnt — first checking the on-disk directory, then the VFS using the .tnt's
// basename.
func loadSisterOTA(tntPath string, vfs *filesystem.VirtualFileSystem) (string, bool) {
	ext := filepath.Ext(tntPath)
	diskCandidate := strings.TrimSuffix(tntPath, ext) + ".ota"
	if b, err := os.ReadFile(diskCandidate); err == nil {
		return string(b), true
	}
	base := strings.TrimSuffix(filepath.Base(tntPath), ext)
	for _, p := range vfs.List() {
		if !strings.EqualFold(filepath.Ext(p), ".ota") {
			continue
		}
		stem := strings.TrimSuffix(path.Base(p), path.Ext(p))
		if strings.EqualFold(stem, base) {
			if b, err := vfs.ReadFile(p); err == nil {
				return string(b), true
			}
		}
	}
	return "", false
}

// startPos holds one player start position in map pixel coordinates.
type startPos struct {
	Number int
	X, Y   int
}

func extractStartPositions(otaText string) []startPos {
	doc, err := tdf.ParseString(otaText)
	if err != nil {
		return nil
	}
	global := doc.Section("GlobalHeader")
	if global == nil {
		return nil
	}
	var schema0 *tdf.Section
	for _, s := range global.Sections() {
		if strings.EqualFold(s.Name(), "Schema 0") {
			schema0 = s
			break
		}
	}
	if schema0 == nil {
		return nil
	}
	var specials *tdf.Section
	for _, s := range schema0.Sections() {
		if strings.EqualFold(s.Name(), "specials") {
			specials = s
			break
		}
	}
	if specials == nil {
		return nil
	}
	var out []startPos
	for _, sp := range specials.Sections() {
		what := sp.String("specialwhat")
		if !strings.HasPrefix(what, "StartPos") {
			continue
		}
		num := 0
		_, _ = fmt.Sscanf(strings.TrimPrefix(what, "StartPos"), "%d", &num)
		out = append(out, startPos{Number: num, X: sp.Int("XPos"), Y: sp.Int("ZPos")})
	}
	return out
}
