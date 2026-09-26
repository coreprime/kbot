package mount

import (
	"os"
	"path/filepath"
	"testing"
)

// TestFlattenWritesTheGamesCopyInsideTarget flattens a TA directory where
// rev31.gp3 and a .ccx both hold units/a.fbi: the flattened file is the
// rev31.gp3 copy, the one TA 3.1c reads, and nothing lands outside the
// target.
func TestFlattenWritesTheGamesCopyInsideTarget(t *testing.T) {
	src := t.TempDir()
	writeArchive(t, filepath.Join(src, "btdata.ccx"), false, "units/a.fbi", "ccx")
	writeArchive(t, filepath.Join(src, "rev31.gp3"), false, "units/a.fbi", "rev")
	writeArchive(t, filepath.Join(src, "bare.ufo"), true, "units/b.fbi", "bare")

	parent := t.TempDir()
	target := filepath.Join(parent, "flat")
	cmd := newFlattenCommand()
	cmd.SetArgs([]string{src, "--target", target, "--verify"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("flatten: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(target, "units", "a.fbi")); err != nil || string(got) != "rev" {
		t.Errorf("units/a.fbi = %q, %v; want the rev31.gp3 copy", got, err)
	}
	if _, err := os.Stat(filepath.Join(target, "units", "b.fbi")); err == nil {
		t.Errorf("bare.ufo has no Cavedog trailer; the game never mounts it")
	}
	entries, _ := os.ReadDir(parent)
	if len(entries) != 1 {
		t.Errorf("flatten wrote outside its target: %v", entries)
	}
}
