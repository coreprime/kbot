package document

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/internal/documentor"
)

func NewCommand() *cobra.Command {
	var (
		source         string
		target         string
		game           string
		skipPortraits  bool
		forcePortraits bool
	)
	cmd := &cobra.Command{
		Use:   "document",
		Short: "Generate the reference catalogue (units, weapons, build tree) for a TA or TA:K install",
		Long: `Generate the markdown reference catalogue that lives in the standalone
github.com/coreprime/reference-ta and github.com/coreprime/reference-tak
repos.

The command walks a flattened game install, parses every FBI/TDF, and
renders three markdown files plus (for TA) the unit portrait PNGs.

For Total Annihilation (--game totala, default):

  ta-units.md       Unit catalogue (grouped by side / role)
  ta-weapons.md     Weapon catalogue + reverse cross-ref
  ta-buildtree.md   Per-builder 2×3 menu grids + reverse index
  img/ta-units/*.png  Every unitpics/*.pcx converted to PNG

For TA: Kingdoms (--game takingdoms):

  tak-units.md      Per-side unit catalogue
  tak-weapons.md    Inline weapons harvested from every FBI
  tak-buildtree.md  Per-builder canbuild/ directory listings

--source defaults to the active kbot context (see "kbot ctx").  --target
is required and should be the local checkout of the reference repo.

Examples:
  kbot document --target ~/go/src/github.com/coreprime/reference-ta
  kbot document --game takingdoms \
                --source ~/tak-flat \
                --target ../reference-tak
  kbot document --target ./reference-ta --force-portraits
`,
		Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			g, err := documentor.ParseGame(game)
			if err != nil {
				return err
			}
			if target == "" {
				return fmt.Errorf("--target is required (e.g. ~/go/src/github.com/coreprime/reference-ta)")
			}
			path, src, err := cli.ResolveVFSPath(source)
			if err != nil {
				return err
			}
			if path == "" {
				return fmt.Errorf("no install path: pass --source or run `kbot ctx use <alias>`")
			}
			cli.ReportContextSource(src)

			opts := documentor.Options{
				Game:                  g,
				Source:                path,
				Target:                target,
				SkipPortraits:         skipPortraits,
				PortraitsSkipExisting: !forcePortraits,
				Logger: func(format string, args ...any) {
					fmt.Fprintf(os.Stderr, format+"\n", args...)
				},
			}
			return documentor.Generate(opts)
		},
	}
	cmd.Flags().StringVar(&source, "source", "", "Flattened install path (defaults to active kbot context)")
	cmd.Flags().StringVar(&target, "target", "", "Output directory (the reference repo root)")
	cmd.Flags().StringVar(&game, "game", "totala", "Game to document: 'totala' or 'takingdoms'")
	cmd.Flags().BoolVar(&skipPortraits, "skip-portraits", false, "Don't regenerate the unit portrait PNGs")
	cmd.Flags().BoolVar(&forcePortraits, "force-portraits", false, "Re-convert every PCX even if a PNG already exists")
	return cmd
}
