package hpi

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/hpi"
)

func newHPIExtractCommand() *cobra.Command {
	var (
		verbose bool
		force   bool
		target  string
		stream  bool
	)

	cmd := &cobra.Command{
		Use:   "extract <archive> [pattern]",
		Short: "Extract files from an HPI/UFO/CCX archive",
		Long: `Extract files from an HPI, UFO, or CCX archive.

Pass --stream to read the archive from stdin.

Examples:
  kbot hpi extract units.hpi --target ./extracted
  kbot hpi extract units.hpi "*.fbi" --target ./data
  cat units.hpi | kbot hpi extract --stream --target ./out`,
		Args: cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			// Separate archive path from optional pattern.
			var fileArgs []string
			pattern := "**/*"
			if stream {
				if len(args) > 0 {
					pattern = args[0]
				}
			} else {
				if len(args) < 1 {
					return fmt.Errorf("archive path required (or use --stream)")
				}
				fileArgs = args[:1]
				if len(args) > 1 {
					pattern = args[1]
				}
			}

			path, cleanup, err := cli.HPIInputPath(fileArgs, stream)
			if err != nil {
				return err
			}
			if cleanup != nil {
				defer cleanup()
			}

			reader, err := hpi.OpenReader(path)
			if err != nil {
				return fmt.Errorf("failed to open archive: %w", err)
			}
			defer func() { _ = reader.Close() }()

			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("failed to create target directory: %w", err)
			}

			files := reader.List()

			if verbose {
				fmt.Printf("Archive: %s\nTarget: %s\nTotal files: %d\n\n", path, target, len(files))
			}

			matched := make([]string, 0)
			for _, f := range files {
				if hpiMatchPattern(f, pattern) {
					matched = append(matched, f)
				}
			}
			if len(matched) == 0 {
				return fmt.Errorf("no files matched pattern: %s", pattern)
			}
			if verbose {
				fmt.Printf("Matched files: %d\n\n", len(matched))
			}

			extracted, skipped, failed := 0, 0, 0

			for _, file := range matched {
				outputPath := filepath.Join(target, filepath.FromSlash(file))

				if !force {
					if _, err := os.Stat(outputPath); err == nil {
						if verbose {
							fmt.Printf("SKIP: %s (already exists)\n", file)
						}
						skipped++
						continue
					}
				}

				if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
					fmt.Printf("ERROR: %s: %v\n", file, err)
					failed++
					continue
				}

				rc, err := reader.Open(file)
				if err != nil {
					fmt.Printf("ERROR: %s: %v\n", file, err)
					failed++
					continue
				}

				outFile, err := os.Create(outputPath)
				if err != nil {
					_ = rc.Close()
					fmt.Printf("ERROR: %s: %v\n", file, err)
					failed++
					continue
				}

				_, err = io.Copy(outFile, rc)
				_ = outFile.Close()
				_ = rc.Close()

				if err != nil {
					fmt.Printf("ERROR: %s: %v\n", file, err)
					failed++
					continue
				}

				if verbose {
					fmt.Printf("OK: %s\n", file)
				}
				extracted++
			}

			fmt.Fprintf(os.Stderr, "\nExtraction complete:\n")
			fmt.Fprintf(os.Stderr, "  Extracted: %d\n", extracted)
			if skipped > 0 {
				fmt.Fprintf(os.Stderr, "  Skipped: %d\n", skipped)
			}
			if failed > 0 {
				fmt.Fprintf(os.Stderr, "  Failed: %d\n", failed)
			}

			return nil
		},
	}

	cmd.Flags().BoolVarP(&verbose, "verbose", "v", false, "Show detailed extraction progress")
	cmd.Flags().BoolVarP(&force, "force", "f", false, "Overwrite existing files")
	cmd.Flags().StringVarP(&target, "target", "t", "./extracted", "Target directory for extraction")
	cmd.Flags().BoolVar(&stream, "stream", false, "Read archive from stdin")

	return cmd
}

// hpiMatchPattern checks if a path matches a pattern (simplified glob matching).
func hpiMatchPattern(path, pattern string) bool {
	if pattern == "**/*" || pattern == "*" {
		return true
	}
	if strings.HasPrefix(pattern, "*.") {
		return strings.HasSuffix(path, pattern[1:])
	}
	matched, _ := filepath.Match(pattern, filepath.Base(path))
	return matched
}
