package filesystem

import (
	"bytes"
	"fmt"
	"io"
)

// Ensure MemoryFileSystem implements FileSystem
var _ FileSystem = (*MemoryFileSystem)(nil)

// MemoryFileSystem implements FileSystem for in-memory content (useful for testing)
type MemoryFileSystem struct {
	files map[string][]byte
}

// NewMemoryFileSystem creates an in-memory filesystem
func NewMemoryFileSystem() *MemoryFileSystem {
	return &MemoryFileSystem{
		files: make(map[string][]byte),
	}
}

// AddFile adds a file to the in-memory filesystem
func (mfs *MemoryFileSystem) AddFile(path string, content []byte) {
	mfs.files[path] = content
}

// Open opens a file for reading
func (mfs *MemoryFileSystem) Open(path string) (io.ReadCloser, error) {
	content, exists := mfs.files[path]
	if !exists {
		return nil, fmt.Errorf("file not found: %s", path)
	}
	return io.NopCloser(bytes.NewReader(content)), nil
}

// ReadFile reads the entire file content
func (mfs *MemoryFileSystem) ReadFile(path string) ([]byte, error) {
	content, exists := mfs.files[path]
	if !exists {
		return nil, fmt.Errorf("file not found: %s", path)
	}
	return content, nil
}

// Exists checks if a file exists
func (mfs *MemoryFileSystem) Exists(path string) bool {
	_, exists := mfs.files[path]
	return exists
}

// List returns all file paths
func (mfs *MemoryFileSystem) List() []string {
	paths := make([]string, 0, len(mfs.files))
	for path := range mfs.files {
		paths = append(paths, path)
	}
	return paths
}

// Close closes any resources (no-op for memory filesystem)
func (mfs *MemoryFileSystem) Close() error {
	return nil
}
