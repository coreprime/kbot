package studio

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/testutil"
)

// setupMapWorkspace mounts a writable work folder over a base folder
// holding maps/test.tnt (16×16 tiles, the given sea level) and maps/test.ota, and
// returns a workspace session and the work folder.
func setupMapWorkspace(t *testing.T, ota string, seaLevel int) (*Session, string) {
	t.Helper()
	base, work := t.TempDir(), t.TempDir()
	builder := newSession("build", "build", nil, t.TempDir())
	m, features, err := builder.buildMap(saveRequest{MapName: "test", TileW: 16, TileH: 16, SeaLevel: seaLevel})
	if err != nil {
		t.Fatalf("buildMap: %v", err)
	}
	var tntBuf bytes.Buffer
	if err := m.Save(&tntBuf, features); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(base, "maps"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "maps", "test.tnt"), tntBuf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "maps", "test.ota"), []byte(ota), 0o644); err != nil {
		t.Fatal(err)
	}
	vfs, err := filesystem.NewLayered([]filesystem.Source{
		{Kind: filesystem.SourceLooseDir, Path: work, Writable: true, Label: "work"},
		{Kind: filesystem.SourceLooseDir, Path: base},
	}, nil)
	if err != nil {
		t.Fatalf("NewLayered: %v", err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	sess := newSession("ws", "ws", vfs, t.TempDir())
	sess.workDir = work
	return sess, work
}

// loadTestMap opens maps/test.tnt through the editor's load endpoint and
// returns the save request an untouched editor would post.
func loadTestMap(t *testing.T, sess *Session) (loadResponse, saveRequest) {
	t.Helper()
	rec := httptest.NewRecorder()
	sess.handleMapLoad(rec, httptest.NewRequest(http.MethodGet, "/api/studio/load?path=maps/test.tnt", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("load: %d %s", rec.Code, rec.Body.String())
	}
	var resp loadResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode load: %v", err)
	}
	req := saveRequest{MapName: "test", TileW: resp.TileW, TileH: resp.TileH, Heights: resp.Heights, Voids: resp.Voids, OTA: resp.OTA}
	for _, tile := range resp.Tiles {
		req.Tiles = append(req.Tiles, &saveStamp{SectionPath: resp.TilePoolKey, SX: tile.SX, SY: tile.SY})
	}
	if resp.OTA != nil {
		req.SeaLevel = resp.OTA.SeaLevel
	}
	return resp, req
}

// postSave posts a save request (round-tripped through JSON, as the editor
// sends it) and returns the recorder.
func postSave(t *testing.T, sess *Session, req saveRequest) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	sess.handleSave(rec, httptest.NewRequest(http.MethodPost, "/api/studio/save", bytes.NewReader(body)))
	return rec
}

type saveReceipt struct {
	Saved    []string `json:"saved"`
	Warnings []string `json:"warnings"`
}

// TestMapEditorLoadSeaLevelFromTNT checks the editor's sea level is the
// .tnt header's, which the game uses, not the .ota's sealevel key.
func TestMapEditorLoadSeaLevelFromTNT(t *testing.T) {
	sess, _ := setupMapWorkspace(t, editorOTA, 25)
	resp, _ := loadTestMap(t, sess)
	if resp.OTA == nil || resp.OTA.SeaLevel != 25 {
		t.Fatalf("editor sea level = %+v, want the TNT header's 25 (the .ota says 40)", resp.OTA)
	}
}

// TestMapEditorSaveEditsOTAInPlace drives the editor's load and save
// endpoints: an untouched save leaves the .ota alone, and an edit rewrites
// only the edited value.
func TestMapEditorSaveEditsOTAInPlace(t *testing.T) {
	sess, work := setupMapWorkspace(t, editorOTA, 40)
	resp, req := loadTestMap(t, sess)
	if resp.OTA == nil || resp.OTA.Error != "" || resp.OTA.Source == "" {
		t.Fatalf("load OTA = %+v", resp.OTA)
	}

	rec := postSave(t, sess, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}
	var receipt saveReceipt
	if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if len(receipt.Saved) != 1 || receipt.Saved[0] != "maps/test.tnt" {
		t.Errorf("untouched save wrote %v, want only the .tnt", receipt.Saved)
	}

	// Saving drops the parsed map the tile stamps point into; the editor
	// reloads before saving again.
	_, req = loadTestMap(t, sess)
	req.OTA.MissionName = "Renamed"
	req.OTA.SeaLevel, req.SeaLevel = 45, 45
	rec = postSave(t, sess, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(work, "maps", "test.ota"))
	if err != nil {
		t.Fatalf("read saved ota: %v", err)
	}
	// The new sea level goes to the .tnt and keeps the existing key in step.
	want := strings.Replace(editorOTA, "missionname=Rocky Road;", "missionname=Renamed;", 1)
	want = strings.Replace(want, "sealevel=40;", "sealevel=45;", 1)
	if string(got) != want {
		t.Errorf("saved .ota:\n%s\nwant:\n%s", got, want)
	}

	_, req = loadTestMap(t, sess)
	req.OTA.MissionDescription = "a;b"
	if rec := postSave(t, sess, req); rec.Code != http.StatusBadRequest {
		t.Errorf("text with ';': status %d (%s), want 400", rec.Code, rec.Body.String())
	}
}

// TestMapEditorSaveKeepsUnreadableOTA checks an .ota kbot-io cannot read is
// reported on load and left unchanged by a save, which says so.
func TestMapEditorSaveKeepsUnreadableOTA(t *testing.T) {
	broken := "[GlobalHeader\n{\nmissionname=Broken;\n}\n"
	sess, work := setupMapWorkspace(t, broken, 25)
	resp, req := loadTestMap(t, sess)
	if resp.OTA == nil || resp.OTA.Error == "" {
		t.Fatalf("load OTA = %+v, want an error", resp.OTA)
	}
	req.OTA.MissionName = "Overwrite"
	req.OTA.Schemas = []otaSchema{{Type: "Network 1", StartPos: []saveStartPos{{Number: 1, X: 10, Z: 10}}}}
	rec := postSave(t, sess, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
	}
	var receipt saveReceipt
	if err := json.Unmarshal(rec.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if len(receipt.Warnings) == 0 {
		t.Errorf("no warning for the kept .ota")
	}
	if _, err := os.Stat(filepath.Join(work, "maps", "test.ota")); !os.IsNotExist(err) {
		t.Errorf("the unreadable .ota was written to the workspace (err %v)", err)
	}
}

// TestMapEditorLoadKingdomsMap checks a TA: Kingdoms map opens with its
// [Map Data] start positions (in pixels, StartPos1 first) and the sea level
// its TNT header holds, not invented positions or a pointer value.
func TestMapEditorLoadKingdomsMap(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "maps"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, ext := range []string{".tnt", ".ota"} {
		data, err := os.ReadFile(testutil.TAKUnpackedFile(t, "maps", "abnar's terrace"+ext))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "maps", "abnar"+ext), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	vfs, err := filesystem.NewVirtualFileSystem(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = vfs.Close() })
	sess := newSession("tak", "tak", vfs, t.TempDir())
	rec := httptest.NewRecorder()
	sess.handleMapLoad(rec, httptest.NewRequest(http.MethodGet, "/api/studio/load?path=maps/abnar.tnt", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("load: %d %s", rec.Code, rec.Body.String())
	}
	var resp loadResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.OTA == nil || len(resp.OTA.Schemas) != 1 {
		t.Fatalf("TA:K OTA = %+v, want the [Map Data] setup as one schema", resp.OTA)
	}
	sp := resp.OTA.Schemas[0].StartPos
	if len(sp) != 4 || sp[0].Number != 1 || sp[0].X%16 != 0 {
		t.Errorf("start positions = %+v, want 4 in pixels with StartPos1 first", sp)
	}
	if resp.OTA.SeaLevel <= 0 || resp.OTA.SeaLevel > 255 {
		t.Errorf("sea level = %d, want the TA:K header's height value", resp.OTA.SeaLevel)
	}
}
