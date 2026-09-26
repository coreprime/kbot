package studio

import (
	"github.com/coreprime/kbot/internal/gamevfs"
	"github.com/coreprime/kbot/internal/workspace"
)

// layerView is one layer of a file as the Files tab's Layering view shows
// it: kbot-io's FileLayer fields (PascalCase, as the client already reads
// them) plus where the layer sits in the mount.
type layerView struct {
	Source   string
	Priority int
	Size     int64
	// Kind is "workspace" for the writable overlay, "loose" for a loose
	// file of the install, "archive" for an archive.
	Kind string
	// Mount is the archive's 1-based lookup position among every mounted
	// archive (0 for loose layers).
	Mount int `json:",omitempty"`
	// Note flags an unusual archive position, such as an *.hpi past the
	// ten-archive limit that only the disc-root scan mounts.
	Note string `json:",omitempty"`
}

// fileLayers lists every layer holding vpath, highest priority (the active
// copy) first, annotated with each archive's place in the mount order.
func (sess *Session) fileLayers(vpath string) []layerView {
	rep := gamevfs.Report(sess.vfs)
	pos := rep.Positions()
	notes := make(map[string]string, len(rep.Mounted))
	for _, m := range rep.Mounted {
		if m.Note != "" {
			notes[m.Name] = m.Note
		}
	}
	layers := sess.vfs.GetFileLayers(vpath)
	out := make([]layerView, 0, len(layers))
	for _, l := range layers {
		v := layerView{Source: l.Source, Priority: l.Priority, Size: l.Size}
		switch n, ok := pos[l.Source]; {
		case l.Source == workspace.WorkspaceLabel && sess.workDir != "":
			v.Kind = "workspace"
		case ok:
			v.Kind = "archive"
			v.Mount = n
			v.Note = notes[l.Source]
		default:
			v.Kind = "loose"
		}
		out = append(out, v)
	}
	return out
}

// mountSummary is the mount part of the Files tab's ?stats document.
func (sess *Session) mountSummary() map[string]any {
	rep := gamevfs.Report(sess.vfs)
	return map[string]any{
		"discovery":       rep.Discovery,
		"mountOrder":      rep.Mounted,
		"skippedArchives": rep.Skipped,
	}
}
