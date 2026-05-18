package mcp

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/coreprime/kbot/filesystem"
)

// GameData represents a single Total Annihilation (or TA: Kingdoms) install
// rooted at BasePath.  The on-demand VirtualFileSystem layers any HPI/UFO/CCX/GP3
// archives found in the tree on top of physical files, mirroring how the game
// itself sees its content.
//
// A GameData also indexes top-level archive files by basename so that callers
// can refer to e.g. "totala1.hpi" without knowing the absolute path.
type GameData struct {
	Name     string
	BasePath string
	// Game and Version are optional metadata copied from the kbot ctx
	// entry the folder was registered from.  They are empty when the
	// folder was registered via --game-data.
	Game    string
	Version string
	// Source records where this registration came from: "flag" for
	// --game-data, "context" for a kbot ctx entry, "" for ad-hoc.
	Source string

	once sync.Once
	vfs  *filesystem.VirtualFileSystem
	err  error

	archiveIndex map[string][]string // lowercase basename -> absolute paths
}

// GameDataOption customises a GameData at construction time.  Used to attach
// metadata (game flavour, version label) sourced from a kbot ctx entry.
type GameDataOption func(*GameData)

// WithGame records the game flavour (totala, takingdoms, custom) for the
// folder.  Surfaced through vfs_game_data and ctx_list.
func WithGame(game string) GameDataOption {
	return func(g *GameData) { g.Game = game }
}

// WithVersion records the version label for the folder.
func WithVersion(version string) GameDataOption {
	return func(g *GameData) { g.Version = version }
}

// WithSource records the registration source ("flag" or "context").
func WithSource(source string) GameDataOption {
	return func(g *GameData) { g.Source = source }
}

// NewGameData constructs an unloaded GameData.  The VFS is built on first use.
func NewGameData(name, basePath string, opts ...GameDataOption) (*GameData, error) {
	if basePath == "" {
		return nil, fmt.Errorf("game data %q: base path is required", name)
	}
	abs, err := filepath.Abs(basePath)
	if err != nil {
		return nil, fmt.Errorf("game data %q: %w", name, err)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("game data %q: %w", name, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("game data %q: %s is not a directory", name, abs)
	}
	gd := &GameData{
		Name:         name,
		BasePath:     filepath.Clean(abs),
		archiveIndex: map[string][]string{},
	}
	for _, opt := range opts {
		opt(gd)
	}
	if err := gd.indexArchives(); err != nil {
		return nil, fmt.Errorf("game data %q: index archives: %w", name, err)
	}
	return gd, nil
}

// VFS returns the lazily-loaded virtual filesystem.  The first call walks the
// game-data tree, opens every archive, and starts background MD5 hashing —
// this can take a few seconds on a full TA install.  Subsequent calls return
// the cached instance.
func (g *GameData) VFS() (*filesystem.VirtualFileSystem, error) {
	g.once.Do(func() {
		g.vfs, g.err = filesystem.NewVirtualFileSystem(g.BasePath, &filesystem.Config{
			Extensions: []string{".hpi", ".ccx", ".gp3", ".ufo"},
			SkipErrors: true,
		})
	})
	return g.vfs, g.err
}

// Close releases the underlying VFS if it was loaded.
func (g *GameData) Close() error {
	if g.vfs == nil {
		return nil
	}
	return g.vfs.Close()
}

// indexArchives walks BasePath and records every .hpi/.ufo/.ccx/.gp3 file by
// lowercase basename so the resolver can find archives the VFS does not
// surface as entries.
func (g *GameData) indexArchives() error {
	return filepath.Walk(g.BasePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // ignore traversal errors; archive lookup is best-effort
		}
		if info.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		switch ext {
		case ".hpi", ".ufo", ".ccx", ".gp3":
			key := strings.ToLower(filepath.Base(path))
			g.archiveIndex[key] = append(g.archiveIndex[key], path)
		}
		return nil
	})
}

// FindArchives returns absolute paths of archives whose basename matches name
// (case-insensitive).  Returns nil if none.
func (g *GameData) FindArchives(name string) []string {
	out := g.archiveIndex[strings.ToLower(name)]
	if len(out) == 0 {
		return nil
	}
	cp := make([]string, len(out))
	copy(cp, out)
	return cp
}

// FindByBasename searches the VFS for files whose final path segment matches
// basename (case-insensitive) and, for archive types, falls back to the
// archive index.  The returned paths are virtual paths inside the VFS, except
// for archive hits which are absolute on-disk paths (since archives are not
// VFS entries).
type Hit struct {
	VirtualPath string // virtual path inside the VFS; empty for archive hits
	DiskPath    string // absolute on-disk path; set for physical files and archives
	Source      string // archive name, "disk", or "archive"
}

// FindByBasename returns every file (and archive) whose final path segment
// matches name, case-insensitively.  Used to answer "where is ARMCOM.bos".
func (g *GameData) FindByBasename(name string) ([]Hit, error) {
	vfs, err := g.VFS()
	if err != nil {
		return nil, err
	}
	want := strings.ToLower(name)
	var hits []Hit
	for _, p := range vfs.List() {
		if strings.ToLower(filepath.Base(p)) == want {
			info, _ := vfs.Stat(p)
			source := "vfs"
			if info != nil {
				source = info.Source
			}
			hits = append(hits, Hit{VirtualPath: p, Source: source})
		}
	}
	for _, archive := range g.FindArchives(name) {
		hits = append(hits, Hit{DiskPath: archive, Source: "archive"})
	}
	return hits, nil
}

// FindByPattern returns every file whose virtual path matches the provided
// shell glob (matched against the full virtual path with filepath.Match
// semantics, case-insensitive).  Archive files matched by basename are also
// included.
func (g *GameData) FindByPattern(pattern string) ([]Hit, error) {
	vfs, err := g.VFS()
	if err != nil {
		return nil, err
	}
	pat := strings.ToLower(pattern)
	var hits []Hit
	for _, p := range vfs.List() {
		if matchGlob(pat, strings.ToLower(p)) {
			info, _ := vfs.Stat(p)
			source := "vfs"
			if info != nil {
				source = info.Source
			}
			hits = append(hits, Hit{VirtualPath: p, Source: source})
		}
	}
	for key, paths := range g.archiveIndex {
		if matchGlob(pat, key) {
			for _, ap := range paths {
				hits = append(hits, Hit{DiskPath: ap, Source: "archive"})
			}
		}
	}
	return hits, nil
}

// matchGlob is filepath.Match against full paths, with two conveniences for
// model-friendly queries: a pattern with no separators matches the basename
// only, and "**" is treated as multi-segment wildcard.
func matchGlob(pattern, candidate string) bool {
	if pattern == "" {
		return false
	}
	if strings.Contains(pattern, "**") {
		// Compare against full path; convert ** to a sentinel filepath.Match
		// cannot produce, then split into substring requirements.
		parts := strings.Split(pattern, "**")
		idx := 0
		for i, part := range parts {
			if part == "" {
				continue
			}
			found := strings.Index(candidate[idx:], strings.Trim(part, "/"))
			if found == -1 {
				return false
			}
			if i == 0 && !strings.HasPrefix(candidate, strings.Trim(part, "/")) {
				return false
			}
			idx += found + len(strings.Trim(part, "/"))
		}
		return true
	}
	if !strings.ContainsAny(pattern, "/\\") {
		ok, _ := filepath.Match(pattern, filepath.Base(candidate))
		return ok
	}
	ok, _ := filepath.Match(pattern, candidate)
	return ok
}
