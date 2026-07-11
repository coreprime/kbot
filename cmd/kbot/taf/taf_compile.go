package taf

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/tsf"
)

func newTAFCompileCommand() *cobra.Command {
	var (
		vfsRoot string
		target  string
		images  string
	)
	cmd := &cobra.Command{
		Use:   "compile <file.tsf>",
		Short: "Build a TAF from a TSF document and its layer images",
		Long: `Compile a TSF document plus its referenced layer images into a binary
TAF.  This is the inverse of "kbot taf decompile"; feeding a decompiled
TSF straight back in reproduces the original TAF byte-for-byte.

Layer images are resolved (case-insensitively) from the --images
directory, which defaults to the directory containing the .tsf.

Examples:
  kbot taf compile ./frontend/frontend.tsf --target frontend.taf
  kbot taf compile menu.tsf --images ./art --target menu.taf`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			hit, _, cleanup, err := cli.ResolveTSFInput(args[0], vfsRoot, false)
			defer cleanup()
			if err != nil {
				return err
			}
			doc, err := tsf.ParseTSF(string(hit.Data))
			if err != nil {
				return fmt.Errorf("parse tsf: %w", err)
			}

			imgDir := images
			if imgDir == "" {
				// Default to the directory holding the .tsf on disk; when the
				// source came from the VFS, fall back to the working directory.
				if _, statErr := os.Stat(args[0]); statErr == nil {
					imgDir = filepath.Dir(args[0])
				} else {
					imgDir = "."
				}
			}

			taf, err := tsf.Compile(doc, tsf.DirResolver(imgDir))
			if err != nil {
				return fmt.Errorf("compile: %w", err)
			}
			data, err := taf.Bytes()
			if err != nil {
				return fmt.Errorf("serialize taf: %w", err)
			}

			outPath := target
			if outPath == "" {
				base := strings.TrimSuffix(filepath.Base(args[0]), filepath.Ext(args[0]))
				outPath = base + ".taf"
			}
			return cli.WriteTarget(data, outPath)
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output TAF path (default: <input>.taf)")
	cmd.Flags().StringVar(&images, "images", "", "Directory holding the layer images (default: alongside the .tsf)")
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}
