// Package testutil provides helpers for tests that depend on TA game assets.
package testutil

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// canSkip returns true if tests are allowed to skip when assets are missing.
// When ALLOW_SKIP_ASSETS is not "true", missing assets cause a hard failure.
func canSkip() bool {
	return strings.EqualFold(os.Getenv("ALLOW_SKIP_ASSETS"), "true")
}

// UnpackedPath returns the TA_UNPACKED_PATH or skips/fails the test.
func UnpackedPath(t *testing.T) string {
	t.Helper()
	p := os.Getenv("TA_UNPACKED_PATH")
	if p == "" {
		if canSkip() {
			t.Skip("TA_UNPACKED_PATH not set — skipping test that requires unpacked game assets")
		}
		t.Fatal("TA_UNPACKED_PATH not set — set it in .env.local or set ALLOW_SKIP_ASSETS=true to skip")
	}
	if _, err := os.Stat(p); err != nil {
		if canSkip() {
			t.Skipf("TA_UNPACKED_PATH=%s not found: %v", p, err)
		}
		t.Fatalf("TA_UNPACKED_PATH=%s not found: %v", p, err)
	}
	return p
}

// PackedPath returns the TA_PACKED_PATH or skips/fails the test.
func PackedPath(t *testing.T) string {
	t.Helper()
	p := os.Getenv("TA_PACKED_PATH")
	if p == "" {
		if canSkip() {
			t.Skip("TA_PACKED_PATH not set — skipping test that requires packed game archives")
		}
		t.Fatal("TA_PACKED_PATH not set — set it in .env.local or set ALLOW_SKIP_ASSETS=true to skip")
	}
	if _, err := os.Stat(p); err != nil {
		if canSkip() {
			t.Skipf("TA_PACKED_PATH=%s not found: %v", p, err)
		}
		t.Fatalf("TA_PACKED_PATH=%s not found: %v", p, err)
	}
	return p
}

// UnpackedFile returns the full path to a file within the unpacked assets,
// or skips the test if TA_UNPACKED_PATH is not set.
func UnpackedFile(t *testing.T, rel ...string) string {
	t.Helper()
	base := UnpackedPath(t)
	return filepath.Join(append([]string{base}, rel...)...)
}

// UnpackedDir returns the full path to a directory within the unpacked assets,
// or skips the test if the directory doesn't exist.
func UnpackedDir(t *testing.T, rel ...string) string {
	t.Helper()
	p := UnpackedFile(t, rel...)
	if _, err := os.Stat(p); err != nil {
		t.Skipf("directory not available: %s", p)
	}
	return p
}

// TAKUnpackedPath returns the TAK_UNPACKED_PATH (unpacked TA: Kingdoms assets)
// or skips/fails the test the same way UnpackedPath does.
func TAKUnpackedPath(t *testing.T) string {
	t.Helper()
	p := os.Getenv("TAK_UNPACKED_PATH")
	if p == "" {
		if canSkip() {
			t.Skip("TAK_UNPACKED_PATH not set — skipping test that requires unpacked TA: Kingdoms assets")
		}
		t.Fatal("TAK_UNPACKED_PATH not set — set it in .env.local or set ALLOW_SKIP_ASSETS=true to skip")
	}
	if _, err := os.Stat(p); err != nil {
		if canSkip() {
			t.Skipf("TAK_UNPACKED_PATH=%s not found: %v", p, err)
		}
		t.Fatalf("TAK_UNPACKED_PATH=%s not found: %v", p, err)
	}
	return p
}

// TAKUnpackedFile returns the full path to a file within the unpacked TA:
// Kingdoms assets, or skips the test if TAK_UNPACKED_PATH is not set.
func TAKUnpackedFile(t *testing.T, rel ...string) string {
	t.Helper()
	base := TAKUnpackedPath(t)
	return filepath.Join(append([]string{base}, rel...)...)
}

// TAKUnpackedDir returns the full path to a directory within the unpacked TA:
// Kingdoms assets, or skips the test if the directory doesn't exist.
func TAKUnpackedDir(t *testing.T, rel ...string) string {
	t.Helper()
	p := TAKUnpackedFile(t, rel...)
	if _, err := os.Stat(p); err != nil {
		t.Skipf("directory not available: %s", p)
	}
	return p
}
