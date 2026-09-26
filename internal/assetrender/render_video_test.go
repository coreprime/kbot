package assetrender

import (
	"encoding/binary"
	"image/png"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/testutil"
)

// buildTestClip shells out to ffmpeg to synthesise a short test pattern. The
// Bink converter reads its input by content rather than by file extension,
// so a generic clip is enough to exercise the Bink transcode and thumbnail
// paths without shipping a real Bink asset. Smacker paths read the Smacker
// header first and use retailSmacker instead. The test that calls this skips
// when ffmpeg is unavailable.
func buildTestClip(t *testing.T) []byte {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH; skipping video render test")
	}
	out, err := os.CreateTemp(t.TempDir(), "clip-*.mp4")
	if err != nil {
		t.Fatalf("temp: %v", err)
	}
	_ = out.Close()
	cmd := exec.Command("ffmpeg",
		"-y", "-v", "error",
		"-f", "lavfi",
		"-i", "testsrc=duration=1:size=64x64:rate=10",
		"-pix_fmt", "yuv420p",
		out.Name(),
	)
	if combined, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("ffmpeg could not build test clip: %v\n%s", err, combined)
	}
	data, err := os.ReadFile(out.Name())
	if err != nil {
		t.Fatalf("read clip: %v", err)
	}
	return data
}

func TestRenderVideoMP4(t *testing.T) {
	r := newTestRenderer(t)
	data := buildTestClip(t)

	out, err := r.Render("movies/intro.bik", data, RenderRequest{Format: "mp4"})
	if err != nil {
		t.Fatalf("render mp4: %v", err)
	}
	if out.ContentType != "video/mp4" {
		t.Errorf("content-type = %q, want video/mp4", out.ContentType)
	}
	if out.Path == "" {
		t.Fatal("expected a cache path for video render")
	}
	info, err := os.Stat(out.Path)
	if err != nil || info.Size() == 0 {
		t.Fatalf("rendered mp4 missing or empty: %v", err)
	}
}

// retailSmacker returns the first frames of the retail intro movie
// (data/1.zrb, a 640x240 interlaced SMK2) as a complete, shorter Smacker
// file: the header's frame count is cut, the ring frame dropped, and the
// frame tables and payloads trimmed to match.
func retailSmacker(t *testing.T, frames int) []byte {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not on PATH; skipping video render test")
	}
	data, err := os.ReadFile(testutil.UnpackedFile(t, "data", "1.zrb"))
	if err != nil {
		t.Fatalf("read retail movie: %v", err)
	}
	le := binary.LittleEndian
	total := int(le.Uint32(data[12:]))
	flags := le.Uint32(data[20:])
	entries := total
	if flags&1 != 0 {
		entries++
	}
	trees := int(le.Uint32(data[52:]))
	sizesAt := 104
	typesAt := sizesAt + 4*entries
	treesAt := typesAt + entries
	payloadAt := treesAt + trees
	payload := 0
	for i := 0; i < frames; i++ {
		payload += int(le.Uint32(data[sizesAt+4*i:]))
	}
	out := append([]byte{}, data[:104]...)
	le.PutUint32(out[12:], uint32(frames))
	le.PutUint32(out[20:], flags&^1)
	out = append(out, data[sizesAt:sizesAt+4*frames]...)
	out = append(out, data[typesAt:typesAt+frames]...)
	out = append(out, data[treesAt:treesAt+trees]...)
	return append(out, data[payloadAt:min(payloadAt+payload, len(data))]...)
}

// videoSize asks ffprobe for the first video stream's size.
func videoSize(t *testing.T, path string) (int, int) {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height", "-of", "csv=p=0", "file:"+path).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", path, err)
	}
	parts := strings.Split(strings.TrimSpace(string(out)), ",")
	if len(parts) != 2 {
		t.Fatalf("ffprobe output %q", out)
	}
	w, _ := strconv.Atoi(parts[0])
	h, _ := strconv.Atoi(parts[1])
	return w, h
}

// TestRenderSmackerAtDisplayHeight checks that the retail 640x240
// interlaced movies are shown as the game shows them: a 640x480 MP4 and a
// 4:3 thumbnail, not squashed to half height.
func TestRenderSmackerAtDisplayHeight(t *testing.T) {
	r := newTestRenderer(t)
	data := retailSmacker(t, 6)

	out, err := r.Render("data/1.zrb", data, RenderRequest{Format: "mp4"})
	if err != nil {
		t.Fatalf("render mp4: %v", err)
	}
	if w, h := videoSize(t, out.Path); w != 640 || h != 480 {
		t.Errorf("mp4 is %dx%d, want 640x480", w, h)
	}

	thumb, err := r.Render("data/1.zrb", data, RenderRequest{Format: "apng"})
	if err != nil {
		t.Fatalf("render thumbnail: %v", err)
	}
	f, err := os.Open(thumb.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	cfg, err := png.DecodeConfig(f)
	if err != nil {
		t.Fatalf("decode thumbnail: %v", err)
	}
	if cfg.Width != 128 || cfg.Height != 96 {
		t.Errorf("thumbnail is %dx%d, want 128x96", cfg.Width, cfg.Height)
	}
}

func TestRenderVideoThumb(t *testing.T) {
	r := newTestRenderer(t)
	data := buildTestClip(t)

	out, err := r.Render("movies/intro.bik", data, RenderRequest{Format: "apng"})
	if err != nil {
		t.Fatalf("render thumb: %v", err)
	}
	if out.ContentType != "image/apng" {
		t.Errorf("content-type = %q, want image/apng", out.ContentType)
	}
	if out.Path == "" {
		t.Fatal("expected a cache path for thumbnail render")
	}
	if info, err := os.Stat(out.Path); err != nil || info.Size() == 0 {
		t.Fatalf("rendered thumbnail missing or empty: %v", err)
	}
}

func TestRenderVideoCachingReusesFile(t *testing.T) {
	r := newTestRenderer(t)
	data := retailSmacker(t, 4)
	req := RenderRequest{Format: "mp4"}

	first, err := r.Render("movies/intro.smk", data, req)
	if err != nil {
		t.Fatalf("first render: %v", err)
	}
	second, err := r.Render("movies/intro.smk", data, req)
	if err != nil {
		t.Fatalf("second render: %v", err)
	}
	if first.Path != second.Path {
		t.Errorf("cache path changed between renders: %q vs %q", first.Path, second.Path)
	}
}
