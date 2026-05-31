package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/formats/hpi"
	hpiv1 "github.com/coreprime/kbot/formats/hpi/v1"
	hpiv2 "github.com/coreprime/kbot/formats/hpi/v2"
)

// packWriter is the minimal surface the pack command needs from a version
// specific HPI writer.
type packWriter interface {
	AddFile(archivePath, filePath string) error
	Close() error
}

func newHPIPackCommand() *cobra.Command {
	var (
		verbose      bool
		target       string
		compression  int
		method       string
		headerKey    uint8
		encodeChunks bool
		trailer      string
		format       string
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

			var writer packWriter
			switch format {
			case "v1", "":
				w, err := hpiv1.CreateWriter(tmpPath)
				if err != nil {
					return fmt.Errorf("failed to create archive: %w", err)
				}
				w.CompressionLevel = compression
				w.HeaderKey = headerKey
				w.ChunkEncoded = encodeChunks
				switch method {
				case "lz77", "":
					w.CompressionMethod = hpi.CompressionLZ77
				case "zlib":
					w.CompressionMethod = hpi.CompressionZLib
				case "none":
					w.CompressionMethod = hpi.CompressionNone
				default:
					return fmt.Errorf("unknown compression method: %s (use lz77, zlib, or none)", method)
				}
				if trailer != "" {
					w.SetTrailer([]byte(trailer))
				} else {
					w.SetTrailer(nil)
				}
				writer = w
			case "v2":
				w, err := hpiv2.CreateWriter(tmpPath)
				if err != nil {
					return fmt.Errorf("failed to create archive: %w", err)
				}
				w.CompressionLevel = compression
				switch method {
				case "zlib", "lz77", "":
					// TA: Kingdoms archives only use zlib-in-SQSH chunks.
					w.CompressionMethod = hpi.CompressionZLib
				case "none":
					w.CompressionMethod = hpi.CompressionNone
				default:
					return fmt.Errorf("unknown compression method: %s (use zlib or none for v2)", method)
				}
				writer = w
			default:
				return fmt.Errorf("unknown HPI format: %s (use v1 or v2)", format)
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
	cmd.Flags().IntVar(&compression, "compression", 0, "Zlib compression level 1-9 (0 = default)")
	cmd.Flags().StringVar(&format, "format", "v1", "HPI format: v1 (Total Annihilation) or v2 (TA: Kingdoms)")
	cmd.Flags().StringVar(&method, "method", "lz77", "Compression method: lz77, zlib, or none (v2 supports zlib or none)")
	cmd.Flags().Uint8Var(&headerKey, "key", hpi.DefaultHeaderKey,
		"HPI HeaderKey for XOR encryption (default matches retail TA; 0 disables encryption)")
	cmd.Flags().BoolVar(&encodeChunks, "encode-chunks", true,
		"Apply the per-chunk add/XOR transform used by shipped TA archives")
	cmd.Flags().StringVar(&trailer, "trailer", hpi.DefaultTrailer,
		"Bytes appended after the file data section (empty string writes no trailer)")

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
