package hpi

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot-io/formats/hpi"
	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
)

// writeHostileArchive writes an unencrypted, uncompressed archive, then
// renames its "zz" and "yy" directories to ".." in place, the way a
// hand-made archive can: the entries become ../../escape.txt and
// units/../x.fbi. It also stores a.txt then A.TXT, which the game reads as
// one file: the last.
func writeHostileArchive(t *testing.T, path string) {
	t.Helper()
	w, err := hpiv1.CreateWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	w.HeaderKey = 0
	w.CompressionMethod = hpi.CompressionNone
	for _, f := range [][2]string{
		{"zz/zz/escape.txt", "ESCAPED"},
		{"units/yy/x.fbi", "TRAVERSED"},
		{"units/ok.fbi", "OK"},
		{"a.txt", "first"},
		{"A.TXT", "second"},
	} {
		if err := w.AddFileFromBytes(f[0], []byte(f[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"zz", "yy"} {
		old := []byte(name + "\x00")
		if bytes.Count(data, old) == 0 {
			t.Fatalf("directory name %q not found in the plaintext directory", name)
		}
		data = bytes.ReplaceAll(data, old, []byte("..\x00"))
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestExtractStaysInsideTarget(t *testing.T) {
	work := t.TempDir()
	archive := filepath.Join(work, "hostile.hpi")
	writeHostileArchive(t, archive)

	target := filepath.Join(work, "a", "b", "out")
	cmd := newHPIExtractCommand()
	cmd.SetArgs([]string{archive, "--target", target})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("extract: %v", err)
	}

	for _, escaped := range []string{
		filepath.Join(work, "a", "escape.txt"),
		filepath.Join(target, "escape.txt"),
		filepath.Join(target, "units", "x.fbi"),
		filepath.Join(target, "x.fbi"),
	} {
		if _, err := os.Stat(escaped); err == nil {
			t.Errorf("%s was written; entries with '..' segments must be skipped", escaped)
		}
	}
	if got, err := os.ReadFile(filepath.Join(target, "units", "ok.fbi")); err != nil || string(got) != "OK" {
		t.Errorf("units/ok.fbi = %q, %v", got, err)
	}

	// Only the reachable one of a.txt / A.TXT is written, with its own bytes.
	entries, err := os.ReadDir(target)
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for _, e := range entries {
		if !e.IsDir() {
			texts = append(texts, e.Name())
		}
	}
	if len(texts) != 1 || texts[0] != "A.TXT" {
		t.Fatalf("top-level files = %v, want just A.TXT", texts)
	}
	if got, _ := os.ReadFile(filepath.Join(target, "A.TXT")); string(got) != "second" {
		t.Errorf("A.TXT = %q, want the last entry's bytes", got)
	}
}
