package zrb

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/smacker"
)

func newZRBFromMP4Command() *cobra.Command {
	return &cobra.Command{
		Use:   "from-mp4 <input.mp4> <output.smk>",
		Short: "Convert MP4 video to Smacker (if supported)",
		Long: `Convert an MP4 video file to Smacker format.

Note: Smacker encoding support varies by FFmpeg build.
Many builds only support Smacker decoding, not encoding.

For guaranteed encoding, use RAD Video Tools:
  https://www.radgametools.com/bnkdown.htm`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Printf("Converting %s to Smacker...\n", args[0])
			if err := smacker.ConvertFromMP4(args[0], args[1]); err != nil {
				return err
			}
			fmt.Printf("✅ Conversion complete: %s\n", args[1])
			return nil
		},
	}
}
