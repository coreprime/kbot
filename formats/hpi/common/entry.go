package common

import (
	"path/filepath"
	"strings"
)

// Entry represents a file or directory in an HPI archive. The same node type
// is produced by both the v1 and v2 readers so callers can walk either tree
// without caring about the on-disk version.
//
// For v1 archives, Size is the file's decompressed size and CompType selects
// the per-file compression scheme used by the multi-chunk file payload.
//
// For v2 archives (TA: Kingdoms), Size is the decompressed size and
// CompressedSize is the on-disk SQSH chunk size; CompressedSize == 0 means the
// payload is stored uncompressed.
type Entry struct {
	Name           string
	IsDir          bool
	Offset         uint32
	Size           uint32
	CompressedSize uint32
	CompType       uint8
	Children       []*Entry
	Parent         *Entry
}

// FullPath returns the full path of this entry.
func (e *Entry) FullPath() string {
	if e.Parent == nil {
		return e.Name
	}
	parentPath := e.Parent.FullPath()
	if parentPath == "" {
		return e.Name
	}
	return filepath.Join(parentPath, e.Name)
}

// Find locates an entry by path, matching component names case-insensitively.
func (e *Entry) Find(path string) *Entry {
	parts := strings.Split(filepath.ToSlash(path), "/")
	current := e

	for _, part := range parts {
		if part == "" {
			continue
		}
		found := false
		for _, child := range current.Children {
			if strings.EqualFold(child.Name, part) {
				current = child
				found = true
				break
			}
		}
		if !found {
			return nil
		}
	}
	return current
}

// Walk traverses the entry tree depth-first, calling fn for each node.
func (e *Entry) Walk(fn func(*Entry) error) error {
	if err := fn(e); err != nil {
		return err
	}
	for _, child := range e.Children {
		if err := child.Walk(fn); err != nil {
			return err
		}
	}
	return nil
}
