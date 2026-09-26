// Package gamevfs is the one place kbot decides how a game install is
// mounted as a virtual filesystem. Every command, the studio and the MCP
// server mount through it, so they all resolve a path to the same archive.
//
// Total Annihilation installs are mounted the way TA 3.1c mounts them
// (kbot-io's game-order discovery): only the top level of the game
// directory is scanned; rev31.gp3 is mounted first, then every *.ccx, then
// every *.ufo, then the first ten *.hpi that open, each group in ASCII
// upper-case name order; the first mounted archive holding a path wins and
// loose files beat every archive. Archives the game refuses (a missing
// Cavedog trailer, a TA: Kingdoms version 2 archive, an unreadable
// directory) are skipped and reported instead of failing the mount.
//
// A GOG-style install keeps the disc archives (totala3.hpi, totala4.hpi,
// worlds.hpi) in the game directory, and the game reaches them through its
// scan of the disc: after every other archive, with no count limit. When a
// single directory is mounted, it is therefore also scanned as the disc
// root, so those archives mount last, as in the game.
//
// TA: Kingdoms installs keep kbot-io's all-archives overlay order, which
// that game needs (data.hpi overlaid by IPData.hpi). Contexts of unknown or
// custom game use kbot-io's automatic choice: all-archives when every
// archive is a version 2 archive, game order otherwise.
package gamevfs

import (
	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// ArchiveExtensions are the archive extensions kbot mounts.
var ArchiveExtensions = []string{".hpi", ".ccx", ".gp3", ".ufo"}

// excludeExtensions are the non-asset files an install ships next to its
// data (executables, help files, shortcuts, installer databases).
var excludeExtensions = []string{".dll", ".exe", ".ico", ".hlp", ".zip", ".msg", ".dat", ".lnk", ".sdb", ".db", ".ds_store"}

// Discovery returns the archive discovery mode kbot uses for game:
// game order for Total Annihilation, the all-archives overlay for TA:
// Kingdoms, and the automatic choice for custom or unknown games.
func Discovery(game string) filesystem.DiscoveryMode {
	switch game {
	case kbotctx.GameTotalA:
		return filesystem.DiscoveryGameOrder
	case kbotctx.GameTAKingdoms:
		return filesystem.DiscoveryAllArchives
	default:
		return filesystem.DiscoveryAuto
	}
}

// Config returns the VFS configuration for game data of game, mounted from
// the given context directories (highest priority first, as passed to
// filesystem.NewLayered).
//
// When exactly one context directory is given and the game is not TA:
// Kingdoms, that directory is also the disc root (see the package
// documentation). A stack of several context directories gets no disc
// root: kbot-io scans the disc roots once per context directory, which
// would mount the base game's archives again above a higher context.
func Config(game string, contextDirs ...string) *filesystem.Config {
	cfg := &filesystem.Config{
		Extensions:         append([]string(nil), ArchiveExtensions...),
		ExcludeDirectories: []string{"Docs"},
		ExcludeExtensions:  append([]string(nil), excludeExtensions...),
		ExcludePrefixes:    []string{"goggame"},
		SkipErrors:         true,
		Discovery:          Discovery(game),
	}
	if game != kbotctx.GameTAKingdoms && len(contextDirs) == 1 {
		cfg.DiscRoots = []string{contextDirs[0]}
	}
	return cfg
}

// Open mounts a single game directory with Config.
func Open(root, game string) (*filesystem.VirtualFileSystem, error) {
	return filesystem.NewVirtualFileSystem(root, Config(game, root))
}

// OpenLayered mounts a stack of sources (highest priority first) with
// Config for the context directories among them.
func OpenLayered(sources []filesystem.Source, game string) (*filesystem.VirtualFileSystem, error) {
	var dirs []string
	for _, s := range sources {
		if s.Kind == filesystem.SourceContextDir {
			dirs = append(dirs, s.Path)
		}
	}
	return filesystem.NewLayered(sources, Config(game, dirs...))
}

// ChainGame returns the game a context's parent chain holds: the first
// concrete game (not custom) from the context up to its root, or the
// context's own game when the chain has none. It returns "" for an unknown
// alias.
func ChainGame(cfg *kbotctx.Config, alias string) string {
	if cfg == nil {
		return ""
	}
	own := cfg.Contexts[alias].Game
	chain, err := cfg.ResolveChain(alias)
	if err != nil {
		return own
	}
	for _, a := range chain {
		if g := cfg.Contexts[a].Game; g != "" && g != kbotctx.GameCustom {
			return g
		}
	}
	return own
}
