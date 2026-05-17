package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/hpi"
)

func newHPIPackCommand() *cobra.Command {
	var (
		verbose bool
		target  string
	)

	cmd := &cobra.Command{
		Use:   "pack <source-dir>",
		Short: "Pack a directory into an HPI archive",
		Long: `Pack a directory and its contents into an HPI archive.

Use --target to write to a file.  When omitted the archive is
streamed to stdout.

Examples:
  kbot hpi pack ./my_units --target units.hpi
  kbot hpi pack ./data > archive.hpi`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			sourcePath := args[0]

			sourceInfo, err := os.Stat(sourcePath)
			if err != nil {
				return fmt.Errorf("source path not found: %w", err)
			}
			if !sourceInfo.IsDir() {
				return fmt.Errorf("source path must be a directory: %s", sourcePath)
			}

			// Write to a temp file first (the HPI writer requires seeking).
			tmpFile, err := os.CreateTemp("", "kbot-hpi-*.hpi")
			if err != nil {
				return fmt.Errorf("failed to create temp file: %w", err)
			}
			tmpPath := tmpFile.Name()
			_ = tmpFile.Close()
			defer func() { _ = os.Remove(tmpPath) }()

			writer, err := hpi.CreateWriter(tmpPath)
			if err != nil {
				return fmt.Errorf("failed to create archive: %w", err)
			}

			if verbose {
				fmt.Fprintf(os.Stderr, "Source: %s\n", sourcePath)
				if target != "" {
					fmt.Fprintf(os.Stderr, "Target: %s\n\n", target)
				} else {
					fmt.Fprintf(os.Stderr, "Target: stdout\n\n")
				}
			}

			added, failed := 0, 0

			err = filepath.Walk(sourcePath, func(path string, info os.FileInfo, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				if info.IsDir() {
					return nil
				}

				relPath, err := filepath.Rel(sourcePath, path)
				if err != nil {
					if verbose {
						fmt.Fprintf(os.Stderr, "FAIL: %s (%v)\n", path, err)
					}
					failed++
					return nil
				}

				archivePath := filepath.ToSlash(relPath)
				if err := writer.AddFile(archivePath, path); err != nil {
					if verbose {
						fmt.Fprintf(os.Stderr, "FAIL: %s -> %s (%v)\n", relPath, archivePath, err)
					}
					failed++
					return nil
				}

				if verbose {
					fmt.Fprintf(os.Stderr, "ADD: %s (%d bytes)\n", archivePath, info.Size())
				}
				added++
				return nil
			})
			if err != nil {
				return fmt.Errorf("failed to walk directory: %w", err)
			}

			if err := writer.Close(); err != nil {
				return fmt.Errorf("failed to finalize archive: %w", err)
			}

			// Copy temp file to target or stdout.
			if target != "" {
				if err := copyFile(tmpPath, target); err != nil {
					return err
				}
				archiveInfo, _ := os.Stat(target)
				fmt.Fprintf(os.Stderr, "\nArchive created: %s\n", target)
				fmt.Fprintf(os.Stderr, "  Files: %d\n", added)
				if failed > 0 {
					fmt.Fprintf(os.Stderr, "  Failed: %d\n", failed)
				}
				if archiveInfo != nil {
					fmt.Fprintf(os.Stderr, "  Size: %d bytes (%.2f MB)\n",
						archiveInfo.Size(), float64(archiveInfo.Size())/(1024*1024))
				}
			} else {
				f, err := os.Open(tmpPath)
				if err != nil {
					return fmt.Errorf("failed to read temp archive: %w", err)
				}
				defer func() { _ = f.Close() }()
				if _, err := io.Copy(os.Stdout, f); err != nil {
					return fmt.Errorf("failed to write to stdout: %w", err)
				}
			}

			return nil
		},
	}

	cmd.Flags().BoolVarP(&verbose, "verbose", "v", false, "Show detailed packing progress")
	cmd.Flags().StringVar(&target, "target", "", "Output archive path (default: stdout)")

	return cmd
}

// copyFile copies src to dst, creating parent directories as needed.
func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()

	_, err = io.Copy(out, in)
	return err
}
