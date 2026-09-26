package studio

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/formats/tnt"
	"github.com/coreprime/kbot-io/testutil"
)

// TestMapCatalogFormats checks the Open Map picker lists an older 0x1020
// TA map (which TA reads) flagged "legacy", with its numplayers text as
// written, and flags a TA: Kingdoms map "kingdoms".
func TestMapCatalogFormats(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "maps"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A minimal 0x1020 map: 2×2 tiles, 8-byte attribute records.
	const w, h = 4, 4
	hdr := tnt.Header{IDVersion: tnt.VersionLegacy, Width: w, Height: h, PTRMapData: tnt.HeaderSize, Tiles: 1}
	hdr.PTRMapAttr = hdr.PTRMapData + (w/2)*(h/2)*2
	hdr.PTRTileGfx = hdr.PTRMapAttr + w*h*8
	hdr.PTRTileAnim = hdr.PTRTileGfx + tnt.TileGfxSize
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.LittleEndian, &hdr)
	buf.Write(make([]byte, (w/2)*(h/2)*2+w*h*8+tnt.TileGfxSize))
	if err := os.WriteFile(filepath.Join(root, "maps", "old.tnt"), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "maps", "old.ota"), []byte("[GlobalHeader] { missionname=Old; numplayers=2-8; }"), 0o644); err != nil {
		t.Fatal(err)
	}
	tak, err := os.ReadFile(testutil.TAKUnpackedFile(t, "maps", "abnar's terrace.tnt"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "maps", "tak.tnt"), tak, 0o644); err != nil {
		t.Fatal(err)
	}
	vfs, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	sess := newSession("test", "test", vfs, t.TempDir())

	old, _ := sess.summariseMapWithMinimap("maps/old.tnt")
	if old.Format != "legacy" || old.TileW != 2 || old.MissionName != "Old" || old.NumPlayers != "2-8" {
		t.Errorf("0x1020 entry = %+v, want format legacy, 2 tiles wide, Old, numplayers 2-8", old)
	}
	if k, _ := sess.summariseMapWithMinimap("maps/tak.tnt"); k.Format != "kingdoms" {
		t.Errorf("TA: Kingdoms entry format = %q, want kingdoms", k.Format)
	}
}
