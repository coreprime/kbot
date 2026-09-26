package studio

import (
	"encoding/binary"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// captureAssetPanics swaps logAssetPanic for a recorder for the test.
func captureAssetPanics(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var got []string
	prev := logAssetPanic
	logAssetPanic = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, fmt.Sprintf(format, args...))
	}
	t.Cleanup(func() { logAssetPanic = prev })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), got...)
	}
}

func TestRecoverAssetLogsThePathAndSkips(t *testing.T) {
	logs := captureAssetPanics(t)
	if !recoverAsset("map catalogue", "maps/good.tnt", func() {}) {
		t.Error("a normal return reported a panic")
	}
	if recoverAsset("map catalogue", "maps/bad.tnt", func() { panic("makeslice: len out of range") }) {
		t.Error("a panic was not reported")
	}
	got := logs()
	if len(got) != 1 || !strings.Contains(got[0], "maps/bad.tnt") || !strings.Contains(got[0], "makeslice") {
		t.Errorf("log = %q, want one line naming the path and the panic", got)
	}
}

func TestAssetQueueSurvivesAPanickingJob(t *testing.T) {
	logs := captureAssetPanics(t)
	q := newAssetQueue(1)

	done := make(chan struct{})
	go func() {
		defer close(done)
		q.Run("section:sections/bad.sct", func() { panic("index out of range") })
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its job panicked")
	}

	// The single worker is still alive and runs the next job.
	ran := false
	q.Run("section:sections/good.sct", func() { ran = true })
	if !ran {
		t.Error("the queue stopped running jobs after a panic")
	}
	if got := logs(); len(got) != 1 || !strings.Contains(got[0], "sections/bad.sct") {
		t.Errorf("log = %q, want one line naming the job's asset", got)
	}
}

func TestPreloadRecoversFromAPanic(t *testing.T) {
	captureAssetPanics(t)
	sess := &Session{mapCatalog: &mapCatalogState{minimaps: map[string][]byte{}}, preloadProgress: &preloadTracker{}}
	func() {
		defer sess.recoverPreload()
		panic("scan failed")
	}()
	if !sess.mapCatalog.ready {
		t.Error("the map catalogue is still loading after the preload stopped")
	}
	if !sess.preloadProgress.finished {
		t.Error("the preload progress never finished")
	}
}

func TestWarmSizeCheckRejectsImpossibleHeaders(t *testing.T) {
	le := func(words ...uint32) []byte {
		b := make([]byte, 4*len(words))
		for i, w := range words {
			binary.LittleEndian.PutUint32(b[i*4:], w)
		}
		return b
	}
	cases := []struct {
		name, fileType, path string
		data                 []byte
	}{
		{"gaf sequence table past EOF", "gaf", "anims/x.gaf", le(0x00010100, 0x7fff, 0, 16)},
		{"gaf sequence header past EOF", "gaf", "anims/x.gaf", le(0x00010100, 1, 0, 1000)},
		{"sct 65536x65536", "sct", "sections/x.sct", le(3, 0, 0, 28, 0x10000, 0x10000, 28)},
		{"sct tile graphics past EOF", "sct", "sections/x.sct", le(3, 0, 0xFFFFFFFF, 28, 1, 1, 28)},
		{"tnt attribute grid past EOF", "tnt", "maps/x.tnt", append(le(0x2000, 0xFFFFFFFF, 0xFFFFFFFF, 64, 64, 64), make([]byte, 64)...)},
		{"tnt unknown version", "tnt", "maps/x.tnt", make([]byte, 64)},
		// 0x80000000 * 0x80000000 * 4 is 2^64, which wraps to 0 in 64 bits.
		{"tnt attribute grid size over 64 bits", "tnt", "maps/x.tnt", append(le(0x2000, 0x80000000, 0x80000000, 0, 64, 64, 0), make([]byte, 36)...)},
		// 268912474 * 3810976486 cells * 18 bytes wraps to 2936 in 64 bits.
		{"sct tile map size over 64 bits", "sct", "sections/x.sct", append(le(3, 0, 0, 28, 268912474, 3810976486, 28), make([]byte, 2936)...)},
		{"smk not a movie", "video", "video/x.smk", []byte("not a smacker file at all")},
	}
	for _, c := range cases {
		if err := warmSizeCheck(c.fileType, c.path, c.data); err == nil {
			t.Errorf("%s: accepted", c.name)
		}
	}
	// Formats without a check, and .bik video, pass through.
	for _, ft := range []struct{ fileType, path string }{{"pcx", "x.pcx"}, {"pal", "x.pal"}, {"video", "x.bik"}} {
		if err := warmSizeCheck(ft.fileType, ft.path, []byte{1, 2, 3}); err != nil {
			t.Errorf("%s: %v", ft.path, err)
		}
	}
}

// Every retail GAF, SCT, TNT and movie passes the warm-up size check (TA:
// Kingdoms ships one empty GAF, anims/zonlogo.gaf, which has nothing to
// warm).
func TestWarmSizeCheckAcceptsRetailFiles(t *testing.T) {
	roots := []string{}
	for _, env := range []string{"TA_UNPACKED_PATH", "TAK_UNPACKED_PATH"} {
		if p := os.Getenv(env); p != "" {
			roots = append(roots, p)
		}
	}
	if len(roots) == 0 {
		t.Skip("TA_UNPACKED_PATH / TAK_UNPACKED_PATH not set")
	}
	checked := 0
	for _, root := range roots {
		err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			ft := warmFileType(strings.ToLower(filepath.Ext(p)), true)
			if ft == "" || ft == "pcx" || ft == "pal" || ft == "fnt" {
				return nil
			}
			data, err := os.ReadFile(p)
			if err != nil || len(data) == 0 {
				return err
			}
			if err := warmSizeCheck(ft, p, data); err != nil {
				t.Errorf("%s: %v", p, err)
			}
			checked++
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if checked == 0 {
		t.Fatal("no retail files checked")
	}
}
