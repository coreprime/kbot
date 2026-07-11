package tnt

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/tnt"
)

// featureOut is one placed feature instance in the JSON emitted by
// `kbot tnt features`.
type featureOut struct {
	Name   string `json:"name"`
	CellX  int    `json:"cell_x"`
	CellY  int    `json:"cell_y"`
	PixelX int    `json:"pixel_x"`
	PixelY int    `json:"pixel_y"`
}

// featuresDoc is the top-level JSON document for `kbot tnt features`.
type featuresDoc struct {
	Map        string       `json:"map"`
	TAK        bool         `json:"tak"`
	WidthPx    int          `json:"width_px"`
	HeightPx   int          `json:"height_px"`
	Placements []featureOut `json:"placements"`
}

func newTNTFeaturesCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "features <file.tnt>",
		Short: "List every feature placement as JSON",
		Long: `Emit one JSON record per placed feature (name plus cell and
pixel coordinates) for the given map. Works for both Total Annihilation and
TA: Kingdoms maps; pixel coordinates are anchored to the same render produced
by 'kbot tnt image' / 'kbot tnt preview', so they can be used to crop a
feature out of a rendered map.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := args[0]
			data, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("read tnt: %w", err)
			}
			r := bytes.NewReader(data)
			m, err := tnt.LoadFromReader(r)
			if err != nil {
				return fmt.Errorf("parse tnt: %w", err)
			}
			features, err := m.LoadFeatures(bytes.NewReader(data))
			if err != nil {
				return fmt.Errorf("read features: %w", err)
			}

			widthPx, heightPx := m.TileW*32, m.TileH*32
			if m.IsTAK {
				widthPx, heightPx = m.TAKPixelW(), m.TAKPixelH()
			}

			doc := featuresDoc{Map: path, TAK: m.IsTAK, WidthPx: widthPx, HeightPx: heightPx}
			for _, p := range m.GetFeaturePlacements() {
				name := ""
				if p.FeatureIdx >= 0 && p.FeatureIdx < len(features) {
					name = features[p.FeatureIdx].Name
				}
				doc.Placements = append(doc.Placements, featureOut{
					Name:   name,
					CellX:  p.AttrX,
					CellY:  p.AttrY,
					PixelX: p.PixelX,
					PixelY: p.PixelY,
				})
			}

			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", " ")
			return enc.Encode(doc)
		},
	}
}
