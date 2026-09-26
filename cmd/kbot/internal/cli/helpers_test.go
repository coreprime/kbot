package cli_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	hpiv2 "github.com/coreprime/kbot-io/formats/hpi/v2"
	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
)

// TestOpenContextVFSSkipsArchivesTheGameRefuses mounts a directory holding a
// junk .ufo, a trailerless .hpi and a TA: Kingdoms archive next to a good
// archive: the mount succeeds, uses TA 3.1c's order, and reports the three
// files as skipped instead of failing.
func TestOpenContextVFSSkipsArchivesTheGameRefuses(t *testing.T) {
	dir := t.TempDir()
	good, err := hpiv1.CreateWriter(filepath.Join(dir, "good.hpi"))
	if err != nil {
		t.Fatal(err)
	}
	_ = good.AddFileFromBytes("units/a.fbi", []byte("good"))
	if err := good.Close(); err != nil {
		t.Fatal(err)
	}
	bare, err := hpiv1.CreateWriter(filepath.Join(dir, "a-bare.hpi"))
	if err != nil {
		t.Fatal(err)
	}
	bare.AllowNonGameTrailer = true
	bare.SetTrailer(nil)
	_ = bare.AddFileFromBytes("units/a.fbi", []byte("bare"))
	if err := bare.Close(); err != nil {
		t.Fatal(err)
	}
	tak, err := hpiv2.CreateWriter(filepath.Join(dir, "a-tak.hpi"))
	if err != nil {
		t.Fatal(err)
	}
	_ = tak.AddFileFromBytes("units/a.fbi", []byte("tak"))
	if err := tak.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken.ufo"), []byte("partial download"), 0o644); err != nil {
		t.Fatal(err)
	}

	vfs, source, err := cli.OpenContextVFS(dir)
	if err != nil {
		t.Fatalf("OpenContextVFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()
	if source != "flag" {
		t.Errorf("source = %q", source)
	}
	if data, err := vfs.ReadFile("units/a.fbi"); err != nil || string(data) != "good" {
		t.Errorf("units/a.fbi = %q, %v; want the only archive the game mounts", data, err)
	}
	skipped := map[string]filesystem.SkipReason{}
	for _, s := range vfs.SkippedArchives() {
		skipped[s.Name] = s.Reason
	}
	if skipped["a-bare.hpi"] != filesystem.SkipNoTrailer || skipped["a-tak.hpi"] != filesystem.SkipVersion || skipped["broken.ufo"] == "" {
		t.Errorf("skipped = %v", skipped)
	}
}
