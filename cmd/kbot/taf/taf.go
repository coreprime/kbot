package taf

import (
	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot/formats/tsf"
)

// NewCommand builds the `kbot taf` command tree for TA: Kingdoms truecolor
// animations.
func NewCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "taf",
		Short: "TA: Kingdoms truecolor animations (.taf)",
		Long: `Work with TA: Kingdoms TAF animations — the truecolor cousin of TA's
GAF.  A TAF reuses the GAF container but stores 16-bit ARGB pixels
(ARGB4444 or ARGB1555) instead of palette indices, so no external
palette is needed to render one.

Sub-commands:
  info        Header and per-frame breakdown
  list        One-line sequence summary
  render      Export a single frame as PNG
  export      Export the whole animation as GIF or APNG
  sheet       Tile every frame into one sprite-sheet PNG
  decompile   Explode a TAF into a TSF document plus per-frame PNGs
  compile     Build a TAF from a TSF document and its layer images
  from-gif    Import an animated GIF as a TAF
  from-sheet  Import a sprite-sheet PNG as a TAF
  lint        Report structural problems and curiosities
  roundtrip   Verify a TAF re-serializes byte-for-byte
  diff        Compare two TAF files

Paths resolve against local disk first, then the active kbot context
(or --vfs), so a bare name like "frontend.taf" finds the file inside
the install's archives.`,
	}
	cmd.AddCommand(
		newTAFInfoCommand(),
		newTAFListCommand(),
		newTAFRenderCommand(),
		newTAFExportCommand(),
		newTAFSheetCommand(),
		newTAFDecompileCommand(),
		newTAFCompileCommand(),
		newTAFFromGIFCommand(),
		newTAFFromSheetCommand(),
		newTAFLintCommand(),
		newTAFRoundtripCommand(),
		newTAFDiffCommand(),
	)
	return cmd
}

// loadTAF resolves a .taf argument (local path, virtual path, or bare name)
// through the active VFS and parses it.  The returned cleanup closes the VFS
// and must always be called.
func loadTAF(arg, vfsRoot string, quiet bool) (*tsf.TAF, *cli.VFSInputHit, func(), error) {
	vfs, vfsLabel, err := cli.OpenContextVFS(vfsRoot)
	if err != nil {
		return nil, nil, func() {}, err
	}
	cleanup := func() {
		if vfs != nil {
			_ = vfs.Close()
		}
	}
	if vfs != nil && !quiet {
		cli.ReportContextSource(vfsLabel)
	}

	hit, err := cli.ResolveVFSInput(arg, vfs, ".taf", []string{"anims/", "textures/"})
	if err != nil {
		cleanup()
		return nil, nil, func() {}, err
	}
	taf, err := tsf.ParseTAF(hit.Data)
	if err != nil {
		cleanup()
		return nil, nil, func() {}, err
	}
	return taf, hit, cleanup, nil
}

// cli.ResolveTSFInput resolves a .tsf argument through the active VFS.
