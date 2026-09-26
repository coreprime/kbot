package zrb

import (
	"encoding/binary"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/testutil"
)

// captureStdout runs fn with os.Stdout redirected and returns what it wrote.
func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdout
	os.Stdout = w
	runErr := fn()
	os.Stdout = orig
	_ = w.Close()
	out, _ := io.ReadAll(r)
	return string(out), runErr
}

func run(t *testing.T, cmdArgs ...string) (string, error) {
	t.Helper()
	return captureStdout(t, func() error {
		cmd := NewCommand()
		cmd.SetArgs(cmdArgs)
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true
		return cmd.Execute()
	})
}

// TestInfoDecodesTheAudioTrack checks the retail intro: one present audio
// track (22,050 Hz stereo), not seven tracks read from the frame table, and
// the 640x480 picture the game shows.
func TestInfoDecodesTheAudioTrack(t *testing.T) {
	out, err := run(t, "info", testutil.UnpackedFile(t, "data", "1.zrb"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Display: 640x480", "Track 0: 22050 Hz, 2 channels"} {
		if !strings.Contains(out, want) {
			t.Errorf("info lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Track 1") {
		t.Errorf("info lists tracks that are not present:\n%s", out)
	}
}

// TestFromMP4SaysThereIsNoEncoder checks that from-mp4 states plainly that
// no Smacker encoder exists (stock FFmpeg has none).
func TestFromMP4SaysThereIsNoEncoder(t *testing.T) {
	_, err := run(t, "from-mp4", filepath.Join(t.TempDir(), "in.mp4"), filepath.Join(t.TempDir(), "out.smk"))
	if err == nil {
		t.Skip("the installed FFmpeg can write Smacker")
	}
	if !strings.Contains(err.Error(), "no Smacker encoder is available") {
		t.Errorf("error = %v, want a plain 'no Smacker encoder' message", err)
	}
}

// TestFromMP4HelpSaysThereIsNoEncoder checks the one-line help "kbot zrb
// --help" lists: it must not suggest that a Smacker encoder can be found.
func TestFromMP4HelpSaysThereIsNoEncoder(t *testing.T) {
	short := newZRBFromMP4Command().Short
	if !strings.Contains(short, "no Smacker encoder exists") || strings.Contains(short, "needs") {
		t.Errorf("from-mp4 short help = %q, want it to say plainly that no Smacker encoder exists", short)
	}
	if !strings.Contains(NewCommand().Long, "no Smacker encoder exists") {
		t.Errorf("zrb help does not say that no Smacker encoder exists: %q", NewCommand().Long)
	}
}

// shortRetailMovie writes the first frames of the retail intro as a
// complete, shorter Smacker file.
func shortRetailMovie(t *testing.T, frames int) string {
	t.Helper()
	data, err := os.ReadFile(testutil.UnpackedFile(t, "data", "1.zrb"))
	if err != nil {
		t.Fatal(err)
	}
	le := binary.LittleEndian
	entries := int(le.Uint32(data[12:]))
	flags := le.Uint32(data[20:])
	if flags&1 != 0 {
		entries++
	}
	trees := int(le.Uint32(data[52:]))
	sizesAt, typesAt := 104, 104+4*entries
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
	out = append(out, data[payloadAt:min(payloadAt+payload, len(data))]...)
	p := filepath.Join(t.TempDir(), "short.zrb")
	if err := os.WriteFile(p, out, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestToMP4UsesTheDisplayHeight checks that the 640x240 interlaced movie
// becomes a 640x480 MP4, and 640x240 with --stored-height.
func TestToMP4UsesTheDisplayHeight(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffmpeg not on PATH")
	}
	src := shortRetailMovie(t, 4)
	for _, tc := range []struct {
		flags []string
		want  string
	}{
		{nil, "640,480"},
		{[]string{"--line-double"}, "640,480"},
		{[]string{"--stored-height"}, "640,240"},
	} {
		dst := filepath.Join(t.TempDir(), "out.mp4")
		if _, err := run(t, append([]string{"to-mp4", src, dst}, tc.flags...)...); err != nil {
			t.Fatalf("%v: %v", tc.flags, err)
		}
		out, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0",
			"-show_entries", "stream=width,height", "-of", "csv=p=0", "file:"+dst).Output()
		if err != nil {
			t.Fatal(err)
		}
		if got := strings.TrimSpace(string(out)); got != tc.want {
			t.Errorf("%v: mp4 is %s, want %s", tc.flags, got, tc.want)
		}
	}
}
