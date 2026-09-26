package mount

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	"github.com/coreprime/kbot/internal/gamevfs"
	"github.com/coreprime/kbot/internal/kbotctx"
)

func writeArchive(t *testing.T, path string, noTrailer bool, name, body string) {
	t.Helper()
	w, err := hpiv1.CreateWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	if noTrailer {
		w.AllowNonGameTrailer = true
		w.SetTrailer(nil)
	}
	if err := w.AddFileFromBytes(name, []byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestPrintStatsShowsMountOrderAndSkipped(t *testing.T) {
	dir := t.TempDir()
	writeArchive(t, filepath.Join(dir, "totala1.hpi"), false, "units/a.fbi", "hpi")
	writeArchive(t, filepath.Join(dir, "ccdata.ccx"), false, "units/a.fbi", "ccx")
	writeArchive(t, filepath.Join(dir, "broken.hpi"), true, "units/a.fbi", "bare")
	if err := os.WriteFile(filepath.Join(dir, "junk.ufo"), []byte("not an archive"), 0o644); err != nil {
		t.Fatal(err)
	}
	v, err := gamevfs.Open(dir, kbotctx.GameTotalA)
	if err != nil {
		t.Fatalf("a junk archive must not stop the mount: %v", err)
	}
	defer func() { _ = v.Close() }()

	var buf bytes.Buffer
	printStats(&buf, v)
	out := buf.String()
	for _, want := range []string{
		"Archives: 2",
		"Skipped Archives: 2",
		"Archive discovery: game-order",
		"1. ccdata.ccx",
		"2. totala1.hpi",
		"broken.hpi: missing the Cavedog copyright trailer",
		"junk.ufo:",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("stats output lacks %q:\n%s", want, out)
		}
	}
}
