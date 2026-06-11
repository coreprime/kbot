package filesystem

import (
	"io"
	"os"
	"path/filepath"
)

// Ensure PhysicalFileSystem implements FileSystem
var _ FileSystem = (*PhysicalFileSystem)(nil)

// PhysicalFileSystem implements FileSystem for local disk access
type PhysicalFileSystem struct {
	basePath string
}

// NewPhysicalFileSystem creates a filesystem that reads from a local directory
func NewPhysicalFileSystem(basePath string) (*PhysicalFileSystem, error) {
	// Normalize the path
	absPath, err := filepath.Abs(basePath)
	if err != nil {
		return nil, err
	}

	// Verify the path exists
	if _, err := os.Stat(absPath); err != nil {
		return nil, err
	}

	return &PhysicalFileSystem{
		basePath: absPath,
	}, nil
}

// Open opens a file for reading
func (pfs *PhysicalFileSystem) Open(path string) (io.ReadCloser, error) {
	fullPath := filepath.Join(pfs.basePath, path)
	return os.Open(fullPath)
}

// ReadFile reads the entire file content
func (pfs *PhysicalFileSystem) ReadFile(path string) ([]byte, error) {
	fullPath := filepath.Join(pfs.basePath, path)
	return os.ReadFile(fullPath)
}

// Exists checks if a file exists
func (pfs *PhysicalFileSystem) Exists(path string) bool {
	fullPath := filepath.Join(pfs.basePath, path)
	_, err := os.Stat(fullPath)
	return err == nil
}

// List returns all file paths (recursively walks the directory)
func (pfs *PhysicalFileSystem) List() []string {
	var files []string

	_ = filepath.Walk(pfs.basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // Skip errors
		}
		if info.IsDir() {
			return nil
		}

		// Get relative path
		relPath, err := filepath.Rel(pfs.basePath, path)
		if err != nil {
			return nil
		}

		files = append(files, relPath)
		return nil
	})

	return files
}

// Close closes any resources (no-op for physical filesystem)
func (pfs *PhysicalFileSystem) Close() error {
	return nil
}
