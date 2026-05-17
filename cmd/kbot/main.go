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
  hpi   HPI/UFO/CCX archive files (list, extract, pack, info)
  pcx   PCX image files (describe, convert, info)
  zrb   Smacker/ZRB video files (info, to-mp4, from-mp4)`,
		Version: Version,
	}

	rootCmd.AddCommand(
		newCobCommand(),
		newGAFCommand(),
		newHPICommand(),
		newPCXCommand(),
		newZRBCommand(),
		newMountCommand(),
	)

	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
