package taf

import (
	"fmt"
	"image/gif"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

func newTAFExportCommand() *cobra.Command {
	var (
		vfsRoot string
		target  string
		format  string
	)
	cmd := &cobra.Command{
		Use:   "export <file.taf>",
		Short: "Export the whole animation as GIF or APNG",
		Long: `Render every frame of a TAF into an animated image.

APNG keeps the full RGBA channel (recommended for TAF's truecolor
frames); GIF quantises to 255 colours plus a 1-bit transparency cutout
for quick previews and chat embeds.

Frames are composited onto a shared canvas using each frame's render
origin, so multi-frame animations stay aligned.

Examples:
  kbot taf export frontend.taf --format apng --target frontend.png
  kbot taf export anims/spark.taf --format gif --target spark.gif`,
		Args: cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			format = strings.ToLower(format)
			if format != "gif" && format != "png" && format != "apng" {
				return fmt.Errorf("--format must be gif, png or apng")
			}
			ext := "gif"
			if format != "gif" {
				ext = "png"
			}

			taf, _, cleanup, err := loadTAF(args[0], vfsRoot, false)
			defer cleanup()
			if err != nil {
				return err
			}

			outPath := target
			if outPath == "" {
				base := strings.TrimSuffix(args[0], filepath.Ext(args[0]))
				outPath = fmt.Sprintf("%s.%s", filepath.Base(base), ext)
			}
			f, err := os.Create(outPath)
			if err != nil {
				return fmt.Errorf("create output: %w", err)
			}
			defer func() { _ = f.Close() }()

			if format == "gif" {
				g, gerr := taf.ToGIF()
				if gerr != nil {
					return gerr
				}
				if gerr := gif.EncodeAll(f, g); gerr != nil {
					return fmt.Errorf("encode gif: %w", gerr)
				}
			} else {
				if perr := taf.ToAPNG(f); perr != nil {
					return fmt.Errorf("encode apng: %w", perr)
				}
			}
			fmt.Fprintf(os.Stderr, "Exported %d frame(s) → %s\n", len(taf.Frames), outPath)
			return nil
		},
	}
	cmd.Flags().StringVar(&target, "target", "", "Output path (default: <input>.<ext>)")
	cmd.Flags().StringVar(&format, "format", "apng", "Output format: apng (or png) / gif")
	cmd.Flags().StringVar(&vfsRoot, "vfs", "", "Mount a TA/TA:K install for bare-name lookups (default: active kbot context)")
	return cmd
}
