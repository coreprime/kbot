package hpi

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/hpi"
	"github.com/coreprime/kbot-io/formats/hpi/common"
	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	hpiv2 "github.com/coreprime/kbot-io/formats/hpi/v2"
)

// packWriter is the minimal surface the pack command needs from a version
// specific HPI writer.
type packWriter interface {
	AddFile(archivePath, filePath string) error
	Close() error
}

// packV1Options are the v1-only pack flags, checked before any file is
// written.
type packV1Options struct {
	headerKey uint8
	trailer   string
	noTrailer bool
	method    string
}

// configureV1Writer applies the v1 pack flags to w, refusing values that
// would produce an archive TA 3.1c reads differently from what was asked
// for, or does not mount at all.
func configureV1Writer(w *hpiv1.Writer, o packV1Options) error {
	switch o.method {
	case "lz77", "":
		w.CompressionMethod = hpi.CompressionLZ77
	case "zlib":
		w.CompressionMethod = hpi.CompressionZLib
	case "none":
		// Written as stored (uncompressed) entries.
		w.CompressionMethod = hpi.CompressionNone
	default:
		return fmt.Errorf("unknown compression method: %s (use lz77, zlib, or none)", o.method)
	}
	if o.headerKey == 0xFF {
		return fmt.Errorf("--key 255 (0xFF) is read by TA 3.1c as \"not encrypted\": pass --key 0 for an unencrypted archive, or another value to encrypt")
	}
	w.HeaderKey = o.headerKey
	switch {
	case o.noTrailer:
		w.AllowNonGameTrailer = true
		w.SetTrailer(nil)
	case !common.ValidTrailer([]byte(o.trailer)):
		return fmt.Errorf("--trailer %q: TA 3.1c mounts an archive only when it ends with the 36 bytes \"Copyright ____ Cavedog Entertainment\" (any four year characters); use --no-trailer to write an archive the game will not mount", o.trailer)
	default:
		w.SetTrailer([]byte(o.trailer))
	}
	return nil
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
		noTrailer    bool
		format       string
	)

	cmd := &cobra.Command{
		Use:   "pack <source-dir>",
		Short: "Pack a directory into an HPI archive",
		Long: `Pack a directory and its contents into an HPI archive.

Use --target to write to a file.  When omitted the archive is
streamed to stdout.

Version 1 (Total Annihilation) archives end with the Cavedog copyright
trailer TA 3.1c requires ("Copyright 1997 Cavedog Entertainment" unless
--trailer names another year); --no-trailer omits it and produces an
archive the game will not mount.  --key 255 is refused because the game
reads header key 0xFF as "not encrypted"; use --key 0 for that.
--method none stores files uncompressed.  Paths that differ only in
letter case (Units/ and units/ on a case-sensitive disk) are merged the
way the game compares names, and colliding files are reported.

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

			if format == "v2" {
				for _, f := range []string{"key", "trailer", "no-trailer", "encode-chunks"} {
					if cmd.Flags().Changed(f) {
						return fmt.Errorf("--%s applies to v1 (Total Annihilation) archives only", f)
					}
				}
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
			var v1 *hpiv1.Writer
			switch format {
			case "v1", "":
				w, err := hpiv1.CreateWriter(tmpPath)
				if err != nil {
					return fmt.Errorf("failed to create archive: %w", err)
				}
				w.CompressionLevel = compression
				w.ChunkEncoded = encodeChunks
				if err := configureV1Writer(w, packV1Options{headerKey: headerKey, trailer: trailer, noTrailer: noTrailer, method: method}); err != nil {
					_ = w.Close()
					return err
				}
				if noTrailer {
					fmt.Fprintln(os.Stderr, "warning: --no-trailer: TA 3.1c will not mount this archive")
				}
				writer, v1 = w, w
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

			if v1 != nil {
				for _, warning := range v1.Warnings() {
					fmt.Fprintf(os.Stderr, "warning: %s\n", warning)
				}
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
		"HPI HeaderKey for XOR encryption (default matches retail TA; 0 disables encryption; 255 is refused)")
	cmd.Flags().BoolVar(&encodeChunks, "encode-chunks", true,
		"Apply the per-chunk add/XOR transform used by shipped TA archives")
	cmd.Flags().StringVar(&trailer, "trailer", hpi.DefaultTrailer,
		"Copyright trailer written at the end: \"Copyright <4 characters> Cavedog Entertainment\", which TA 3.1c requires")
	cmd.Flags().BoolVar(&noTrailer, "no-trailer", false,
		"Write no trailer (TA 3.1c will not mount the archive)")

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
