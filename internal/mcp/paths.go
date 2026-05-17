// Package mcp exposes kbot's TA format tooling over the Model Context
// Protocol so that AI assistants (Claude Desktop, Cursor, etc.) can
// decompile, lint, inspect and extract Total Annihilation assets.
package mcp

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PathGuard is an allow-list of filesystem roots that MCP tools are
// permitted to read from or write to.  When constructed with no roots
// it is permissive — any absolute path resolves through unchanged.
//
// The intent is that `kbot mcp --mount /path/to/ta-content` constrains
// the model to a single sandbox; running `kbot mcp` with no mounts
// gives ad-hoc access to the whole filesystem, which is convenient
// during local development.
type PathGuard struct {
	roots []string // absolute, cleaned, no trailing separator
}

// NewPathGuard builds a guard from the given roots.  Each root is
// converted to an absolute, symlink-resolved path; relative roots are
// resolved against the current working directory.
func NewPathGuard(roots []string) (*PathGuard, error) {
	g := &PathGuard{}
	for _, r := range roots {
		if r == "" {
			continue
		}
		abs, err := filepath.Abs(r)
		if err != nil {
			return nil, fmt.Errorf("invalid mount root %q: %w", r, err)
		}
		// Resolve symlinks so users can pass either side of a symlink
		// pair without surprising mismatches.  If the root does not
		// exist, fall back to the lexical absolute path so the guard
		// can still be constructed (we'll error later when a tool
		// actually tries to read it).
		if resolved, err := filepath.EvalSymlinks(abs); err == nil {
			abs = resolved
		}
		g.roots = append(g.roots, filepath.Clean(abs))
	}
	return g, nil
}

// Permissive reports whether the guard has no roots configured.
func (g *PathGuard) Permissive() bool {
	return len(g.roots) == 0
}

// Roots returns the configured roots (defensive copy).
func (g *PathGuard) Roots() []string {
	out := make([]string, len(g.roots))
	copy(out, g.roots)
	return out
}

// Resolve returns the cleaned, absolute form of p and validates that it
// lies under one of the configured roots.  An empty input always errors.
//
// Resolution rules:
//   - Relative paths are resolved against the first root, or the cwd
//     if no roots are configured.
//   - Symlinks are followed when the target exists.  When the target
//     does not exist (e.g. an output path the caller intends to create)
//     the lexical absolute path is used and the parent directory is
//     used for containment checking.
func (g *PathGuard) Resolve(p string) (string, error) {
	if p == "" {
		return "", errors.New("path is required")
	}

	// Relative paths are anchored to the first mount root when one
	// is configured.  Without roots we fall back to cwd, which gives
	// developers the same shell-like ergonomics as the rest of kbot.
	if !filepath.IsAbs(p) {
		base := ""
		if len(g.roots) > 0 {
			base = g.roots[0]
		}
		if base != "" {
			p = filepath.Join(base, p)
		}
	}

	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("cannot resolve path %q: %w", p, err)
	}
	abs = filepath.Clean(abs)

	// Follow symlinks where possible to defeat ../ + symlink escapes.
	checkPath := abs
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		checkPath = resolved
	} else {
		// Path may not exist (e.g. an output file we'll create).
		// Walk up to the nearest existing ancestor and use it for
		// containment.  Use forward iteration with a guard so we
		// can't spin if Dir returns the same path repeatedly.
		ancestor := filepath.Dir(abs)
		for ancestor != "" && ancestor != "/" && ancestor != filepath.Dir(ancestor) {
			if info, statErr := os.Stat(ancestor); statErr == nil && info.IsDir() {
				if resolved, err := filepath.EvalSymlinks(ancestor); err == nil {
					rel, _ := filepath.Rel(ancestor, abs)
					checkPath = filepath.Join(resolved, rel)
				}
				break
			}
			ancestor = filepath.Dir(ancestor)
		}
	}

	if g.Permissive() {
		return abs, nil
	}

	for _, root := range g.roots {
		if containedIn(root, checkPath) {
			return abs, nil
		}
	}

	return "", fmt.Errorf("path %q is outside the configured mount roots", p)
}

// containedIn reports whether candidate is the same as root or one of
// its descendants.  Both arguments must be absolute and cleaned.
func containedIn(root, candidate string) bool {
	if root == candidate {
		return true
	}
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	// filepath.Rel returns something starting with ".." when candidate
	// is not below root.
	return !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}
