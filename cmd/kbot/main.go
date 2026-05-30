package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var Version = "dev"

func main() {
	rootCmd := &cobra.Command{
		Use:   "kbot",
		Short: "Total Annihilation asset toolkit",
		Long: `kbot is a unified toolkit for working with Total Annihilation game assets.

Sub-commands operate on specific file formats:
  cob   COB/BOS scripting (compile, decompile, assemble, disassemble)
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
  zrb      Smacker/ZRB video files (info, to-mp4, from-mp4)
  mcp      Run kbot as a Model Context Protocol server
  studio   Web-based map editor (KBot Studio)
  document Regenerate the TA reference catalogue (units, weapons, build tree)`,
		Version: Version,
	}

	rootCmd.AddCommand(
		newCobCommand(),
		newCtxCommand(),
		newDocumentCommand(),
		newFNTCommand(),
		newGAFCommand(),
		newHPICommand(),
		newPALCommand(),
		newPCXCommand(),
		newSCTCommand(),
		newTAFCommand(),
		newTNTCommand(),
		newTSFCommand(),
		newZRBCommand(),
		newMountCommand(),
		newMCPCommand(),
		newStudioCommand(),
	)

	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
