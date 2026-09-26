package gamevfs

import (
	"path/filepath"
	"strings"
	"testing"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
)

func TestVerdict(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.ufo")
	writeArchive(t, good, false, file{"a.txt", "a"})
	bare := filepath.Join(dir, "bare.hpi")
	writeArchive(t, bare, true, file{"a.txt", "a"})
	kingdoms := filepath.Join(dir, "k.hpi")
	writeV2Archive(t, kingdoms, file{"a.txt", "a"})
	plain := filepath.Join(dir, "plain.hpi")
	w, err := hpiv1.CreateWriter(plain)
	if err != nil {
		t.Fatal(err)
	}
	w.HeaderKey = 0xFF
	if err := w.AddFileFromBytes("a.txt", []byte("a")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	v, err := ValidateFile(good)
	if err != nil || !v.Mountable || v.Line != "TA 3.1c would mount: yes" || !v.TrailerValid || v.TrailerYear != "1997" {
		t.Errorf("good: %+v %v", v, err)
	}
	if v.KeyNote() != "0xBF (XOR key 0xFE)" {
		t.Errorf("KeyNote = %q", v.KeyNote())
	}
	v, _ = ValidateFile(bare)
	if v.Mountable || !strings.HasPrefix(v.Line, "TA 3.1c would mount: no, ") || !strings.Contains(v.Reason, "trailer") {
		t.Errorf("bare: %+v", v)
	}
	v, _ = ValidateFile(kingdoms)
	if v.Mountable || !strings.Contains(v.Reason, "TA: Kingdoms") {
		t.Errorf("kingdoms: %+v", v)
	}
	v, _ = ValidateFile(plain)
	if !v.Mountable || v.Encrypted || v.KeyNote() != "0xFF (not encrypted)" {
		t.Errorf("0xFF key: %+v, %s", v, v.KeyNote())
	}
	if _, err := ValidateFile(filepath.Join(dir, "missing.hpi")); err == nil {
		t.Errorf("missing file should error")
	}
}
