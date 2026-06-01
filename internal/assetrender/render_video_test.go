package assetrender

import (
	"os"
	"os/exec"
	"testing"
)

// buildTestClip shells out to ffmpeg to synthesise a short test pattern. The
// movie converters probe their input by content rather than by file extension,
// so a generic clip is enough to exercise the transcode and thumbnail paths
// without shipping a real Smacker/Bink asset. The test that calls this skips
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

func TestRenderVideoThumb(t *testing.T) {
	r := newTestRenderer(t)
	data := buildTestClip(t)

	out, err := r.Render("movies/intro.smk", data, RenderRequest{Format: "apng"})
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
	data := buildTestClip(t)
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
