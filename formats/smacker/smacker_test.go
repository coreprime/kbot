package smacker_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/formats/smacker"
	"github.com/coreprime/kbot/internal/testutil"
)

// TestKnownHeader pins the parsed fields of a shipped Cavedog cinematic so a
// regression in the byte layout is caught immediately.
func TestKnownHeader(t *testing.T) {
	path := testutil.UnpackedFile(t, "data", "1.zrb")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}

	r, err := smacker.OpenReader(path)
	if err != nil {
		t.Fatalf("OpenReader: %v", err)
	}
	defer func() { _ = r.Close() }()

	if got := r.SignatureString(); got != "SMK2" {
		t.Errorf("signature = %q, want SMK2", got)
	}
	if got := r.Width(); got != 640 {
		t.Errorf("width = %d, want 640", got)
	}
	if got := r.Height(); got != 240 {
		t.Errorf("height = %d, want 240", got)
	}
	if got := r.FrameCount(); got != 599 {
		t.Errorf("frames = %d, want 599", got)
	}
	// Stored as a sign-encoded value (-3333), so the decoded rate is ~30.003.
	if got := r.FrameRate(); got < 29.9 || got > 30.1 {
		t.Errorf("fps = %.4f, want ~30", got)
	}
	if !r.HasAudio() {
		t.Fatal("expected at least one audio track")
	}
}

// TestParseAllVideos walks every Smacker file under data/ and asserts the
// header parses with sane geometry — exercising the parser across the full
// shipped corpus rather than a single hand-picked file.
func TestParseAllVideos(t *testing.T) {
	dir := testutil.UnpackedDir(t, "data")

	var seen int
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".zrb" && ext != ".smk" {
			return nil
		}
		r, err := smacker.OpenReader(path)
		if err != nil {
			t.Errorf("%s: %v", filepath.Base(path), err)
			return nil
		}
		defer func() { _ = r.Close() }()

		if r.Width() <= 0 || r.Height() <= 0 {
			t.Errorf("%s: bad dimensions %dx%d", filepath.Base(path), r.Width(), r.Height())
		}
		if r.FrameCount() <= 0 {
			t.Errorf("%s: frame count %d", filepath.Base(path), r.FrameCount())
		}
		if r.FrameRate() <= 0 {
			t.Errorf("%s: frame rate %.2f", filepath.Base(path), r.FrameRate())
		}
		seen++
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if seen == 0 {
		t.Skip("no .zrb/.smk files found under data/")
	}
	t.Logf("parsed %d Smacker files", seen)
}

// TestRejectsNonSmacker confirms the parser refuses a file whose signature is
// not SMK2/SMK4 with a clear error rather than panicking or returning garbage.
func TestRejectsNonSmacker(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "bogus.zrb")
	if err := os.WriteFile(tmp, []byte("NOPE-not-a-smacker-header-padding-bytes-0000"), 0o644); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	if _, err := smacker.OpenReader(tmp); err == nil {
		t.Fatal("expected an error parsing a non-Smacker file")
	}
}

// TestInfo checks the human-readable summary contains the key fields.
func TestInfo(t *testing.T) {
	path := testutil.UnpackedFile(t, "data", "1.zrb")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}
	r, err := smacker.OpenReader(path)
	if err != nil {
		t.Fatalf("OpenReader: %v", err)
	}
	defer func() { _ = r.Close() }()

	info := r.Info()
	for _, want := range []string{"Smacker Video File", "SMK2", "640x240", "Frames: 599"} {
		if !strings.Contains(info, want) {
			t.Errorf("Info() missing %q\n%s", want, info)
		}
	}
}

// TestConvertToMP4 decodes the smallest shipped Smacker clip to MP4 via FFmpeg.
// It is skipped when ffmpeg is unavailable so CI without it still passes.
func TestConvertToMP4(t *testing.T) {
	if !smacker.FFmpegAvailable() {
		t.Skip("ffmpeg not on PATH — skipping conversion test")
	}
	dir := testutil.UnpackedDir(t, "data")

	// Pick the smallest .zrb so the decode is quick.
	var smallest string
	var smallestSize int64 = 1 << 62
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".zrb" && ext != ".smk" {
			return nil
		}
		if info, err := d.Info(); err == nil && info.Size() < smallestSize {
			smallestSize = info.Size()
			smallest = path
		}
		return nil
	})
	if smallest == "" {
		t.Skip("no .zrb/.smk files found under data/")
	}

	out := filepath.Join(t.TempDir(), "out.mp4")
	if err := smacker.ConvertToMP4(smallest, out); err != nil {
		t.Fatalf("ConvertToMP4(%s): %v", filepath.Base(smallest), err)
	}
	info, err := os.Stat(out)
	if err != nil {
		t.Fatalf("output not created: %v", err)
	}
	if info.Size() == 0 {
		t.Fatal("output MP4 is empty")
	}
}
