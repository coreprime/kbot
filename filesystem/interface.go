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
