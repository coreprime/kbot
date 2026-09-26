package outpath

import (
	"path/filepath"
	"testing"
)

func TestJoinKeepsPathsInsideRoot(t *testing.T) {
	root := filepath.Join(t.TempDir(), "out")
	ok := map[string]string{
		"units/ARMCOM.FBI":         filepath.Join(root, "units", "ARMCOM.FBI"),
		`units\armcom.fbi`:         filepath.Join(root, "units", "armcom.fbi"),
		"maps/the pass.tnt":        filepath.Join(root, "maps", "the pass.tnt"),
		"..hidden/name..with.dots": filepath.Join(root, "..hidden", "name..with.dots"),
	}
	for in, want := range ok {
		got, err := Join(root, in)
		if err != nil || got != want {
			t.Errorf("Join(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{
		"", "../../escape.txt", `..\escape.txt`, "units/../x.fbi", "units/./x.fbi",
		"/etc/passwd", "units//x.fbi", "units/", "a\x00b",
	} {
		if got, err := Join(root, bad); err == nil {
			t.Errorf("Join(%q) = %q, want an error", bad, got)
		}
	}
}
