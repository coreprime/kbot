package studio

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHubServesPicker(t *testing.T) {
	mgr := newWorkspaceManager(t.TempDir())
	mux := http.NewServeMux()
	mgr.register(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("picker status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "KBot Studio") {
		t.Errorf("picker body missing title")
	}
}

func TestHubContextsAPI(t *testing.T) {
	mgr := newWorkspaceManager(t.TempDir())
	mux := http.NewServeMux()
	mgr.register(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/hub/contexts", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("contexts status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("content-type = %q, want json", ct)
	}
	if !strings.Contains(rec.Body.String(), "contexts") {
		t.Errorf("response missing contexts key: %s", rec.Body.String())
	}
}

func TestHubWorkspaceRouting(t *testing.T) {
	// A loose directory stands in for a mounted install.
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "maps"), 0o755); err != nil {
		t.Fatal(err)
	}

	mgr := newWorkspaceManager(t.TempDir())
	if _, err := mgr.openLocalPath("local", "Local", base, "totala"); err != nil {
		t.Fatalf("openLocalPath: %v", err)
	}
	mux := http.NewServeMux()
	mgr.register(mux)

	// API subpath is stripped and dispatched to the session mux.
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/workspaces/local/api/studio/heartbeat", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("heartbeat via prefix status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ok") {
		t.Errorf("heartbeat body = %q", rec.Body.String())
	}

	// An unknown workspace id is a 404, not a panic.
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/workspaces/nope/api/studio/heartbeat", nil))
	if rec2.Code != http.StatusNotFound {
		t.Errorf("unknown workspace status = %d, want 404", rec2.Code)
	}
}

func TestSlugAndHash(t *testing.T) {
	if got := slug("My Arm Overhaul!"); got != "my-arm-overhaul" {
		t.Errorf("slug = %q", got)
	}
	if slug("***") != "ws" {
		t.Errorf("empty slug should fall back to ws")
	}
	if shortHash("/a") == shortHash("/b") {
		t.Errorf("distinct paths should hash differently")
	}
}
