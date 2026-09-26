// Package outpath maps archive and VFS paths onto files inside an output
// folder without letting any of them land outside it.
//
// Archive entry names are whatever the archive stores. The game treats a
// name such as ".." as an ordinary name (its lookups never climb a
// directory), but a host filesystem does not: joined naively, an entry
// "../../escape.txt" would be written above the output folder, and
// "units/../x.fbi" would be written as "x.fbi".
package outpath

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
)

// Join returns root joined with rel, an archive or VFS path whose segments
// are separated by '/' or '\', when every segment can be written as a file
// or folder of that exact name inside root. It refuses an empty path, an
// absolute path, empty, "." and ".." segments, NUL bytes, and on Windows
// segments holding ':' (a drive or stream name), and double-checks that the
// result stays inside root.
func Join(root, rel string) (string, error) {
	p := strings.ReplaceAll(rel, `\`, "/")
	if p == "" {
		return "", fmt.Errorf("empty path")
	}
	if strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("%q is an absolute path", rel)
	}
	for _, seg := range strings.Split(p, "/") {
		switch {
		case seg == "":
			return "", fmt.Errorf("%q has an empty path segment", rel)
		case seg == "." || seg == "..":
			return "", fmt.Errorf("%q has a %q segment, which cannot be written inside the output folder", rel, seg)
		case strings.IndexByte(seg, 0) >= 0:
			return "", fmt.Errorf("%q contains a NUL byte", rel)
		case runtime.GOOS == "windows" && strings.ContainsRune(seg, ':'):
			return "", fmt.Errorf("%q contains ':', which Windows reads as a drive or stream name", rel)
		}
	}
	out := filepath.Join(root, filepath.FromSlash(p))
	r, err := filepath.Rel(root, out)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) || filepath.IsAbs(r) {
		return "", fmt.Errorf("%q resolves outside the output folder", rel)
	}
	return out, nil
}
