package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

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
