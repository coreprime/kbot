package gamevfs

import (
	"fmt"
	"io"
	"path/filepath"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/hpi"
)

// MountedArchive is one archive in a MountReport, in lookup order.
type MountedArchive struct {
	// Position is the 1-based lookup position: a path held by several
	// archives resolves to the one with the lowest Position.
	Position int    `json:"position"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	// Version is "v1" (Total Annihilation) or "v2" (TA: Kingdoms).
	Version string `json:"version"`
	// Note explains an unusual position, such as an archive past the
	// ten-*.hpi limit that only the disc-root scan mounts.
	Note string `json:"note,omitempty"`
}

// SkippedArchive is an archive file the mount found but did not mount.
type SkippedArchive struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// Reason is kbot-io's short reason code (filesystem.SkipReason), such
	// as "mount-limit", "no-trailer" or "version".
	Reason string `json:"reason"`
	// Detail says why in words.
	Detail string `json:"detail"`
}

// MountReport describes how a VFS was mounted: the discovery mode, the
// archives it mounted in lookup order and the archives it skipped.
type MountReport struct {
	// Discovery is the discovery mode of each context directory, joined
	// with ",": "game-order" or "all-archives".
	Discovery string           `json:"discovery"`
	Mounted   []MountedArchive `json:"mounted"`
	Skipped   []SkippedArchive `json:"skipped"`
}

// discScanNote marks archives past the ten-*.hpi limit that the disc-root
// scan mounts after every other archive.
const discScanNote = "past the ten-*.hpi limit; mounted by the disc-root scan after every other archive"

// Report builds the MountReport of vfs.
//
// kbot-io reports an archive the disc-root scan mounts twice: skipped at
// the ten-*.hpi limit, then mounted. Report lists such an archive once, as
// mounted with a note, and leaves out the disc-root scan's "already
// mounted" entries for archives the directory scan mounted.
func Report(vfs *filesystem.VirtualFileSystem) MountReport {
	rep := MountReport{Mounted: []MountedArchive{}, Skipped: []SkippedArchive{}}
	if vfs == nil {
		return rep
	}
	if d, ok := vfs.Stats()["discovery"].(string); ok {
		rep.Discovery = d
	}
	order := vfs.MountOrder()
	mounted := make(map[string]bool, len(order))
	for _, m := range order {
		mounted[pathKey(m.Path)] = true
	}
	pastLimit := map[string]bool{}
	// The disc-root scan tries the directory's *.hpi files again, so one
	// file can be skipped twice; its last reason is the one that stuck
	// (a file past the limit that then fails to open is skipped for the
	// failure, not the limit).
	skippedAt := map[string]int{}
	for _, s := range vfs.SkippedArchives() {
		key := pathKey(s.Path)
		if mounted[key] {
			if s.Reason == filesystem.SkipMountLimit {
				pastLimit[key] = true
			}
			continue
		}
		if s.Reason == filesystem.SkipAlreadyMounted {
			continue
		}
		entry := SkippedArchive{
			Name:   s.Name,
			Path:   s.Path,
			Reason: string(s.Reason),
			Detail: skipDetail(s),
		}
		if i, seen := skippedAt[key]; seen {
			rep.Skipped[i] = entry
			continue
		}
		skippedAt[key] = len(rep.Skipped)
		rep.Skipped = append(rep.Skipped, entry)
	}
	for i, m := range order {
		entry := MountedArchive{
			Position: i + 1,
			Name:     m.Name,
			Path:     m.Path,
			Version:  versionLabel(m.Version),
		}
		if pastLimit[pathKey(m.Path)] {
			entry.Note = discScanNote
		}
		rep.Mounted = append(rep.Mounted, entry)
	}
	return rep
}

// Positions maps each mounted archive's name to its 1-based lookup
// position. When two context directories mount archives of the same name,
// the higher-priority one keeps the name.
func (r MountReport) Positions() map[string]int {
	out := make(map[string]int, len(r.Mounted))
	for _, m := range r.Mounted {
		if _, seen := out[m.Name]; !seen {
			out[m.Name] = m.Position
		}
	}
	return out
}

// Print writes the report as indented text: the discovery mode, the mounted
// archives in lookup order and the skipped archives with their reasons.
func (r MountReport) Print(w io.Writer) {
	if r.Discovery != "" {
		_, _ = fmt.Fprintf(w, "Archive discovery: %s\n", r.Discovery)
	}
	_, _ = fmt.Fprintf(w, "Mounted archives, in lookup order (%d):\n", len(r.Mounted))
	for _, m := range r.Mounted {
		line := fmt.Sprintf("  %2d. %s", m.Position, m.Name)
		if m.Version != "v1" {
			line += " (" + m.Version + ")"
		}
		if m.Note != "" {
			line += "  - " + m.Note
		}
		_, _ = fmt.Fprintln(w, line)
	}
	if len(r.Skipped) == 0 {
		return
	}
	_, _ = fmt.Fprintf(w, "Not mounted (%d):\n", len(r.Skipped))
	for _, s := range r.Skipped {
		_, _ = fmt.Fprintf(w, "  - %s: %s\n", s.Name, s.Detail)
	}
}

// skipDetail words a skip reason for people; kbot-io's detail for a
// missing trailer quotes the file's last bytes.
func skipDetail(s filesystem.SkippedArchive) string {
	switch s.Reason {
	case filesystem.SkipNoTrailer:
		return "missing the Cavedog copyright trailer, which TA 3.1c requires"
	case filesystem.SkipMountLimit:
		return "past the ten-*.hpi limit: TA 3.1c mounts only the first ten *.hpi archives that open"
	case filesystem.SkipExcluded:
		return "excluded by kbot's mount configuration"
	}
	if s.Detail == "" {
		return string(s.Reason)
	}
	return s.Detail
}

func versionLabel(v uint32) string {
	switch v {
	case hpi.VersionV1:
		return "v1"
	case hpi.VersionV2:
		return "v2"
	default:
		return fmt.Sprintf("0x%X", v)
	}
}

// pathKey compares archive paths from MountOrder and SkippedArchives,
// which kbot-io builds the same way; Clean guards against a stray
// separator difference.
func pathKey(p string) string {
	return filepath.Clean(p)
}
