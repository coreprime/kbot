package zrb

import (
	"errors"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot-io/formats/smacker"
)

func newZRBFromMP4Command() *cobra.Command {
	return &cobra.Command{
		Use:   "from-mp4 <input.mp4> <output.smk>",
		Short: "Convert MP4 to Smacker (needs an FFmpeg with a Smacker encoder)",
		Long: `Convert an MP4 video file to Smacker format.

There is no Smacker encoder in stock FFmpeg (it has neither the smackvid
or smackaud encoders nor an SMK muxer) and kbot has no Smacker writer, so
this command reports that and stops unless the installed FFmpeg lists both
a smackvid encoder and an smk muxer.

TA 3.1c plays SMK2 movies; make them with RAD Game Tools' Smacker tools:
  https://www.radgametools.com/bnkdown.htm`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := convertFromMP4(args[0], args[1]); err != nil {
				return err
			}
			fmt.Printf("✅ Conversion complete: %s\n", args[1])
			return nil
		},
	}
}

// errNoSmackerEncoder is what from-mp4 reports when nothing can write
// Smacker: stock FFmpeg has no Smacker encoder or muxer.
var errNoSmackerEncoder = errors.New("no Smacker encoder is available: FFmpeg has no Smacker encoder or muxer and kbot has no Smacker writer; make SMK2 movies with RAD's Smacker tools")

// convertFromMP4 converts with FFmpeg when it can write Smacker and
// otherwise reports plainly that no encoder exists.
func convertFromMP4(in, out string) error {
	if !smacker.FFmpegAvailable() {
		return fmt.Errorf("cannot convert %s: %w", in, errNoSmackerEncoder)
	}
	if err := smacker.ConvertFromMP4(in, out); err != nil {
		if errors.Is(err, smacker.ErrNoSmackerWriter) {
			return fmt.Errorf("cannot convert %s: %w", in, errNoSmackerEncoder)
		}
		return err
	}
	return nil
}
