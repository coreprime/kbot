package smacker

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// ConvertToMP4 converts a Smacker video file to MP4 using FFmpeg
// This is a practical implementation using FFmpeg as it has native Smacker support
func ConvertToMP4(smkPath, mp4Path string) error {
	// Check if ffmpeg is available
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return fmt.Errorf("ffmpeg not found in PATH: %w\nPlease install: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux)", err)
	}

	// Build ffmpeg command
	// -i input.smk: input file
	// -c:v libx264: encode video with H.264
	// -preset fast: encoding speed preset
	// -crf 18: quality (lower = better, 18 is visually lossless)
	// -c:a aac: encode audio with AAC
	// -b:a 192k: audio bitrate
	// -y: overwrite output
	args := []string{
		"-i", smkPath,
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

// ConvertFromMP4 converts an MP4 file to Smacker format using FFmpeg
func ConvertFromMP4(mp4Path, smkPath string) error {
	// Check if ffmpeg is available
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return fmt.Errorf("ffmpeg not found in PATH: %w\nPlease install: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux)", err)
	}

	// Note: FFmpeg can decode Smacker but encoding is limited
	// This will use FFmpeg's built-in Smacker encoder if available
	args := []string{
		"-i", mp4Path,
		"-c:v", "smackvid", // Smacker video codec
		"-c:a", "smackaud", // Smacker audio codec
		"-y",
		smkPath,
	}

	cmd := exec.Command("ffmpeg", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		// If smacker encoding fails, provide helpful error
		if strings.Contains(string(output), "Unknown encoder") {
			return fmt.Errorf("smacker encoding not supported by your FFmpeg build; " +
				"alternative: use RAD Video Tools or libsmacker; " +
				"this Go implementation provides decoding only")
		}
		return fmt.Errorf("ffmpeg conversion failed: %w\nOutput: %s", err, string(output))
	}

	return nil
}

// StreamToMP4 converts a Smacker file to MP4 and returns the output path
// Useful for web streaming - converts on-demand
func StreamToMP4(smkPath string) (string, error) {
	// Create temp output path
	ext := filepath.Ext(smkPath)
	mp4Path := strings.TrimSuffix(smkPath, ext) + ".mp4"

	if err := ConvertToMP4(smkPath, mp4Path); err != nil {
		return "", err
	}

	return mp4Path, nil
}
