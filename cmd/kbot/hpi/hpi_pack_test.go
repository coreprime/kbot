package hpi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/formats/hpi"
)

func packSource(t *testing.T) string {
	t.Helper()
	src := t.TempDir()
	if err := os.MkdirAll(filepath.Join(src, "units"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := strings.Repeat("[UNITINFO]{UnitName=ARMFOO;}\n", 40)
	if err := os.WriteFile(filepath.Join(src, "units", "armfoo.fbi"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return src
}

func runPack(t *testing.T, args ...string) (string, error) {
	t.Helper()
	out := filepath.Join(t.TempDir(), "out.ufo")
	cmd := newHPIPackCommand()
	cmd.SetArgs(append([]string{packSource(t), "--target", out}, args...))
	cmd.SilenceUsage = true
	cmd.SilenceErrors = true
	return out, cmd.Execute()
}

func TestPackDefaultsAreMountable(t *testing.T) {
	out, err := runPack(t)
	if err != nil {
		t.Fatal(err)
	}
	v, err := hpi.Validate(out)
	if err != nil || !v.GameMountable || v.TrailerYear != "1997" || !v.Encrypted {
		t.Errorf("default pack: %+v, %v", v, err)
	}
}

func TestPackRefusesKey255(t *testing.T) {
	if _, err := runPack(t, "--key", "255"); err == nil || !strings.Contains(err.Error(), "not encrypted") {
		t.Errorf("--key 255: err = %v", err)
	}
	out, err := runPack(t, "--key", "0")
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := hpi.Validate(out); v == nil || v.Encrypted || !v.GameMountable {
		t.Errorf("--key 0 should write a mountable unencrypted archive: %+v", v)
	}
}

func TestPackTrailerFlags(t *testing.T) {
	for _, bad := range []string{"", "Copyright 1997 Cavedog", "Hello"} {
		if _, err := runPack(t, "--trailer", bad); err == nil {
			t.Errorf("--trailer %q should be refused", bad)
		}
	}
	out, err := runPack(t, "--trailer", "Copyright 1998 Cavedog Entertainment")
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := hpi.Validate(out); v == nil || v.TrailerYear != "1998" || !v.GameMountable {
		t.Errorf("--trailer 1998: %+v", v)
	}
	out, err = runPack(t, "--no-trailer")
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := hpi.Validate(out); v == nil || v.GameMountable || v.Problem != hpi.MountNoTrailer {
		t.Errorf("--no-trailer: %+v", v)
	}
}

func TestPackMethodNoneStores(t *testing.T) {
	out, err := runPack(t, "--method", "none")
	if err != nil {
		t.Fatal(err)
	}
	r, err := hpi.OpenReader(out)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	e := r.Find("units/armfoo.fbi")
	if e == nil || e.CompType != hpi.CompressionNone {
		t.Fatalf("units/armfoo.fbi = %+v, want a stored (CompType 0) entry", e)
	}
}

func TestPackV2RefusesV1Flags(t *testing.T) {
	if _, err := runPack(t, "--format", "v2", "--key", "0"); err == nil {
		t.Errorf("--key with --format v2 should be refused")
	}
	if _, err := runPack(t, "--format", "v2", "--no-trailer"); err == nil {
		t.Errorf("--no-trailer with --format v2 should be refused")
	}
	if _, err := runPack(t, "--format", "v2"); err != nil {
		t.Errorf("plain v2 pack: %v", err)
	}
}
