package hpi

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/hpi"
)

func newHPIListCommand() *cobra.Command {
	var (
		verbose bool
		pattern string
		stream  bool
	)

	cmd := &cobra.Command{
		Use:   "list <archive>",
		Short: "List files in an HPI/UFO/CCX archive",
		Long: `List all files contained in an HPI, UFO, or CCX archive.

Pass --stream to read the archive from stdin.

Examples:
  kbot hpi list units.hpi
  kbot hpi list units.hpi --pattern "*.fbi"
  cat units.hpi | kbot hpi list --stream`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path, cleanup, err := cli.HPIInputPath(args, stream)
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

			files := reader.List()

			if verbose {
				fmt.Printf("Archive: %s\n", filepath.Base(path))
				fmt.Printf("Files: %d\n\n", len(files))
			}

			filtered := files
			if pattern != "" {
				filtered = make([]string, 0)
				for _, file := range files {
					matched, _ := filepath.Match(pattern, filepath.Base(file))
					if matched {
						filtered = append(filtered, file)
					}
				}
			}

			if verbose {
				fmt.Printf("%-60s %12s\n", "PATH", "SIZE")
				fmt.Printf("%s\n", strings.Repeat("-", 74))
			}

			totalSize := uint64(0)
			for _, file := range filtered {
				if verbose {
					entry := reader.Find(file)
					if entry != nil {
						fmt.Printf("%-60s %12d\n", file, entry.Size)
						totalSize += uint64(entry.Size)
					} else {
						fmt.Println(file)
					}
				} else {
					fmt.Println(file)
				}
			}

			if verbose {
				fmt.Printf("\nFiles listed: %d\n", len(filtered))
				fmt.Printf("Total size: %d bytes (%.2f MB)\n",
					totalSize, float64(totalSize)/(1024*1024))
			}

			return nil
		},
	}

	cmd.Flags().BoolVarP(&verbose, "verbose", "v", false, "Show detailed information")
	cmd.Flags().StringVarP(&pattern, "pattern", "p", "", "Filter files by pattern (e.g., *.fbi)")
	cmd.Flags().BoolVar(&stream, "stream", false, "Read archive from stdin")

	return cmd
}
