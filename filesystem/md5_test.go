package filesystem

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMD5Calculation(t *testing.T) {
	// Create temp directory with test files
	tempDir := t.TempDir()

	// Create test files with known content
	testFiles := map[string]string{
		"file1.txt":      "Hello, World!",
		"file2.txt":      "Testing MD5 calculation",
		"dir1/file3.txt": "Nested file content",
	}

	for path, content := range testFiles {
		fullPath := filepath.Join(tempDir, path)
		_ = os.MkdirAll(filepath.Dir(fullPath), 0755)
		if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
			t.Fatalf("Failed to create test file %s: %v", path, err)
		}
	}

	// Create VFS
	config := &Config{
		Extensions: []string{".hpi"},
	}
	vfs, err := NewVirtualFileSystem(tempDir, config)
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// Wait a bit for background MD5 calculation to complete
	// In a production test, we'd have a way to wait for completion,
	// but for now a short sleep is sufficient for small test files
	time.Sleep(100 * time.Millisecond)

	// Check that MD5 hashes were calculated
	normalized := vfs.normalizePath("file1.txt")
	hash, exists := vfs.GetMD5(normalized)
	if !exists {
		t.Error("MD5 hash not calculated for file1.txt")
	}
	if hash == "" {
		t.Error("MD5 hash is empty for file1.txt")
	}

	// Verify hash is correct (MD5 of "Hello, World!" is 65a8e27d8879283831b664bd8b7f0ad4)
	expectedHash := "65a8e27d8879283831b664bd8b7f0ad4"
	if hash != expectedHash {
		t.Errorf("MD5 hash mismatch for file1.txt: got %s, want %s", hash, expectedHash)
	}

	// Check another file
	normalized = vfs.normalizePath("file2.txt")
	hash, exists = vfs.GetMD5(normalized)
	if !exists {
		t.Error("MD5 hash not calculated for file2.txt")
	}
	if hash == "" {
		t.Error("MD5 hash is empty for file2.txt")
	}

	// Check nested file
	normalized = vfs.normalizePath("dir1/file3.txt")
	hash, exists = vfs.GetMD5(normalized)
	if !exists {
		t.Error("MD5 hash not calculated for dir1/file3.txt")
	}
	if hash == "" {
		t.Error("MD5 hash is empty for dir1/file3.txt")
	}

	// Verify total number of hashes calculated
	vfs.md5Mutex.RLock()
	hashCount := len(vfs.md5Hashes)
	vfs.md5Mutex.RUnlock()

	if hashCount != 3 {
		t.Errorf("Expected 3 MD5 hashes, got %d", hashCount)
	}

	t.Logf("Successfully calculated MD5 hashes for %d files", hashCount)
	for path, hash := range vfs.md5Hashes {
		t.Logf("  %s: %s", path, hash)
	}
}

func TestMD5NonBlockingStartup(t *testing.T) {
	// Create temp directory with test files
	tempDir := t.TempDir()

	// Create a test file
	testFile := filepath.Join(tempDir, "test.txt")
	if err := os.WriteFile(testFile, []byte("test content"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	// Create VFS
	config := &Config{
		Extensions: []string{".hpi"},
	}
	vfs, err := NewVirtualFileSystem(tempDir, config)
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// VFS should be immediately usable, even if MD5 calculation is not complete
	normalized := vfs.normalizePath("test.txt")

	// File should exist and be readable
	if !vfs.Exists(normalized) {
		t.Error("File should exist immediately after VFS creation")
	}

	content, err := vfs.ReadFile(normalized)
	if err != nil {
		t.Errorf("Should be able to read file immediately: %v", err)
	}
	if string(content) != "test content" {
		t.Errorf("File content mismatch: got %q, want %q", string(content), "test content")
	}

	// MD5 might or might not be ready yet (that's fine - it's background)
	hash, exists := vfs.GetMD5(normalized)
	if exists {
		t.Logf("MD5 already calculated: %s", hash)
	} else {
		t.Logf("MD5 not yet calculated (background processing)")
	}

	t.Log("VFS is non-blocking - files are accessible immediately")
}
