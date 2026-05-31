package bik

import (
	"fmt"
	"os/exec"
)

// FFmpegAvailable reports whether an ffmpeg binary is on the PATH.
func FFmpegAvailable() bool {
	_, err := exec.LookPath("ffmpeg")
	return err == nil
}

// ConvertToMP4 decodes a Bink video to MP4 using FFmpeg, which ships a native
// Bink 1 decoder (binkvideo plus binkaudio_dct/binkaudio_rdft).  The encode
// settings mirror the Smacker converter: visually-lossless H.264 (CRF 18) and
// high-fidelity AAC audio.
func ConvertToMP4(bikPath, mp4Path string) error {
	if !FFmpegAvailable() {
		return fmt.Errorf("ffmpeg not found in PATH\nPlease install: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux)")
	}

	// Bink GUI clips can have odd dimensions (e.g. 124x101), but H.264 with
	// yuv420p requires even width and height — pad up to the next even size
	// rather than rescaling so no pixels are resampled.
	args := []string{
		"-i", bikPath,
		"-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
		"-c:v", "libx264",
		"-preset", "fast",
		"-crf", "18",
		"-c:a", "aac",
		"-b:a", "192k",
		"-y",
		mp4Path,
	}

	cmd := exec.Command("ffmpeg", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg conversion failed: %w\nOutput: %s", err, string(output))
	}
	return nil
}

// Note: there is deliberately no ConvertFromMP4. Unlike Smacker (where some
// FFmpeg builds carry the smackvid/smackaud encoders), no open-source Bink
// encoder exists — only RAD's proprietary tools produce .bik files. Bink
// support is therefore decode-only.
