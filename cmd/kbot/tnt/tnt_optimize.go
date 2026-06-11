package tnt

import (
	"bytes"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/formats/tnt/tak"
)

func newTNTOptimizeCommand() *cobra.Command {
	return buildTNTOptimizeCommand("optimize", false)
}

// newTNTOptimiseCommand registers the British spelling as a hidden
// twin of optimize.  It is fully functional but does not appear in
// `kbot tnt --help`.
func newTNTOptimiseCommand() *cobra.Command {
	return buildTNTOptimizeCommand("optimise", true)
}

func buildTNTOptimizeCommand(name string, hidden bool) *cobra.Command {
	var (
		target     string
		similarity float64
		keepUnused bool
	)
	cmd := &cobra.Command{
		Use:   name + " <file.tnt>",
		Short: "Consolidate duplicate and visually-similar tile graphics in a TNT map",
		Long: `Read a TNT file, identify redundant tile graphics, and write an
optimised copy.

Three passes run by default:

  1. Exact duplicates -- tile graphics that are byte-identical are
     merged into a single tile index.

  2. Visual similarity -- tile graphics whose mean per-channel pixel
     difference (after TA palette lookup) is at or below --similarity
     percent are merged, but only when their tilemap placements share
     the same set of 4-tuple heightmap footprints.  Pass --similarity 0
     to skip this pass.

  3. Unused tiles -- any tile graphic that no cell of the tilemap
     references is dropped.  Pass --keep-unused to retain them.

The on-disk heightmap and feature placements are preserved verbatim;
only the tile graphic list and the tilemap indices are rewritten.

Progress is written to stderr and the optimised TNT to stdout by
default.  Use --target to write the TNT to a file instead.`,
		Args:   cobra.ExactArgs(1),
		Hidden: hidden,
		RunE: func(_ *cobra.Command, args []string) error {
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
			if m.IsTAK {
				// TA:K maps have no tile pool; their optimizable redundancy is
				// the feature-name table (the studio's editor appends entries
				// but never reaps). Compact it and re-emit the 0x4000 stream —
				// the tile-pool flags (--similarity, --keep-unused) don't apply.
				return optimizeTAK(path, data, target)
			}
			features, err := m.LoadFeatures(r)
			if err != nil {
				return fmt.Errorf("read features: %w", err)
			}

			pal, err := cli.TNTPalette()
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "loaded %s: %d tiles, %dx%d cells, %d features\n",
				path, len(m.Tiles), m.AttrW, m.AttrH, len(features))

			stats, err := m.Optimize(tnt.OptimizeOptions{
				SimilarityPercent: similarity,
				Palette:           pal,
				KeepUnused:        keepUnused,
				Progress:          os.Stderr,
			})
			if err != nil {
				return err
			}
			saved := (stats.TilesBefore - stats.TilesAfter) * tnt.TileGfxSize
			fmt.Fprintf(os.Stderr,
				"tiles: %d -> %d  (exact=%d, similar=%d, unused=%d)  saved %d tile bytes\n",
				stats.TilesBefore, stats.TilesAfter,
				stats.ExactMerges, stats.SimilarityMerges, stats.UnusedRemoved,
				saved)

			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)
			if err := m.Save(out, features); err != nil {
				return fmt.Errorf("save tnt: %w", err)
			}
			if target != "" {
				fmt.Fprintf(os.Stderr, "wrote %s\n", target)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "",
		"Output TNT path (default: stdout)")
	cmd.Flags().Float64Var(&similarity, "similarity", 1.0,
		"Maximum mean per-channel pixel difference (% of 255) for visual-similarity merging; 0 disables")
	cmd.Flags().BoolVar(&keepUnused, "keep-unused", false,
		"Keep tile graphics that no map cell references")
	return cmd
}

// optimizeTAK compacts a TA: Kingdoms map's feature-name table (dropping
// entries no grid cell references) and writes the re-encoded 0x4000 stream.
func optimizeTAK(path string, data []byte, target string) error {
	m, err := tak.Decode(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("parse TA:K tnt: %w", err)
	}
	before, after := m.CompactFeatureTable()
	fmt.Fprintf(os.Stderr, "loaded %s: %dx%d DataUnits, %d feature entries\n", path, m.W, m.H, before)
	fmt.Fprintf(os.Stderr, "feature table: %d -> %d entries (%d unused removed)\n", before, after, before-after)
	out, err := cli.OpenOutput(target)
	if err != nil {
		return err
	}
	defer cli.CloseOutput(out, target)
	if err := tak.Encode(out, m); err != nil {
		return fmt.Errorf("encode TA:K tnt: %w", err)
	}
	if target != "" {
		fmt.Fprintf(os.Stderr, "wrote %s\n", target)
	}
	return nil
}
