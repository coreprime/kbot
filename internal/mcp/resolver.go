package mcp

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Resolver turns the (`path`, `game_data`) arguments that every kbot MCP tool
// accepts into a concrete on-disk path the underlying format loaders can use.
//
// Resolution order for ResolveFile(path, gameData):
//  1. If path exists on disk and passes the PathGuard, return it as-is.
//  2. If a game-data folder is selected, try to interpret path as virtual:
//     a. join(BasePath, path) — handles top-level files like an archive.
//     b. exact virtual-path lookup in the VFS.
//     c. bare-basename lookup across the VFS and the archive index.
//
// Files sourced from inside an archive are extracted to a temp file; the
// returned ResolvedFile.Close() removes it.
type Resolver struct {
	guard    *PathGuard
	registry *Registry
}

// NewResolver wires up the path guard and game-data registry.
func NewResolver(guard *PathGuard, registry *Registry) *Resolver {
	if registry == nil {
		registry = NewRegistry()
	}
	return &Resolver{guard: guard, registry: registry}
}

// Registry returns the underlying game-data registry.
func (r *Resolver) Registry() *Registry { return r.registry }

// PathGuard returns the underlying path guard.
func (r *Resolver) PathGuard() *PathGuard { return r.guard }

// ResolvedFile is the result of a successful ResolveFile call.  Callers must
// Close() it to release any temporary file backing a VFS-extracted hit.
type ResolvedFile struct {
	// LocalPath is an absolute on-disk path the caller can hand to any
	// existing file-based loader.  For VFS hits inside an archive this is
	// a temp file; for everything else it is the real file.
	LocalPath string

	// VirtualPath is the canonical VFS path the hit was found at (empty
	// for direct disk hits).
	VirtualPath string

	// Source describes where the file came from: "disk", an archive name
	// like "totala1.hpi", or "archive" for top-level archive files.
	Source string

	// GameData is the name of the game-data folder this hit resolved
	// against, or "" if the path was resolved directly via the guard.
	GameData string

	cleanup func() error
}

// displayPath returns the most informative path to surface in tool results —
// the virtual path when one is known, otherwise the local on-disk path.
func (rf *ResolvedFile) displayPath() string {
	if rf == nil {
		return ""
	}
	if rf.VirtualPath != "" {
		return rf.VirtualPath
	}
	return rf.LocalPath
}

// Close releases any temp file created for this hit.  Safe to call multiple
// times and on the zero value.
func (rf *ResolvedFile) Close() error {
	if rf == nil || rf.cleanup == nil {
		return nil
	}
	err := rf.cleanup()
	rf.cleanup = nil
	return err
}

// ResolveFile turns (path, gameData) into a usable ResolvedFile.
func (r *Resolver) ResolveFile(path, gameData string) (*ResolvedFile, error) {
	if path == "" {
		return nil, errors.New("path is required")
	}

	// 1. Absolute paths short-circuit through the guard.
	if filepath.IsAbs(path) {
		resolved, err := r.guard.Resolve(path)
		if err != nil {
			return nil, err
		}
		if info, statErr := os.Stat(resolved); statErr == nil && !info.IsDir() {
			return &ResolvedFile{LocalPath: resolved, Source: "disk"}, nil
		}
		// fall through — maybe a relative-looking absolute that's only in a VFS
	}

	gd, err := r.registry.Get(gameData)
	if err != nil {
		return nil, err
	}

	// 2. With a game-data folder, try joining first (matches archives and
	// top-level files the VFS doesn't track as entries).
	if gd != nil && !filepath.IsAbs(path) {
		candidate := filepath.Join(gd.BasePath, path)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			resolved, gerr := r.guard.Resolve(candidate)
			if gerr == nil {
				return &ResolvedFile{
					LocalPath: resolved,
					Source:    "disk",
					GameData:  gd.Name,
				}, nil
			}
		}
	}

	if gd == nil {
		if !filepath.IsAbs(path) {
			return nil, fmt.Errorf("relative path %q given but no --game-data folder is configured", path)
		}
		// Absolute path that didn't exist on disk and no VFS to consult.
		resolved, err := r.guard.Resolve(path)
		if err != nil {
			return nil, err
		}
		return &ResolvedFile{LocalPath: resolved, Source: "disk"}, nil
	}

	// 3a. Exact virtual-path lookup.
	vfs, err := gd.VFS()
	if err != nil {
		return nil, fmt.Errorf("game-data %q: open vfs: %w", gd.Name, err)
	}
	if vfs.Exists(path) && !vfs.IsDir(path) {
		return r.resolveVFSHit(gd, path)
	}

	// 3b. Bare basename — search.
	if !strings.ContainsAny(path, "/\\") {
		hits, err := gd.FindByBasename(path)
		if err != nil {
			return nil, err
		}
		switch len(hits) {
		case 0:
			return nil, fmt.Errorf("file %q not found in game-data %q", path, gd.Name)
		case 1:
			h := hits[0]
			if h.DiskPath != "" {
				resolved, gerr := r.guard.Resolve(h.DiskPath)
				if gerr != nil {
					return nil, gerr
				}
				return &ResolvedFile{
					LocalPath: resolved,
					Source:    h.Source,
					GameData:  gd.Name,
				}, nil
			}
			return r.resolveVFSHit(gd, h.VirtualPath)
		default:
			return nil, fmt.Errorf("%q is ambiguous in game-data %q (%d matches: %s)",
				path, gd.Name, len(hits), summariseHits(hits, 5))
		}
	}

	return nil, fmt.Errorf("path %q not found in game-data %q", path, gd.Name)
}

// ResolveOutput resolves a path that the caller intends to write to.  It
// always returns a real on-disk path that lies inside a mount root.  When a
// game-data folder is selected, relative paths are anchored to its base.
func (r *Resolver) ResolveOutput(path, gameData string) (string, error) {
	if path == "" {
		return "", errors.New("output path is required")
	}
	if !filepath.IsAbs(path) {
		if gd, err := r.registry.Get(gameData); err == nil && gd != nil {
			path = filepath.Join(gd.BasePath, path)
		}
	}
	return r.guard.Resolve(path)
}

// resolveVFSHit returns a ResolvedFile for a VFS path.  When the active layer
// is a physical file we hand back the real on-disk path; when it lives inside
// an archive we extract it to a temp file (necessary because every loader
// takes a file path and HPI readers need a seekable handle).
func (r *Resolver) resolveVFSHit(gd *GameData, virtualPath string) (*ResolvedFile, error) {
	vfs, err := gd.VFS()
	if err != nil {
		return nil, err
	}
	info, err := vfs.Stat(virtualPath)
	if err != nil {
		return nil, err
	}
	if info.IsDir {
		return nil, fmt.Errorf("%q is a directory in game-data %q", virtualPath, gd.Name)
	}
	if info.Source == "disk" {
		diskPath := filepath.Join(gd.BasePath, filepath.FromSlash(virtualPath))
		if _, statErr := os.Stat(diskPath); statErr == nil {
			resolved, gerr := r.guard.Resolve(diskPath)
			if gerr != nil {
				return nil, gerr
			}
			return &ResolvedFile{
				LocalPath:   resolved,
				VirtualPath: virtualPath,
				Source:      "disk",
				GameData:    gd.Name,
			}, nil
		}
	}
	return r.extractFromVFS(gd, virtualPath)
}

// extractFromVFS reads the VFS file at virtualPath and writes it to a temp
// file so existing file-based loaders can open it.
func (r *Resolver) extractFromVFS(gd *GameData, virtualPath string) (*ResolvedFile, error) {
	vfs, err := gd.VFS()
	if err != nil {
		return nil, err
	}

	info, err := vfs.Stat(virtualPath)
	if err != nil {
		return nil, err
	}
	if info.IsDir {
		return nil, fmt.Errorf("%q is a directory in game-data %q", virtualPath, gd.Name)
	}

	rc, err := vfs.Open(virtualPath)
	if err != nil {
		return nil, fmt.Errorf("open virtual file %q: %w", virtualPath, err)
	}
	defer func() { _ = rc.Close() }()

	tmp, err := os.CreateTemp("", "kbot-mcp-*-"+filepath.Base(virtualPath))
	if err != nil {
		return nil, fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() error { return os.Remove(tmpPath) }

	if _, copyErr := io.Copy(tmp, rc); copyErr != nil {
		_ = tmp.Close()
		_ = cleanup()
		return nil, fmt.Errorf("extract virtual file %q: %w", virtualPath, copyErr)
	}
	if closeErr := tmp.Close(); closeErr != nil {
		_ = cleanup()
		return nil, fmt.Errorf("close temp: %w", closeErr)
	}

	return &ResolvedFile{
		LocalPath:   tmpPath,
		VirtualPath: virtualPath,
		Source:      info.Source,
		GameData:    gd.Name,
		cleanup:     cleanup,
	}, nil
}

// ResolvedDir is the result of ResolveDir — a flat list of resolved files
// that match the requested extensions.  Close() releases every backing temp
// file.
type ResolvedDir struct {
	LocalDir string // populated when the directory is a real on-disk dir
	Files    []*ResolvedFile
	Source   string
	GameData string
}

// Close releases every resolved file's temp backing.
func (rd *ResolvedDir) Close() error {
	if rd == nil {
		return nil
	}
	var firstErr error
	for _, f := range rd.Files {
		if err := f.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// ResolveDir resolves a directory-like path.  When path is a real on-disk
// directory, the result lists every file under it with a matching extension.
// When path is a VFS directory, each entry is extracted to a temp file.
// The exts argument is a list of lowercase extensions including the leading
// dot, e.g. []string{".cob"}.
func (r *Resolver) ResolveDir(path, gameData string, exts []string) (*ResolvedDir, error) {
	if path == "" {
		return nil, errors.New("path is required")
	}

	if filepath.IsAbs(path) {
		resolved, err := r.guard.Resolve(path)
		if err != nil {
			return nil, err
		}
		if info, statErr := os.Stat(resolved); statErr == nil && info.IsDir() {
			return r.resolveDiskDir(resolved, exts)
		}
	}

	gd, err := r.registry.Get(gameData)
	if err != nil {
		return nil, err
	}

	if gd != nil && !filepath.IsAbs(path) {
		candidate := filepath.Join(gd.BasePath, path)
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			resolved, gerr := r.guard.Resolve(candidate)
			if gerr != nil {
				return nil, gerr
			}
			rd, derr := r.resolveDiskDir(resolved, exts)
			if derr != nil {
				return nil, derr
			}
			rd.GameData = gd.Name
			return rd, nil
		}
	}

	if gd == nil {
		return nil, fmt.Errorf("relative directory %q given but no --game-data folder is configured", path)
	}

	vfs, err := gd.VFS()
	if err != nil {
		return nil, fmt.Errorf("game-data %q: open vfs: %w", gd.Name, err)
	}

	prefix := strings.Trim(strings.ToLower(filepath.ToSlash(path)), "/")
	if !vfs.IsDir(prefix) && prefix != "" {
		return nil, fmt.Errorf("directory %q not found in game-data %q", path, gd.Name)
	}

	rd := &ResolvedDir{GameData: gd.Name, Source: "vfs"}
	for _, p := range vfs.List() {
		if prefix != "" {
			if !strings.HasPrefix(p, prefix+"/") {
				continue
			}
		}
		if !matchAnyExt(p, exts) {
			continue
		}
		rf, eerr := r.extractFromVFS(gd, p)
		if eerr != nil {
			_ = rd.Close()
			return nil, eerr
		}
		rd.Files = append(rd.Files, rf)
	}
	if len(rd.Files) == 0 {
		_ = rd.Close()
		return nil, fmt.Errorf("no files with extensions %v found under %q in game-data %q",
			exts, path, gd.Name)
	}
	return rd, nil
}

func (r *Resolver) resolveDiskDir(dir string, exts []string) (*ResolvedDir, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read dir: %w", err)
	}
	rd := &ResolvedDir{LocalDir: dir, Source: "disk"}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		full := filepath.Join(dir, e.Name())
		if !matchAnyExt(full, exts) {
			continue
		}
		rd.Files = append(rd.Files, &ResolvedFile{LocalPath: full, Source: "disk"})
	}
	if len(rd.Files) == 0 {
		return nil, fmt.Errorf("no files with extensions %v found under %s", exts, dir)
	}
	return rd, nil
}

func matchAnyExt(path string, exts []string) bool {
	if len(exts) == 0 {
		return true
	}
	ext := strings.ToLower(filepath.Ext(path))
	for _, want := range exts {
		if ext == want {
			return true
		}
	}
	return false
}

func summariseHits(hits []Hit, limit int) string {
	if limit > len(hits) {
		limit = len(hits)
	}
	parts := make([]string, 0, limit)
	for i := 0; i < limit; i++ {
		h := hits[i]
		if h.VirtualPath != "" {
			parts = append(parts, fmt.Sprintf("%s (%s)", h.VirtualPath, h.Source))
		} else {
			parts = append(parts, fmt.Sprintf("%s (%s)", h.DiskPath, h.Source))
		}
	}
	out := strings.Join(parts, ", ")
	if len(hits) > limit {
		out += fmt.Sprintf(", … +%d more", len(hits)-limit)
	}
	return out
}
