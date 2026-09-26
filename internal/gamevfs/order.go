package gamevfs

import "github.com/coreprime/kbot-io/filesystem"

// Directories and extensions of the definition files the game loads by
// enumerating a directory. Features are listed recursively; weapons and
// units only at the top level of their directory.
const (
	FeaturesDir = "features"
	FeaturesExt = ".tdf"
	WeaponsDir  = "weapons"
	WeaponsExt  = ".tdf"
	UnitsDir    = "units"
	UnitsExt    = ".fbi"
)

// GameOrderFiles returns the VFS paths of the files in dir whose names end
// with ext, in the order the game's loaders enumerate them: loose files
// first, then each mounted archive in lookup order with its entries in
// stored order (filesystem.VirtualFileSystem.ListGameOrder). A path held by
// several layers is listed once, at its first position: reading it returns
// the active copy every time, so later repeats define nothing new.
//
// A loader that keeps the first definition of each name, as the game does
// for features, weapons and units, reaches the game's result by reading the
// paths in this order.
//
// recursive includes subdirectories; the game lists features recursively
// and weapons and units non-recursively.
func GameOrderFiles(vfs *filesystem.VirtualFileSystem, dir, ext string, recursive bool) []string {
	if vfs == nil {
		return nil
	}
	entries := vfs.ListGameOrder(dir, ext, recursive)
	seen := make(map[string]bool, len(entries))
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if seen[e.Path] {
			continue
		}
		seen[e.Path] = true
		out = append(out, e.Path)
	}
	return out
}

// FeatureFiles lists features/**/*.tdf in game enumeration order.
func FeatureFiles(vfs *filesystem.VirtualFileSystem) []string {
	return GameOrderFiles(vfs, FeaturesDir, FeaturesExt, true)
}

// WeaponFiles lists weapons/*.tdf (top level only) in game enumeration
// order.
func WeaponFiles(vfs *filesystem.VirtualFileSystem) []string {
	return GameOrderFiles(vfs, WeaponsDir, WeaponsExt, false)
}

// UnitFiles lists units/*.fbi (top level only) in game enumeration order.
func UnitFiles(vfs *filesystem.VirtualFileSystem) []string {
	return GameOrderFiles(vfs, UnitsDir, UnitsExt, false)
}
