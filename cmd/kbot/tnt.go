package main

import "github.com/spf13/cobra"

func newTNTCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tnt",
		Short: "Work with TNT map files",
		Long: `Inspect, render, unpack, and pack Total Annihilation .TNT map files.

A TNT carries the terrain layer of a map: a header, a tile-index grid,
per-cell elevation and feature placements, the 32x32 tile graphics, a
feature table, and a minimap.  Sister files (.ota for gameplay metadata,
metal/height PCXes) live alongside but are not part of the TNT.`,
	}

	cmd.AddCommand(
		newTNTDescribeCommand(),
		newTNTUnpackCommand(),
		newTNTPackCommand(),
		newTNTImageCommand(),
		newTNTHeightmapCommand(),
		newTNTMinimapCommand(),
		newTNTASCIICommand(),
	)

	return cmd
}
