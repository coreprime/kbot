package studio

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/internal/assetrender"
)

func TestVFSEventHubFanout(t *testing.T) {
	h := newVFSEventHub()

	ch, _, hasLast := h.subscribe()
	if hasLast {
		t.Error("fresh hub should have no last event")
	}

	h.publish(vfsWarmEvent{Type: "progress", Processed: 1, Total: 3})
	select {
	case evt := <-ch:
		if evt.Type != "progress" || evt.Processed != 1 {
			t.Errorf("unexpected event %+v", evt)
		}
	case <-time.After(time.Second):
		t.Fatal("subscriber did not receive event")
	}

	// A late subscriber should immediately see the last event.
	ch2, last, hasLast := h.subscribe()
	if !hasLast || last.Processed != 1 {
		t.Errorf("late subscriber last = %+v hasLast=%v", last, hasLast)
	}

	h.unsubscribe(ch)
	if _, ok := <-ch; ok {
		t.Error("unsubscribe should close the channel")
	}
	h.unsubscribe(ch2)
}

func TestWarmFileType(t *testing.T) {
	cases := map[string]string{
		".gaf": "gaf",
		".pcx": "pcx",
		".tnt": "tnt",
		".sct": "sct",
		".pal": "pal",
		".fnt": "fnt",
		".txt": "",
		".ota": "",
	}
	for ext, want := range cases {
		if got := warmFileType(ext, false); got != want {
			t.Errorf("warmFileType(%q) = %q, want %q", ext, got, want)
		}
	}
	if got := warmFileType(".smk", true); got != "video" {
		t.Errorf("warmFileType(.smk, videoOK) = %q, want video", got)
	}
	if got := warmFileType(".smk", false); got != "" {
		t.Errorf("warmFileType(.smk, no ffmpeg) = %q, want empty", got)
	}
}

func TestWarmOnePalette(t *testing.T) {
	base := t.TempDir()
	palPath := filepath.Join(base, "palettes", "test.pal")
	if err := os.MkdirAll(filepath.Dir(palPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	pal := make([]byte, 256*4)
	for i := 0; i < 256; i++ {
		pal[i*4] = byte(i)
		pal[i*4+3] = 255
	}
	if err := os.WriteFile(palPath, pal, 0o644); err != nil {
		t.Fatalf("write pal: %v", err)
	}

	mounted, err := filesystem.NewVirtualFileSystem(base, nil)
	if err != nil {
		t.Fatalf("mount: %v", err)
	}
	defer func() { _ = mounted.Close() }()

	prevVFS, prevRenderer := vfs, renderer
	vfs = mounted
	renderer = assetrender.New(mounted, assetrender.Options{CacheDir: t.TempDir()})
	defer func() { vfs, renderer = prevVFS, prevRenderer }()

	files := collectWarmFiles("")
	if len(files) != 1 || files[0].fileType != "pal" {
		t.Fatalf("collectWarmFiles = %+v, want one pal", files)
	}
	if cached := warmOne(files[0]); cached == 0 {
		t.Error("warmOne produced no cached representations for a palette")
	}
}
