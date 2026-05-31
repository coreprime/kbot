package tnt

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/tnt"
)

func newTNTImageCommand() *cobra.Command {
	var (
		target   string
		features bool
	)
	cmd := &cobra.Command{
		Use:   "image <file.tnt>",
		Short: "Export the full map as a PNG",
		Long: `Render the full map into a single RGBA PNG.

For TA the tile grid is composited at 32px per tile. TA: Kingdoms terrain
is texture-mapped from external JPGs, so 'tnt image' renders its
self-contained heightmap (greyscale, one pixel per DataUnit); use
'tnt preview --vfs <root>' for the full texture-mapped render with
feature sprites. Pass --features to overlay a marker on every placed
feature.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := os.ReadFile(args[0])
			if err != nil {
				return fmt.Errorf("read tnt: %w", err)
			}
			m, err := tnt.LoadFromReader(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}

			var img image.Image
			if m.IsTAK {
				img, err = renderTAKImage(data, m, features)
			} else {
				var pal color.Palette
				if pal, err = cli.TNTPalette(); err == nil {
					img = m.RenderTileMap(pal)
				}
			}
			if err != nil {
				return err
			}

			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)
			if err := png.Encode(out, img); err != nil {
				return fmt.Errorf("encode png: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().BoolVar(&features, "features", false, "Overlay markers on placed features (TA:K)")
	return cmd
}

// takFeatureMarker maps a feature-name keyword to an overlay colour so the
// --features overlay is legible by category.
var takFeatureMarker = []struct {
	key string
	col color.RGBA
}{
	{"Tree", color.RGBA{220, 30, 30, 255}},
	{"Grass", color.RGBA{230, 220, 40, 255}},
	{"Henge", color.RGBA{60, 90, 255, 255}},
	{"Hut", color.RGBA{230, 60, 230, 255}},
	{"Build", color.RGBA{40, 220, 220, 255}},
	{"Wave", color.RGBA{245, 245, 245, 255}},
	{"Mana", color.RGBA{255, 140, 0, 255}},
}

func takMarkerColor(name string) color.RGBA {
	for _, m := range takFeatureMarker {
		if strings.Contains(name, m.key) {
			return m.col
		}
	}
	return color.RGBA{120, 255, 120, 255}
}

// renderTAKImage renders a TA: Kingdoms map's self-contained heightmap as an
// RGBA image, with an optional per-feature marker overlay.  Markers are placed
// at DataUnit resolution (the heightmap's native scale), so each placement's
// full-resolution pixel is divided down by the DataUnit size.
func renderTAKImage(data []byte, m *tnt.Map, features bool) (image.Image, error) {
	gray := m.RenderTAKHeightmap()
	if gray == nil {
		return nil, fmt.Errorf("TA:K map has no heightmap")
	}
	img := image.NewRGBA(gray.Bounds())
	for y := gray.Bounds().Min.Y; y < gray.Bounds().Max.Y; y++ {
		for x := gray.Bounds().Min.X; x < gray.Bounds().Max.X; x++ {
			v := gray.GrayAt(x, y).Y
			img.SetRGBA(x, y, color.RGBA{v, v, v, 255})
		}
	}
	if !features {
		return img, nil
	}

	names, err := m.LoadFeatures(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("read features: %w", err)
	}
	for _, p := range m.TAKFeaturePlacements() {
		name := ""
		if p.FeatureIdx < len(names) {
			name = names[p.FeatureIdx].Name
		}
		img.SetRGBA(p.PixelX/tnt.TAKDataUnit, p.PixelY/tnt.TAKDataUnit, takMarkerColor(name))
	}
	return img, nil
}
