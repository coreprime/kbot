package studio

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreprime/kbot/filesystem"
)

// setupVFSAPI writes a small loose-file tree to a temp dir, mounts it, and
// installs it as the package-level vfs + renderer the handlers read. It
// restores the previous globals on cleanup so it composes with other tests
// that swap vfs.
func setupVFSAPI(t *testing.T) *Session {
	t.Helper()

	base := t.TempDir()
	write := func(rel, body string) {
		full := filepath.Join(base, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}

	write("maps/notes.txt", "hello world")
	write("maps/test.ota", "[GlobalHeader]\n{\n\tmissionname=Test Mission;\n}\n")

	mounted, err := filesystem.NewVirtualFileSystem(base, nil)
	if err != nil {
		t.Fatalf("NewVirtualFileSystem: %v", err)
	}

	sess := newSession("test", "test", mounted, t.TempDir())
	t.Cleanup(func() { _ = mounted.Close() })
	return sess
}

func doVFS(t *testing.T, sess *Session, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	sess.handleVFS(rec, req)
	return rec
}

func TestVFSListing(t *testing.T) {
	sess := setupVFSAPI(t)

	rec := doVFS(t, sess, "/api/vfs/maps/")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var resp struct {
		Path    string     `json:"path"`
		Entries []vfsEntry `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Path != "maps" {
		t.Errorf("path = %q, want maps", resp.Path)
	}

	byName := map[string]vfsEntry{}
	for _, e := range resp.Entries {
		byName[e.Name] = e
	}
	notes, ok := byName["notes.txt"]
	if !ok {
		t.Fatalf("notes.txt missing from listing %+v", resp.Entries)
	}
	if notes.Type != "file" || notes.Size != int64(len("hello world")) {
		t.Errorf("notes.txt = %+v, want file of 11 bytes", notes)
	}
}

func TestVFSRawServesBytesWithETag(t *testing.T) {
	sess := setupVFSAPI(t)

	rec := doVFS(t, sess, "/api/vfs/maps/notes.txt")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "hello world" {
		t.Errorf("body = %q, want hello world", got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Errorf("content-type = %q, want text/plain", ct)
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}

	// A matching If-None-Match short-circuits to 304.
	req := httptest.NewRequest(http.MethodGet, "/api/vfs/maps/notes.txt", nil)
	req.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	sess.handleVFS(rec2, req)
	if rec2.Code != http.StatusNotModified {
		t.Errorf("conditional GET status = %d, want 304", rec2.Code)
	}
}

func TestVFSDescribeOTA(t *testing.T) {
	sess := setupVFSAPI(t)

	rec := doVFS(t, sess, "/api/vfs/maps/test.ota?describe")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["format"] != "OTA" {
		t.Errorf("format = %v, want OTA", resp["format"])
	}
	if resp["name"] != "test.ota" {
		t.Errorf("name = %v, want test.ota", resp["name"])
	}
	if _, ok := resp["sections"]; !ok {
		t.Errorf("describe missing sections: %v", resp)
	}
}

func TestVFSMetadataCombinesFields(t *testing.T) {
	sess := setupVFSAPI(t)

	rec := doVFS(t, sess, "/api/vfs/maps/test.ota?metadata")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp struct {
		Path     string         `json:"path"`
		Name     string         `json:"name"`
		Size     int64          `json:"size"`
		Layering []any          `json:"layering"`
		Describe map[string]any `json:"describe"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Name != "test.ota" || resp.Size == 0 {
		t.Errorf("identity wrong: %+v", resp)
	}
	if len(resp.Layering) == 0 {
		t.Errorf("layering empty, want at least the physical layer")
	}
	if resp.Describe["format"] != "OTA" {
		t.Errorf("describe.format = %v, want OTA", resp.Describe["format"])
	}
}

func TestVFSMissingFile(t *testing.T) {
	sess := setupVFSAPI(t)

	if rec := doVFS(t, sess, "/api/vfs/maps/missing.txt"); rec.Code != http.StatusNotFound {
		t.Errorf("raw missing status = %d, want 404", rec.Code)
	}
	if rec := doVFS(t, sess, "/api/vfs/nope/"); rec.Code != http.StatusNotFound {
		t.Errorf("listing missing dir status = %d, want 404", rec.Code)
	}
}
