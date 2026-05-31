package hpi

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/hpi"
)

func newHPIInfoCommand() *cobra.Command {
	var stream bool

	cmd := &cobra.Command{
		Use:   "info <archive>",
		Short: "Show detailed information about an archive",
		Long: `Display detailed information about an HPI, UFO, or CCX archive file.

Pass --stream to read the archive from stdin.

Examples:
  kbot hpi info units.hpi
  cat units.hpi | kbot hpi info --stream`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path, cleanup, err := cli.HPIInputPath(args, stream)
			if err != nil {
				return err
			}
			if cleanup != nil {
				defer cleanup()
			}

			fileInfo, err := os.Stat(path)
			if err != nil {
				return fmt.Errorf("failed to stat file: %w", err)
			}

			reader, err := hpi.OpenReader(path)
			if err != nil {
				return fmt.Errorf("failed to open archive: %w", err)
			}
			defer func() { _ = reader.Close() }()

			files := reader.List()

			totalSize := uint64(0)
			compressedCount := 0
			if reader.Root() != nil {
				_ = reader.Root().Walk(func(entry *hpi.Entry) error {
					if !entry.IsDir {
						totalSize += uint64(entry.Size)
						if entry.CompType != 0 {
							compressedCount++
						}
					}
					return nil
				})
			}

			fmt.Printf("Archive Information\n")
			fmt.Printf("═══════════════════════════════════════════════════════════════\n\n")
			fmt.Printf("File:\n")
			fmt.Printf("  Path: %s\n", path)
			fmt.Printf("  Size: %d bytes (%.2f MB)\n\n", fileInfo.Size(), float64(fileInfo.Size())/(1024*1024))

			header := reader.Header()
			fmt.Printf("Header:\n")
			fmt.Printf("  Marker: 0x%08X (HAPI)\n", header.Marker)
			fmt.Printf("  Version: 0x%08X\n", header.Version)
			fmt.Printf("  Directory Size: %d bytes\n", header.DirectorySize)
			fmt.Printf("  Directory Offset: %d (0x%X)\n", header.Offset, header.Offset)
			fmt.Printf("  Decrypt Key: 0x%08X\n\n", header.DecryptKey)

			fmt.Printf("Contents:\n")
			fmt.Printf("  Total Files: %d\n", len(files))
			fmt.Printf("  Compressed Files: %d\n", compressedCount)
			fmt.Printf("  Uncompressed Size: %d bytes (%.2f MB)\n", totalSize, float64(totalSize)/(1024*1024))

			if totalSize > 0 {
				ratio := (1.0 - float64(fileInfo.Size())/float64(totalSize)) * 100
				if ratio > 0 {
					fmt.Printf("  Compression Ratio: %.1f%%\n", ratio)
				}
			}

			return nil
		},
	}

	cmd.Flags().BoolVar(&stream, "stream", false, "Read archive from stdin")

	return cmd
}
