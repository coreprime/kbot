package pal

import (
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTable(t *testing.T, name string, size int) string {
	t.Helper()
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i)
	}
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func runLookup(t *testing.T, args ...string) error {
	t.Helper()
	cmd := newPALLookupCommand()
	cmd.SetArgs(args)
	cmd.SilenceUsage = true
	cmd.SilenceErrors = true
	return cmd.Execute()
}

func pngSize(t *testing.T, path string) (int, int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	cfg, err := png.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width, cfg.Height
}

// TestLookupRendersGameSizedTables checks that the swatch has one row per
// table row: 256 for a 65,536-byte .ALP and 32 for an 8,192-byte .SHD/.LHT.
func TestLookupRendersGameSizedTables(t *testing.T) {
	for _, tc := range []struct {
		name  string
		size  int
		extra []string
		w, h  int
	}{
		{"palette.alp", 65536, nil, 256, 256},
		{"palette.shd", 8192, nil, 256, 32},
		{"palette.lht", 8192, nil, 256, 32},
		{"blend.bin", 65536, []string{"--kind", "alp"}, 256, 256},
	} {
		src := writeTable(t, tc.name, tc.size)
		out := filepath.Join(t.TempDir(), "out.png")
		args := append([]string{src, "--cell", "1", "--target", out}, tc.extra...)
		if err := runLookup(t, args...); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if w, h := pngSize(t, out); w != tc.w || h != tc.h {
			t.Errorf("%s: swatch %dx%d, want %dx%d", tc.name, w, h, tc.w, tc.h)
		}
	}
}

// TestLookupRejectsWrongSizes checks that tables the game would ignore
// (such as the 1,024-byte tables older tools assumed) are refused.
func TestLookupRejectsWrongSizes(t *testing.T) {
	for _, tc := range []struct {
		name string
		size int
	}{
		{"palette.alp", 1024},
		{"palette.shd", 65536},
		{"palette.lht", 1024},
	} {
		src := writeTable(t, tc.name, tc.size)
		err := runLookup(t, src, "--target", filepath.Join(t.TempDir(), "out.png"))
		if err == nil || !strings.Contains(err.Error(), "size") {
			t.Errorf("%s (%d bytes): err = %v, want a size error", tc.name, tc.size, err)
		}
	}
	if err := runLookup(t, writeTable(t, "table.bin", 8192), "--target", filepath.Join(t.TempDir(), "o.png")); err == nil {
		t.Error("a table with no kind was rendered")
	}
}

// TestDescribeDoesNotCallIndexZeroTransparent checks the index 0 label:
// the game draws it as black in terrain and backdrops.
func TestDescribeDoesNotCallIndexZeroTransparent(t *testing.T) {
	src := writeTable(t, "palette.pal", 1024)
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdout
	os.Stdout = w
	cmd := newPALDescribeCommand()
	cmd.SetArgs([]string{src})
	runErr := cmd.Execute()
	os.Stdout = orig
	_ = w.Close()
	out, _ := io.ReadAll(r)
	if runErr != nil {
		t.Fatal(runErr)
	}
	if strings.Contains(string(out), "transparent sentinel") {
		t.Errorf("describe still calls index 0 a transparent sentinel:\n%s", out)
	}
}
