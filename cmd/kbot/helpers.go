package main

import (
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// VFSInputHit describes a successful path resolution.
type VFSInputHit struct {
	// Data is the file bytes.
	Data []byte
	// Source is a human-readable label for diagnostics ("./local-edit.tnt",
	// "vfs:maps/the pass.tnt", etc.).
	Source string
	// VirtualPath is the canonical lowercase VFS slot the file was found
	// at (empty when the file came from local disk).  Callers use this
	// to derive sibling files in the same backing store.
	VirtualPath string
}

// resolveVFSInput finds a file the user asked for, trying the local
// filesystem first and then the supplied virtual filesystem.  The
// matching logic mirrors what an OS-level path picker would do:
//
//   - Absolute or cwd-relative paths that resolve to an on-disk file
//     win immediately, regardless of any VFS mount.
//   - Otherwise the argument is normalised (leading "./" stripped,
//     backslashes converted to forward slashes, lowercased) and looked
//     up in the VFS.  Any segment equal to ".." is rejected — relative
//     paths must stay inside the mounted root.
//   - Bare basenames are searched against the VFS as a last resort,
//     restricted to the directory prefix the caller supplies (e.g.
//     "maps/") so we don't accidentally match a same-named file from
//     a different category.
//
// The wantExt and basenameDirs parameters narrow the search.  Pass an
// empty wantExt to accept any extension; pass nil basenameDirs to
// disable the bare-basename fallback.
func resolveVFSInput(arg string, vfs *filesystem.VirtualFileSystem, wantExt string, basenameDirs []string) (*VFSInputHit, error) {
	if arg == "" {
		return nil, fmt.Errorf("path is required")
	}
	// 1. Local disk first — keeps `./local-edit.tnt` snappy and lets the
	// user point at scratch files outside the install.
	if info, err := os.Stat(arg); err == nil && !info.IsDir() {
		data, rerr := os.ReadFile(arg)
		if rerr != nil {
			return nil, fmt.Errorf("read %s: %w", arg, rerr)
		}
		return &VFSInputHit{Data: data, Source: arg}, nil
	}
	if vfs == nil {
		return nil, fmt.Errorf("read %s: not a local file and no VFS is mounted (try `kbot ctx add` or pass --vfs)", arg)
	}
	normalised, err := normaliseVFSPath(arg)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", arg, err)
	}
	// 2. Exact virtual-path lookup (case-insensitive, VFS keys live lowercase).
	if hit := vfs.Exists(normalised); hit && !vfs.IsDir(normalised) {
		data, rerr := vfs.ReadFile(normalised)
		if rerr != nil {
			return nil, fmt.Errorf("read %s from vfs: %w", normalised, rerr)
		}
		return &VFSInputHit{Data: data, Source: "vfs:" + normalised, VirtualPath: normalised}, nil
	}
	// 3. Bare basename — search the configured prefixes.
	if !strings.ContainsAny(normalised, "/\\") && len(basenameDirs) > 0 {
		target := normalised
		var hits []string
		for _, p := range vfs.List() {
			lower := strings.ToLower(p)
			if !hasAnyPrefix(lower, basenameDirs) {
				continue
			}
			if wantExt != "" && !strings.HasSuffix(lower, wantExt) {
				continue
			}
			if path.Base(lower) == target {
				hits = append(hits, p)
			}
		}
		switch len(hits) {
		case 1:
			data, rerr := vfs.ReadFile(hits[0])
			if rerr != nil {
				return nil, fmt.Errorf("read %s from vfs: %w", hits[0], rerr)
			}
			return &VFSInputHit{Data: data, Source: "vfs:" + hits[0], VirtualPath: hits[0]}, nil
		case 0:
			// fall through to not-found below
		default:
			return nil, fmt.Errorf("read %s: matches %d files in the vfs (%s) — pass a fuller path",
				arg, len(hits), strings.Join(hits, ", "))
		}
	}
	return nil, fmt.Errorf("read %s: not found locally or in the mounted vfs", arg)
}

// normaliseVFSPath rewrites a user-supplied path into the canonical
// lowercase, forward-slash form the VFS uses as keys.  Rejects any
// ".." segments — relative paths can't escape the mount root.
func normaliseVFSPath(p string) (string, error) {
	// Backslashes → forward slashes so Windows-style paths work.
	clean := strings.ReplaceAll(p, "\\", "/")
	// Strip a leading "./" (no-op prefix users routinely add via tab-completion).
	for strings.HasPrefix(clean, "./") {
		clean = clean[2:]
	}
	// Reject leading "/" — VFS paths are always relative to the mount root.
	clean = strings.TrimPrefix(clean, "/")
	// Reject any ".." segments, no matter where they appear.  This is
	// the workspace-escape guard the caller asked for.
	for _, seg := range strings.Split(clean, "/") {
		if seg == ".." {
			return "", fmt.Errorf("path escapes the mount root (%q)", p)
		}
	}
	return strings.ToLower(clean), nil
}

// hasAnyPrefix reports whether s starts with any of the supplied
// prefixes.  Used by resolveVFSInput's basename search to scope the
// walk.
func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// resolveVFSPath returns the working directory a VFS-backed command
// should mount, in priority order: explicit user input, then the
// active kbot context (env override or persisted current).  An empty
// return with a nil error means no path is available and the caller
// should produce its own "path required" diagnostic.
func resolveVFSPath(explicit string) (path, source string, err error) {
	if explicit != "" {
		return explicit, "flag", nil
	}
	cfg, err := kbotctx.Load()
	if err != nil {
		return "", "", err
	}
	alias, ctx, src, ok := cfg.Active()
	if !ok {
		if alias != "" && src == "env" {
			return "", "", fmt.Errorf("%s=%s names an unknown kbot context (run `kbot ctx list`)", kbotctx.EnvVar, alias)
		}
		return "", "", nil
	}
	label := fmt.Sprintf("context %q", alias)
	if src == "env" {
		label = fmt.Sprintf("context %q (via %s)", alias, kbotctx.EnvVar)
	}
	return ctx.Path, label, nil
}

// reportContextSource prints a short note to stderr about where a
// path argument came from when it wasn't supplied explicitly.  Pass
// the source returned by resolveVFSPath.
func reportContextSource(source string) {
	if source == "" || source == "flag" {
		return
	}
	fmt.Fprintf(os.Stderr, "Using %s\n", source)
}

// hpiInputPath resolves an archive path from args or stdin.
// When stream is true (or no args), stdin is spooled to a temp file because
// the HPI reader requires random-access I/O.  The caller must invoke the
// returned cleanup function to remove the temp file.
func hpiInputPath(args []string, stream bool) (path string, cleanup func(), err error) {
	if !stream && len(args) > 0 {
		return args[0], nil, nil
	}

	stat, _ := os.Stdin.Stat()
	if (stat.Mode() & os.ModeCharDevice) != 0 {
		return "", nil, fmt.Errorf("no input: pass a filename or use --stream with piped data")
	}

	tmp, err := os.CreateTemp("", "kbot-hpi-in-*.hpi")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create temp file: %w", err)
	}

	if _, err := io.Copy(tmp, os.Stdin); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return "", nil, fmt.Errorf("failed to spool stdin: %w", err)
	}
	_ = tmp.Close()

	return tmp.Name(), func() { _ = os.Remove(tmp.Name()) }, nil
}

// readInput returns the raw bytes from either a file argument or stdin.
func readInput(args []string, stream bool) ([]byte, error) {
	if stream || len(args) == 0 {
		stat, _ := os.Stdin.Stat()
		if (stat.Mode() & os.ModeCharDevice) != 0 {
			return nil, fmt.Errorf("no input: pass a filename or use --stream with piped data")
		}
		return io.ReadAll(os.Stdin)
	}

	return os.ReadFile(args[0])
}

// writeTarget writes data to the target path, or stdout when target is empty.
func writeTarget(data []byte, target string) error {
	if target == "" {
		_, err := os.Stdout.Write(data)
		return err
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("failed to create output directory: %w", err)
	}

	if err := os.WriteFile(target, data, 0o644); err != nil {
		return fmt.Errorf("failed to write %s: %w", target, err)
	}

	fmt.Fprintf(os.Stderr, "Wrote %s\n", target)
	return nil
}
