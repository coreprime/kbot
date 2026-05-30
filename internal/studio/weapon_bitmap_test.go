package studio

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/coreprime/kbot/filesystem"
)

// taPathForSmoke returns the TA install root used by the smoke tests.
// Matches the convention the sct/tnt tests use — TA_UNPACKED_PATH env
// or skip.  No CI invariant: this verifies the handler agrees with the
// REAL stock TA data, which can only happen when the data is mounted.
func taPathForSmoke(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("TA_UNPACKED_PATH"); p != "" {
		return p
	}
	t.Skip("no TA install found — set TA_UNPACKED_PATH to enable")
	return ""
}

// mountVFSForTest wires the package-global vfs at a real TA install for
// the duration of the test, restoring the prior value on cleanup.  All
// the studio handlers read through the same global, so this is the
// switch that puts them in "live" mode.
func mountVFSForTest(t *testing.T) {
	t.Helper()
	taPath := taPathForSmoke(t)
	v, err := filesystem.NewVirtualFileSystem(taPath, &filesystem.Config{})
	if err != nil {
		t.Fatalf("mount VFS at %s: %v", taPath, err)
	}
	prev := vfs
	vfs = v
	t.Cleanup(func() {
		_ = v.Close()
		vfs = prev
		// Drop the bitmap cache too so a subsequent test that mounts a
		// different VFS doesn't serve the previous mount's bytes.
		weaponBitmapMu.Lock()
		weaponBitmapCache = map[string][]byte{}
		weaponBitmapMu.Unlock()
	})
}

// TestHandleWeaponBitmapEMG drives the handler end-to-end for the EMG
// (color=2 → PlasmaMd) and a no-bitmap weapon (ARMCOMLASER, rendertype=0
// laser), confirming the routing + per-weapon resolution works.
func TestHandleWeaponBitmapEMG(t *testing.T) {
	mountVFSForTest(t)

	req := httptest.NewRequest(http.MethodGet, "/api/studio/weapon-bitmap/EMG", nil)
	rr := httptest.NewRecorder()
	handleWeaponBitmap(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("EMG: want 200, got %d (body=%q)", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("EMG: want application/json, got %q", ct)
	}
	var resp weaponBitmapResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
	if resp.FrameCount <= 0 || resp.FrameWidth <= 0 || resp.FrameHeight <= 0 {
		t.Fatalf("EMG: bad metadata %+v", resp)
	}
	if resp.Sequence != "PlasmaMd" {
		t.Fatalf("EMG: want sequence PlasmaMd, got %q", resp.Sequence)
	}
	if resp.Sheet == "" {
		t.Fatalf("EMG: missing sheet bytes")
	}
}

// TestHandleWeaponBitmapNonBitmap confirms a rendertype=0 (laser) weapon
// is rejected by the endpoint — the client falls back to the synthetic
// particle path when it sees the 404.
func TestHandleWeaponBitmapNonBitmap(t *testing.T) {
	mountVFSForTest(t)
	req := httptest.NewRequest(http.MethodGet, "/api/studio/weapon-bitmap/ARMCOMLASER", nil)
	rr := httptest.NewRecorder()
	handleWeaponBitmap(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("ARMCOMLASER: want 404, got %d", rr.Code)
	}
}

// TestHandleWeaponBitmapVTOLEMG covers the second stock-shipped slot
// (color=1 → PlasmaSm) via VTOL_EMG (Hawk's air-to-ground tracer).
func TestHandleWeaponBitmapVTOLEMG(t *testing.T) {
	mountVFSForTest(t)
	req := httptest.NewRequest(http.MethodGet, "/api/studio/weapon-bitmap/VTOL_EMG", nil)
	rr := httptest.NewRecorder()
	handleWeaponBitmap(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("VTOL_EMG: want 200, got %d (body=%q)", rr.Code, rr.Body.String())
	}
	var resp weaponBitmapResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
	if resp.Sequence != "PlasmaSm" {
		t.Fatalf("VTOL_EMG: want sequence PlasmaSm, got %q", resp.Sequence)
	}
}
