package hpi

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	hpiv2 "github.com/coreprime/kbot-io/formats/hpi/v2"
)

// captureStdout runs fn with os.Stdout redirected and returns what it wrote.
func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	done := make(chan string)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	runErr := fn()
	os.Stdout = old
	_ = w.Close()
	return <-done, runErr
}

func writeInfoArchive(t *testing.T, path string, key uint8, noTrailer bool) {
	t.Helper()
	w, err := hpiv1.CreateWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	w.HeaderKey = key
	if noTrailer {
		w.AllowNonGameTrailer = true
		w.SetTrailer(nil)
	}
	_ = w.AddFileFromBytes("units/a.fbi", []byte("a"))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

func runInfo(t *testing.T, path string) string {
	t.Helper()
	out, err := captureStdout(t, func() error {
		cmd := newHPIInfoCommand()
		cmd.SetArgs([]string{path})
		return cmd.Execute()
	})
	if err != nil {
		t.Fatalf("info %s: %v", path, err)
	}
	return out
}

func TestInfoSaysWhetherTheGameMounts(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.ufo")
	writeInfoArchive(t, good, 0xBF, false)
	bare := filepath.Join(dir, "bare.hpi")
	writeInfoArchive(t, bare, 0xBF, true)
	plain := filepath.Join(dir, "plain.hpi")
	writeInfoArchive(t, plain, 0xFF, false)
	tak := filepath.Join(dir, "tak.hpi")
	w2, err := hpiv2.CreateWriter(tak)
	if err != nil {
		t.Fatal(err)
	}
	_ = w2.AddFileFromBytes("units/a.fbi", []byte("a"))
	if err := w2.Close(); err != nil {
		t.Fatal(err)
	}

	cases := map[string][]string{
		good:  {"TA 3.1c would mount: yes", "Header Key: 0xBF (XOR key 0xFE)", "Trailer: Copyright 1997 Cavedog Entertainment"},
		bare:  {"TA 3.1c would mount: no, the file does not end with", "Trailer: missing"},
		plain: {"TA 3.1c would mount: yes", "Header Key: 0xFF (not encrypted)"},
		tak:   {"TA 3.1c would mount: no, TA: Kingdoms (version 2) archive"},
	}
	for path, wants := range cases {
		out := runInfo(t, path)
		for _, want := range wants {
			if !strings.Contains(out, want) {
				t.Errorf("%s: output lacks %q:\n%s", filepath.Base(path), want, out)
			}
		}
	}

	out, err := captureStdout(t, func() error {
		cmd := newHPIListCommand()
		cmd.SetArgs([]string{bare, "-v"})
		return cmd.Execute()
	})
	if err != nil || !strings.Contains(out, "TA 3.1c would mount: no,") {
		t.Errorf("list -v: %v\n%s", err, out)
	}
	out, _ = captureStdout(t, func() error {
		cmd := newHPIListCommand()
		cmd.SetArgs([]string{bare})
		return cmd.Execute()
	})
	if strings.TrimSpace(out) != "units/a.fbi" {
		t.Errorf("plain list output must stay one path per line: %q", out)
	}
}
