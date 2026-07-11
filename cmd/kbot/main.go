package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/bik"
	"github.com/coreprime/kbot/cmd/kbot/cob"
	"github.com/coreprime/kbot/cmd/kbot/crt"
	"github.com/coreprime/kbot/cmd/kbot/ctx"
	"github.com/coreprime/kbot/cmd/kbot/document"
	"github.com/coreprime/kbot/cmd/kbot/fnt"
	"github.com/coreprime/kbot/cmd/kbot/gaf"
	"github.com/coreprime/kbot/cmd/kbot/hpi"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/cmd/kbot/mcp"
	"github.com/coreprime/kbot/cmd/kbot/mount"
	"github.com/coreprime/kbot/cmd/kbot/pack"
	"github.com/coreprime/kbot/cmd/kbot/pal"
	"github.com/coreprime/kbot/cmd/kbot/pcx"
	"github.com/coreprime/kbot/cmd/kbot/sct"
	"github.com/coreprime/kbot/cmd/kbot/studio"
	"github.com/coreprime/kbot/cmd/kbot/taf"
	"github.com/coreprime/kbot/cmd/kbot/tnt"
	"github.com/coreprime/kbot/cmd/kbot/tsf"
	"github.com/coreprime/kbot/cmd/kbot/zrb"
)

func main() {
	rootCmd := &cobra.Command{
		Use:   "kbot",
		Short: "Total Annihilation asset toolkit",
		Long: `kbot is a unified toolkit for working with Total Annihilation game assets.

Sub-commands operate on specific file formats:
  cob   COB/BOS scripting (compile, decompile, assemble, disassemble)
  crt   TA: Kingdoms .crt scenario files (describe)
  ctx   Manage named working-directory contexts (~/.kbot)
  fnt   Bitmap font files (info, describe, render, sheet, dump)
  gaf   GAF sprite animations (list, export, dump, build)
  hpi   HPI/UFO/CCX archive files (list, extract, pack, info)
  pal   TA palettes and ALP/LHT/SHD lookup tables (info, describe, swatch, convert, lookup)
  pcx   PCX image files (describe, convert, info)
  sct   SCT map sections (info, describe, image, heightmap, minimap)
  taf   TA:K truecolor animations (info, render, export, decompile, compile)
  tnt   TNT map files (describe, unpack, pack, image, heightmap, minimap, ascii)
  tsf   TA:K animation text scripts (info, lint)
  bik      Bink video files — TA: Kingdoms cutscenes (info, to-mp4)
  zrb      Smacker/ZRB video files (info, to-mp4, from-mp4)
  mcp      Run kbot as a Model Context Protocol server
  pack     Extract a game install into a static asset pack
  studio   Web-based map editor (KBot Studio)
  host     Authoritative multiplayer game server
  document Regenerate the TA reference catalogue (units, weapons, build tree)`,
		Version: cli.Version,
	}

	rootCmd.AddCommand(
		cob.NewCommand(),
		crt.NewCommand(),
		ctx.NewCommand(),
		document.NewCommand(),
		fnt.NewCommand(),
		gaf.NewCommand(),
		hpi.NewCommand(),
		pal.NewCommand(),
		pcx.NewCommand(),
		sct.NewCommand(),
		taf.NewCommand(),
		tnt.NewCommand(),
		tsf.NewCommand(),
		bik.NewCommand(),
		zrb.NewCommand(),
		mount.NewCommand(),
		mcp.NewCommand(),
		pack.NewCommand(),
		studio.NewCommand(),
		newHostCommand(),
	)

	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
