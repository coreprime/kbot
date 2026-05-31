package bik_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/formats/bik"
	"github.com/coreprime/kbot/testutil"
)

// TestKnownHeader pins the parsed fields of a specific shipped cutscene so a
// regression in the byte layout is caught immediately.
func TestKnownHeader(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "movies", "takmission14_ph.bik")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}

	r, err := bik.OpenReader(path)
	if err != nil {
		t.Fatalf("OpenReader: %v", err)
	}
	defer func() { _ = r.Close() }()

	if got := r.Width(); got != 640 {
		t.Errorf("width = %d, want 640", got)
	}
	if got := r.Height(); got != 350 {
		t.Errorf("height = %d, want 350", got)
	}
	if got := r.FrameCount(); got != 495 {
		t.Errorf("frames = %d, want 495", got)
	}
	if got := r.FrameRate(); got != 15 {
		t.Errorf("fps = %.2f, want 15", got)
	}
	if !r.HasAudio() {
		t.Fatal("expected an audio track")
	}
	tr := r.Header().AudioTracks[0]
	if tr.Bits != 16 || tr.Channels != 2 {
		t.Errorf("audio = %d-bit %d-channel, want 16-bit 2-channel", tr.Bits, tr.Channels)
	}
	if tr.SampleRate < 20000 || tr.SampleRate > 48000 {
		t.Errorf("audio sample rate %d Hz out of plausible range", tr.SampleRate)
	}
	if r.Header().Revision != 'f' {
		t.Errorf("revision = %q, want 'f'", r.Header().Revision)
	}
}

// TestParseAllMovies walks every Bink file under movies/ and asserts the
// header parses with sane geometry — exercising the parser across the full
// shipped corpus rather than a single hand-picked file.
func TestParseAllMovies(t *testing.T) {
	dir := testutil.TAKUnpackedDir(t, "movies")

	var seen int
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".bik") {
			return nil
		}
		r, err := bik.OpenReader(path)
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
		t.Skip("no .bik files found under movies/")
	}
	t.Logf("parsed %d Bink files", seen)
}

// TestRejectsEncrypted confirms the parser refuses the scrambled Boneyards UI
// movies (which carry a .bik extension but are not Bink containers) with a
// clear error rather than panicking or returning garbage.
func TestRejectsEncrypted(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "boneyards", "metagame", "ftuimovie2.bik")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}
	if _, err := bik.OpenReader(path); err == nil {
		t.Fatal("expected an error parsing a non-Bink .bik file")
	}
}

// TestInfo checks the human-readable summary contains the key fields.
func TestInfo(t *testing.T) {
	path := testutil.TAKUnpackedFile(t, "movies", "takmission14_ph.bik")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("sample not available: %v", err)
	}
	r, err := bik.OpenReader(path)
	if err != nil {
		t.Fatalf("OpenReader: %v", err)
	}
	defer func() { _ = r.Close() }()

	info := r.Info()
	for _, want := range []string{"Bink Video File", "640x350", "Frames: 495", "Has Audio: true"} {
		if !strings.Contains(info, want) {
			t.Errorf("Info() missing %q\n%s", want, info)
		}
	}
}

// TestConvertToMP4 decodes the smallest shipped Bink clip to MP4 via FFmpeg.
// It is skipped when ffmpeg is unavailable so CI without it still passes.
func TestConvertToMP4(t *testing.T) {
	if !bik.FFmpegAvailable() {
		t.Skip("ffmpeg not on PATH — skipping conversion test")
	}
	dir := testutil.TAKUnpackedDir(t, "movies")

	// Pick the smallest .bik so the round-trip is quick.
	var smallest string
	var smallestSize int64 = 1 << 62
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".bik") {
			return nil
		}
		if info, err := d.Info(); err == nil && info.Size() < smallestSize {
			smallestSize = info.Size()
			smallest = path
		}
		return nil
	})
	if smallest == "" {
		t.Skip("no .bik files found under movies/")
	}

	out := filepath.Join(t.TempDir(), "out.mp4")
	if err := bik.ConvertToMP4(smallest, out); err != nil {
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
