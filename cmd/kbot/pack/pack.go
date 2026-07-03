// Package pack implements `kbot pack` — extract a game install into a
// static asset pack that @kbot/game3d's HttpPackProvider (and the
// replayer built on it) can consume with no studio server.
package pack

import (
	"fmt"
	"strings"

	"github.com/coreprime/kbot/games"
	"github.com/coreprime/kbot/internal/studio"
	"github.com/spf13/cobra"

	// The shipped games register themselves from their package inits.
	_ "github.com/coreprime/kbot/games/takingdoms"
	_ "github.com/coreprime/kbot/games/totala"
)

var (
	flagGame  string
	flagUnits string
	flagMaps  string
	flagForce bool
)

// gameAliases maps the CLI's short game names onto the games-registry ids.
var gameAliases = map[string]string{
	"ta":         "totala",
	"totala":     "totala",
	"tak":        "takingdoms",
	"takingdoms": "takingdoms",
}

// NewCommand returns the `kbot pack` subcommand.
func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pack <install-dir> <out-dir>",
		Short: "Extract a game install into a static asset pack",
		Long: `Extract a game install (loose files and/or HPI archives) into a static
asset pack: the same JSON/PNG payloads KBot Studio serves on demand,
written once as plain files.  Serve the output directory over any static
HTTP host and point @kbot/game3d's HttpPackProvider at its base URL —
the renderer runs with no studio server.

Pack layout (all filenames lower-case; characters outside [a-z0-9._-]
become "_"):

  manifest.json                game id, sides, unit list, contentHash
                               (formatVersion 3)
  unitdb.json                  per-unit database: pack ordinal id, raw FBI
                               movementClass + derived motionDomain
                               (ground/air/sea/building), build picture +
                               slot-ordered weapon ids, and full stats
                               (buildTime, maxDamage, weapons, economy,
                               footprint, sounds, corpse chain)
  weapons.json                 every weapon in the install keyed by id:
                               render type, palette-resolved colours,
                               projectile model, velocity, beam duration
  palette.json                 {"palette": [[r,g,b] x 256]}
  unitpics/<name>.png          unit build pictures (native size)
  models/<name>.json           model geometry (enhanced mesh baked in)
  textures/<name>.png          model textures (name--<side>.png variants)
  cob/<name>.json              disassembled COB animation scripts
  sounds/<stem>.wav            unit + weapon sound effects
  weaponbitmaps/<weapon>.json  bitmap-projectile sprite strips
  cursors/<sequence>.png       cursor glyphs (APNG when animated)
  groundtiles/<tileset>.png    seamless flat-terrain tiles
  maps/<name>.json             map data (+ .tiles.png / .minimap.png)

Determinism: the same install and options always produce a byte-identical
pack.  manifest.json's contentHash (sha256 over every other file in
sorted path order) is the pack's identity — recordings reference it to
select the matching unit database.

Only assets referenced by the selected units are emitted; --units all
(the default) packs every FBI-defined unit.  Unit ids in unitdb.json are
1-based ordinals over the FULL install's sorted unit list, so a subset
pack keeps the same ids as the full pack.  unitdb.json carries both
unitCount (units in the pack) and gameUnitCount (units in the install);
derivations over the game's whole unit-type table must use the latter.

Maps are opt-in via --maps (TA tile-based maps; TA:Kingdoms maps are not
packed yet).`,
		Example: `  # Pack every unit in a TA install
  kbot pack ~/games/totala ./ta-pack

  # A minimal pack for two units plus one map
  kbot pack ~/games/totala ./ta-pack --units armcom,armpw --maps "greenhaven"

  # TA:Kingdoms
  kbot pack ~/games/kingdoms ./tak-pack --game tak`,
		Args: cobra.ExactArgs(2),
		RunE: runPack,
	}
	cmd.Flags().StringVar(&flagGame, "game", "ta", "game the install contains: ta|tak")
	cmd.Flags().StringVar(&flagUnits, "units", "all", `units to pack: "all" or a comma-separated name list`)
	cmd.Flags().StringVar(&flagMaps, "maps", "", `maps to pack: "all" or a comma-separated base-name list (default none)`)
	cmd.Flags().BoolVar(&flagForce, "force", false, "replace a non-empty output directory")
	return cmd
}

func splitList(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func runPack(_ *cobra.Command, args []string) error {
	gameID, ok := gameAliases[strings.ToLower(strings.TrimSpace(flagGame))]
	if !ok {
		return fmt.Errorf("unknown game %q (expected one of: ta, tak, %s)", flagGame, strings.Join(games.IDs(), ", "))
	}
	opts := studio.PackOptions{
		Game:  gameID,
		Force: flagForce,
	}
	if u := strings.ToLower(strings.TrimSpace(flagUnits)); u != "" && u != "all" {
		opts.Units = splitList(flagUnits)
	}
	if m := strings.TrimSpace(flagMaps); m != "" {
		opts.Maps = splitList(m)
	}

	res, err := studio.BuildPack(args[0], args[1], opts)
	if err != nil {
		return err
	}
	for _, w := range res.Warnings {
		fmt.Printf("warning: %s\n", w)
	}
	fmt.Printf("Packed %d units", len(res.Units))
	if len(res.Maps) > 0 {
		fmt.Printf(", %d maps", len(res.Maps))
	}
	fmt.Printf(" (%d files) into %s\n", res.FileCount, res.OutDir)
	fmt.Printf("contentHash: %s\n", res.Hash)
	return nil
}
