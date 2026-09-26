package studio

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	"github.com/coreprime/kbot/internal/gamevfs"
	"github.com/coreprime/kbot/internal/kbotctx"
)

// writeTestArchive writes a version 1 archive of name → body entries, in
// the order given. noTrailer leaves off the Cavedog trailer the game
// requires.
func writeTestArchive(t *testing.T, path string, noTrailer bool, entries ...[2]string) {
	t.Helper()
	w, err := hpiv1.CreateWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	if noTrailer {
		w.AllowNonGameTrailer = true
		w.SetTrailer(nil)
	}
	for _, e := range entries {
		if err := w.AddFileFromBytes(e[0], []byte(e[1])); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

// taInstall builds a tiny TA game directory: rev31.gp3 and btdata.ccx both
// hold anims/armhp1.gaf, a trailerless mod.hpi the game refuses, and a
// loose units/armcom.fbi.
func taInstall(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeTestArchive(t, filepath.Join(dir, "btdata.ccx"), false, [2]string{"anims/armhp1.gaf", "btdata"})
	writeTestArchive(t, filepath.Join(dir, "ccdata.ccx"), false, [2]string{"anims/armhp1.gaf", "ccdata"})
	writeTestArchive(t, filepath.Join(dir, "rev31.gp3"), false, [2]string{"units/armcom.fbi", "rev"})
	writeTestArchive(t, filepath.Join(dir, "mod.hpi"), true, [2]string{"anims/armhp1.gaf", "mod"})
	if err := os.MkdirAll(filepath.Join(dir, "units"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "units", "armcom.fbi"), []byte("loose"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func openTASession(t *testing.T, dir string) *Session {
	t.Helper()
	vfs, err := gamevfs.Open(dir, kbotctx.GameTotalA)
	if err != nil {
		t.Fatal(err)
	}
	sess := newSession("test", "test", vfs, t.TempDir())
	t.Cleanup(func() { _ = vfs.Close() })
	return sess
}

func TestVFSStatsReportsMountOrder(t *testing.T) {
	sess := openTASession(t, taInstall(t))
	rec := doVFS(t, sess, "/api/vfs/?stats")
	var got struct {
		Discovery  string `json:"discovery"`
		MountOrder []struct {
			Position int    `json:"position"`
			Name     string `json:"name"`
		} `json:"mountOrder"`
		SkippedArchives []struct {
			Name   string `json:"name"`
			Reason string `json:"reason"`
		} `json:"skippedArchives"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, rec.Body.String())
	}
	if got.Discovery != "game-order" {
		t.Errorf("discovery = %q", got.Discovery)
	}
	if len(got.MountOrder) != 3 || got.MountOrder[0].Name != "rev31.gp3" || got.MountOrder[1].Name != "btdata.ccx" {
		t.Errorf("mountOrder = %+v", got.MountOrder)
	}
	if len(got.SkippedArchives) != 1 || got.SkippedArchives[0].Name != "mod.hpi" || got.SkippedArchives[0].Reason != "no-trailer" {
		t.Errorf("skippedArchives = %+v", got.SkippedArchives)
	}
}

func TestVFSLayeringMarksTheGameWinner(t *testing.T) {
	sess := openTASession(t, taInstall(t))

	rec := doVFS(t, sess, "/api/vfs/anims/armhp1.gaf?layering")
	var got struct {
		Layers []layerView `json:"layers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Layers) != 2 {
		t.Fatalf("layers = %+v", got.Layers)
	}
	// TA 3.1c mounts btdata.ccx before ccdata.ccx: the first holder wins.
	if got.Layers[0].Source != "btdata.ccx" || got.Layers[0].Mount != 2 || got.Layers[0].Kind != "archive" {
		t.Errorf("active layer = %+v, want btdata.ccx at mount 2", got.Layers[0])
	}
	if got.Layers[1].Source != "ccdata.ccx" || got.Layers[1].Mount != 3 {
		t.Errorf("second layer = %+v", got.Layers[1])
	}
	if data, _ := sess.vfs.ReadFile("anims/armhp1.gaf"); string(data) != "btdata" {
		t.Errorf("anims/armhp1.gaf = %q, want the btdata.ccx copy", data)
	}

	rec = doVFS(t, sess, "/api/vfs/units/armcom.fbi?layering")
	got.Layers = nil
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Layers) != 2 || got.Layers[0].Kind != "loose" || got.Layers[1].Source != "rev31.gp3" || got.Layers[1].Mount != 1 {
		t.Errorf("units/armcom.fbi layers = %+v", got.Layers)
	}
}
