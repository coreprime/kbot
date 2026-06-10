// Package filesystem provides virtual filesystem abstraction for TA archives.
package filesystem

import "io"

// FileSystem provides an abstraction for file operations
type FileSystem interface {
	// Open opens a file for reading
	Open(path string) (io.ReadCloser, error)

	// ReadFile reads the entire contents of a file
	ReadFile(path string) ([]byte, error)

	// Exists checks if a file exists
	Exists(path string) bool

	// List returns all file paths in the filesystem
	List() []string

	// Close closes the filesystem and releases resources
	Close() error
}

// WritableFileSystem is a FileSystem with a writable overlay layer, used by
// editing workspaces. Writes land in a local work folder layered on top of one
// or more read-only base layers (copy-on-write).
type WritableFileSystem interface {
	FileSystem

	// WriteFile writes data to the writable overlay, overriding any lower-layer
	// version of the same path. Fails if the filesystem is read-only.
	WriteFile(path string, data []byte) error

	// Remove deletes a path from the writable overlay: a net-new local file is
	// removed, an override reverts to the base version, and a base-only file
	// cannot be removed.
	Remove(path string) error

	// EnsureLocal copies an existing file into the writable overlay so that
	// later edits are local (copy-on-write). No-op if already local.
	EnsureLocal(path string) error

	// IsLocal reports whether a path is backed by the writable overlay layer.
	IsLocal(path string) bool
}
