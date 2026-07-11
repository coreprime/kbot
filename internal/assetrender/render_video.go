package assetrender

import (
	"fmt"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"

	"github.com/coreprime/kbot-io/formats/bik"
	"github.com/coreprime/kbot-io/formats/smacker"
)

// videoExts are the source movie formats the renderer can transcode. Smacker
// and its Cavedog ZRB variant share a demuxer; Bink is decode-only.
var videoExts = map[string]bool{
	".smk": true,
	".zrb": true,
	".bik": true,
}

// isVideoExt reports whether ext (lowercased, dot-prefixed) names a movie
// format the renderer can transcode.
func isVideoExt(ext string) bool { return videoExts[ext] }

// renderVideo turns a Smacker/ZRB/Bink movie into a browser-playable artefact.
// format "mp4" (the default) transcodes the whole clip to H.264/AAC; format
// "apng" produces a lightweight animated thumbnail sampled across the clip.
// Both results are cached on disk and served by path so the HTTP layer can
// honour Range requests for scrubbing.
func (r *Renderer) renderVideo(vpath string, data []byte, req RenderRequest) (Rendered, error) {
	ext := strings.ToLower(path.Ext(vpath))
	format := strings.ToLower(req.Format)
	if format == "" || format == "video" {
		format = "mp4"
	}
	key := r.CacheKey(vpath, data)

	switch format {
	case "mp4":
		p, err := r.renderCachedFile("video-mp4", key, ".mp4", func(dst string) error {
			return transcodeToMP4(ext, data, dst)
		})
		if err != nil {
			return Rendered{}, err
		}
		return Rendered{ContentType: "video/mp4", Path: p}, nil
	case "apng", "thumb", "thumbnail":
		p, err := r.renderCachedFile("video-thumb", key, ".apng", func(dst string) error {
			return generateVideoThumb(ext, data, dst)
		})
		if err != nil {
			return Rendered{}, err
		}
		return Rendered{ContentType: "image/apng", Path: p}, nil
	default:
		return Rendered{}, fmt.Errorf("unsupported video format %q", format)
	}
}

// writeTempSource spills the in-memory movie bytes to a temp file carrying the
// source extension so the format converters (which take a path) and ffmpeg's
// demuxer have something on disk to read.
func writeTempSource(ext string, data []byte) (string, error) {
	if ext == "" {
		ext = ".smk"
	}
	f, err := os.CreateTemp("", "video-src-*"+ext)
	if err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(f.Name())
		return "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// transcodeToMP4 dispatches to the Bink or Smacker converter by source
// extension, writing the H.264/AAC result to dst.
func transcodeToMP4(ext string, data []byte, dst string) error {
	src, err := writeTempSource(ext, data)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(src) }()

	if ext == ".bik" {
		return bik.ConvertToMP4(src, dst)
	}
	return smacker.ConvertToMP4(src, dst)
}

// generateVideoThumb builds a small animated APNG by sampling ~20 frames evenly
// across the clip and stitching them at a slow framerate. It shells out to
// ffmpeg/ffprobe directly because the sampling is a pure ffmpeg filtergraph
// concern with no game-format specifics.
func generateVideoThumb(ext string, data []byte, dst string) error {
	if !smacker.FFmpegAvailable() {
		return fmt.Errorf("ffmpeg not found in PATH")
	}
	src, err := writeTempSource(ext, data)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(src) }()

	// Count frames so the sampling interval lands ~20 frames regardless of clip
	// length; fall back to a sane default when ffprobe can't read the stream.
	totalFrames := 0
	if out, err := exec.Command("ffprobe",
		"-v", "error",
		"-count_frames",
		"-select_streams", "v:0",
		"-show_entries", "stream=nb_read_frames",
		"-of", "csv=p=0",
		src,
	).Output(); err == nil {
		_, _ = fmt.Sscanf(strings.TrimSpace(string(out)), "%d", &totalFrames)
	}
	if totalFrames < 2 {
		totalFrames = 20
	}
	interval := totalFrames / 20
	if interval < 1 {
		interval = 1
	}

	frameDir, err := os.MkdirTemp("", "video-thumb-frames-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(frameDir) }()

	selectExpr := fmt.Sprintf("not(mod(n\\,%d))", interval)
	if err := exec.Command("ffmpeg",
		"-y", "-v", "error",
		"-i", src,
		"-vf", fmt.Sprintf("select='%s',scale=128:-1:flags=neighbor", selectExpr),
		"-vsync", "vfr",
		"-frames:v", "20",
		filepath.Join(frameDir, "frame_%03d.png"),
	).Run(); err != nil {
		return fmt.Errorf("ffmpeg frame extraction failed: %w", err)
	}

	if err := exec.Command("ffmpeg",
		"-y", "-v", "error",
		"-framerate", "2",
		"-i", filepath.Join(frameDir, "frame_%03d.png"),
		"-plays", "0",
		"-f", "apng",
		dst,
	).Run(); err != nil {
		return fmt.Errorf("ffmpeg APNG assembly failed: %w", err)
	}
	return nil
}
