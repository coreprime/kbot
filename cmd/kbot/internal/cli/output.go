package cli

import (
	"fmt"
	"os"
)

// OpenOutput returns a writable file for path, or os.Stdout when path is
// empty. Callers pair it with CloseOutput, which leaves stdout open.
func OpenOutput(path string) (*os.File, error) {
	if path == "" {
		return os.Stdout, nil
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("create %s: %w", path, err)
	}
	return f, nil
}

// CloseOutput closes f when it was opened from a real path; it is a no-op for
// the shared os.Stdout handle.
func CloseOutput(f *os.File, path string) {
	if path != "" {
		_ = f.Close()
	}
}
