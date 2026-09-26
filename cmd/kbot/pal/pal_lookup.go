package pal

import (
	"fmt"
	"image/png"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/pal"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/internal/palettepick"
)

func newPALLookupCommand() *cobra.Command {
	var (
		target      string
		palettePath string
		cellSize    int
		kindFlag    string
	)
	cmd := &cobra.Command{
		Use:   "lookup <file.alp|.lht|.shd>",
		Short: "Render a palette lookup table (.ALP, .SHD, .LHT) as a PNG swatch",
		Long: `Render a TA palette lookup table as a PNG swatch.  Every byte of a table
is a palette index; each cell is filled with the --palette colour its byte
selects (default: the embedded TA palette).  --palette takes a .pal or a
.pcx; TA: Kingdoms keeps most of its palettes in PCX files next to their
tables (palettes/aramon.pcx for palettes/aramon.alp).  Columns are the 256
source colours:

  .ALP  65,536 bytes, 256 rows: row a, column b is the colour nearest the
        average of colours a and b (a 256x256-cell image)
  .SHD   8,192 bytes, 32 rows: row r darkens or brightens each colour by
        r x 0.06875 (256x32 cells)
  .LHT   8,192 bytes, 32 rows: row r brightens each colour by 1 + r/30
        (256x32 cells)

The game uses a table only when its size is exact and rebuilds it from the
palette otherwise, so a file of any other size is rejected.  The kind comes
from the file extension, or from --kind.

Examples:
  kbot pal lookup palettes/palette.alp --palette palettes/palette.pal --target alp.png
  kbot pal lookup palettes/palette.shd --target shd.png
  kbot pal lookup palettes/aramon.lht --palette palettes/aramon.pcx --target lht.png`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			kind, err := lookupKind(args[0], kindFlag)
			if err != nil {
				return err
			}
			f, err := os.Open(args[0])
			if err != nil {
				return fmt.Errorf("read lookup: %w", err)
			}
			table, err := pal.ReadTable(kind, f)
			_ = f.Close()
			if err != nil {
				return fmt.Errorf("read lookup: %w", err)
			}

			var p *pal.Palette
			if palettePath != "" {
				p, err = palettepick.LoadFile(palettePath)
				if err != nil {
					return fmt.Errorf("load palette: %w", err)
				}
			} else {
				p, err = cli.EmbeddedPalette()
				if err != nil {
					return err
				}
			}

			img, err := table.RenderSwatch(p, cellSize)
			if err != nil {
				return err
			}
			out, err := cli.OpenOutput(target)
			if err != nil {
				return err
			}
			defer cli.CloseOutput(out, target)
			return png.Encode(out, img)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output PNG path (default: stdout)")
	cmd.Flags().StringVar(&palettePath, "palette", "", "Optional .pal or .pcx palette for index→RGB mapping")
	cmd.Flags().IntVar(&cellSize, "cell", 4, "Pixel size of each cell")
	cmd.Flags().StringVar(&kindFlag, "kind", "", "Table kind when the extension does not say: alp, shd or lht")
	return cmd
}

// lookupKind picks the table kind from --kind or the file extension.
func lookupKind(path, flag string) (pal.TableKind, error) {
	switch strings.ToLower(strings.TrimPrefix(strings.TrimSpace(flag), ".")) {
	case "":
	case "alp", "alpha":
		return pal.AlphaTable, nil
	case "shd", "shade":
		return pal.ShadeTable, nil
	case "lht", "light":
		return pal.LightTable, nil
	default:
		return 0, fmt.Errorf("--kind must be alp, shd or lht, got %q", flag)
	}
	if k, ok := pal.TableKindFromPath(path); ok {
		return k, nil
	}
	return 0, fmt.Errorf("%s: cannot tell the table kind from the extension; pass --kind alp|shd|lht", path)
}
