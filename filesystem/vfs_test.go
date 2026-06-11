package filesystem

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestNewVirtualFileSystem(t *testing.T) {
	// Create temp directory
	tmpDir := t.TempDir()

	config := &Config{
		Extensions: []string{".hpi", ".ufo"},
	}

	vfs, err := NewVirtualFileSystem(tmpDir, config)
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	if vfs.basePath != tmpDir {
		t.Errorf("Expected basePath %s, got %s", tmpDir, vfs.basePath)
	}

	stats := vfs.Stats()
	if stats["base_path"] != tmpDir {
		t.Error("Stats base_path mismatch")
	}
}

func TestVFSWithPhysicalFiles(t *testing.T) {
	// Create temp directory with some files
	tmpDir := t.TempDir()

	// Create directory structure
	_ = os.MkdirAll(filepath.Join(tmpDir, "units"), 0755)
	_ = os.MkdirAll(filepath.Join(tmpDir, "features"), 0755)

	// Create test files
	testFiles := map[string]string{
		"units/test1.fbi":      "content1",
		"units/test2.fbi":      "content2",
		"features/feature.tdf": "feature data",
		"readme.txt":           "readme content",
	}

	for path, content := range testFiles {
		fullPath := filepath.Join(tmpDir, path)
		if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
			t.Fatalf("Failed to create test file %s: %v", path, err)
		}
	}

	// Create VFS
	config := &Config{
		Extensions: []string{".hpi"},
	}

	vfs, err := NewVirtualFileSystem(tmpDir, config)
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// Check that all files are visible
	files := vfs.List()
	if len(files) != len(testFiles) {
		t.Errorf("Expected %d files, got %d", len(testFiles), len(files))
	}

	// Test reading files
	for path, expectedContent := range testFiles {
		data, err := vfs.ReadFile(path)
		if err != nil {
			t.Errorf("Failed to read %s: %v", path, err)
			continue
		}

		if string(data) != expectedContent {
			t.Errorf("Content mismatch for %s: expected %q, got %q", path, expectedContent, string(data))
		}
	}
}

func TestVFSExists(t *testing.T) {
	tmpDir := t.TempDir()

	// Create test files
	_ = os.MkdirAll(filepath.Join(tmpDir, "units"), 0755)
	_ = os.WriteFile(filepath.Join(tmpDir, "units", "test.fbi"), []byte("test"), 0644)

	vfs, err := NewVirtualFileSystem(tmpDir, &Config{})
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	tests := []struct {
		path   string
		exists bool
		isDir  bool
	}{
		{"units/test.fbi", true, false},
		{"units", true, true},
		{"nonexistent", false, false},
		{"units/missing.fbi", false, false},
	}

	for _, test := range tests {
		exists := vfs.Exists(test.path)
		if exists != test.exists {
			t.Errorf("Exists(%s): expected %v, got %v", test.path, test.exists, exists)
		}

		if test.exists {
			isDir := vfs.IsDir(test.path)
			if isDir != test.isDir {
				t.Errorf("IsDir(%s): expected %v, got %v", test.path, test.isDir, isDir)
			}
		}
	}
}

func TestVFSListDir(t *testing.T) {
	tmpDir := t.TempDir()

	// Create directory structure
	_ = os.MkdirAll(filepath.Join(tmpDir, "units", "arm"), 0755)
	_ = os.MkdirAll(filepath.Join(tmpDir, "units", "core"), 0755)
	_ = os.WriteFile(filepath.Join(tmpDir, "units", "test1.fbi"), []byte("1"), 0644)
	_ = os.WriteFile(filepath.Join(tmpDir, "units", "arm", "armcom.fbi"), []byte("2"), 0644)

	vfs, err := NewVirtualFileSystem(tmpDir, &Config{})
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// List root
	rootFiles, err := vfs.ListDir("")
	if err != nil {
		t.Fatalf("ListDir(''): %v", err)
	}

	if len(rootFiles) != 1 || rootFiles[0] != "units" {
		t.Errorf("Root listing: expected [units], got %v", rootFiles)
	}

	// List units directory
	unitsFiles, err := vfs.ListDir("units")
	if err != nil {
		t.Fatalf("ListDir('units'): %v", err)
	}

	expected := []string{"arm", "core", "test1.fbi"}
	if len(unitsFiles) != len(expected) {
		t.Errorf("Units listing: expected %d items, got %d", len(expected), len(unitsFiles))
	}
}

func TestVFSWalk(t *testing.T) {
	tmpDir := t.TempDir()

	// Create test structure
	_ = os.MkdirAll(filepath.Join(tmpDir, "units"), 0755)
	_ = os.WriteFile(filepath.Join(tmpDir, "units", "test.fbi"), []byte("test"), 0644)
	_ = os.WriteFile(filepath.Join(tmpDir, "readme.txt"), []byte("readme"), 0644)

	vfs, err := NewVirtualFileSystem(tmpDir, &Config{})
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// Walk and count
	fileCount := 0
	dirCount := 0

	err = vfs.Walk(func(path string, info *FileInfo) error {
		if info.IsDir {
			dirCount++
		} else {
			fileCount++
		}
		return nil
	})

	if err != nil {
		t.Fatalf("Walk failed: %v", err)
	}

	if fileCount != 2 {
		t.Errorf("Expected 2 files, got %d", fileCount)
	}

	if dirCount != 1 {
		t.Errorf("Expected 1 directory, got %d", dirCount)
	}
}

func TestVFSCaseInsensitive(t *testing.T) {
	tmpDir := t.TempDir()

	_ = os.MkdirAll(filepath.Join(tmpDir, "Units"), 0755)
	_ = os.WriteFile(filepath.Join(tmpDir, "Units", "Test.FBI"), []byte("test"), 0644)

	config := &Config{
		CaseSensitive: false, // Default for TA
	}

	vfs, err := NewVirtualFileSystem(tmpDir, config)
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// All these should work
	variations := []string{
		"units/test.fbi",
		"Units/Test.FBI",
		"UNITS/TEST.FBI",
		"UnItS/TeSt.FbI",
	}

	for _, path := range variations {
		if !vfs.Exists(path) {
			t.Errorf("Case-insensitive Exists failed for: %s", path)
		}

		data, err := vfs.ReadFile(path)
		if err != nil {
			t.Errorf("Case-insensitive ReadFile failed for %s: %v", path, err)
		}

		if string(data) != "test" {
			t.Errorf("Content mismatch for %s", path)
		}
	}
}

func TestVFSStat(t *testing.T) {
	tmpDir := t.TempDir()

	_ = os.MkdirAll(filepath.Join(tmpDir, "units"), 0755)
	testContent := "test content here"
	_ = os.WriteFile(filepath.Join(tmpDir, "units", "test.fbi"), []byte(testContent), 0644)

	vfs, err := NewVirtualFileSystem(tmpDir, &Config{})
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// Stat file
	info, err := vfs.Stat("units/test.fbi")
	if err != nil {
		t.Fatalf("Stat failed: %v", err)
	}

	if info.IsDir {
		t.Error("File reported as directory")
	}

	if info.Source != "disk" {
		t.Errorf("Expected source 'disk', got %s", info.Source)
	}

	if info.Size != int64(len(testContent)) {
		t.Errorf("Size mismatch: expected %d, got %d", len(testContent), info.Size)
	}

	// Stat directory
	dirInfo, err := vfs.Stat("units")
	if err != nil {
		t.Fatalf("Stat dir failed: %v", err)
	}

	if !dirInfo.IsDir {
		t.Error("Directory not reported as directory")
	}
}

func TestVFSOpen(t *testing.T) {
	tmpDir := t.TempDir()

	testContent := "test file content"
	_ = os.WriteFile(filepath.Join(tmpDir, "test.txt"), []byte(testContent), 0644)

	vfs, err := NewVirtualFileSystem(tmpDir, &Config{})
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// Open and read
	reader, err := vfs.Open("test.txt")
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer func() { _ = reader.Close() }()

	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}

	if string(data) != testContent {
		t.Errorf("Content mismatch: expected %q, got %q", testContent, string(data))
	}

	// Test opening non-existent file
	_, err = vfs.Open("nonexistent.txt")
	if err == nil {
		t.Error("Expected error opening non-existent file")
	}
}

func TestVFSStats(t *testing.T) {
	tmpDir := t.TempDir()

	// Create some test files
	_ = os.WriteFile(filepath.Join(tmpDir, "file1.txt"), []byte("1"), 0644)
	_ = os.WriteFile(filepath.Join(tmpDir, "file2.txt"), []byte("2"), 0644)

	vfs, err := NewVirtualFileSystem(tmpDir, &Config{})
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	stats := vfs.Stats()

	if stats["base_path"] != tmpDir {
		t.Error("Stats base_path incorrect")
	}

	if stats["total_files"].(int) != 2 {
		t.Errorf("Expected 2 total files, got %v", stats["total_files"])
	}

	if stats["physical_files"].(int) != 2 {
		t.Errorf("Expected 2 physical files, got %v", stats["physical_files"])
	}

	if stats["archive_files"].(int) != 0 {
		t.Errorf("Expected 0 archive files, got %v", stats["archive_files"])
	}
}

// Test with real TA files if available
func TestVFSWithRealFiles(t *testing.T) {
	// This is optional - only runs if TA files are present
	taPath := "../../../content/base_game/Total Annihilation"

	if _, err := os.Stat(taPath); os.IsNotExist(err) {
		t.Skip("Skipping real file test - TA files not found")
	}

	config := &Config{
		Extensions: []string{".hpi", ".ccx", ".gp3", ".ufo"},
	}

	vfs, err := NewVirtualFileSystem(taPath, config)
	if err != nil {
		t.Fatalf("Failed to create VFS with real files: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	stats := vfs.Stats()
	t.Logf("VFS Stats: %+v", stats)

	// Check that we loaded some archives
	archives := vfs.Archives()
	if len(archives) == 0 {
		t.Error("No archives loaded from TA directory")
	}

	// Try to find and read ARMFARK.FBI
	if vfs.Exists("units/ARMFARK.FBI") {
		data, err := vfs.ReadFile("units/ARMFARK.FBI")
		if err != nil {
			t.Errorf("Failed to read ARMFARK.FBI: %v", err)
		} else {
			t.Logf("Read ARMFARK.FBI: %d bytes", len(data))
		}
	}

	// List units directory
	if vfs.IsDir("units") {
		units, err := vfs.ListDir("units")
		if err != nil {
			t.Errorf("Failed to list units: %v", err)
		} else {
			t.Logf("Units directory contains %d items", len(units))
		}
	}
}

// Benchmark VFS operations
func BenchmarkVFSListAll(b *testing.B) {
	tmpDir := b.TempDir()

	// Create many files
	for i := 0; i < 1000; i++ {
		_ = os.WriteFile(filepath.Join(tmpDir, filepath.Join("file", string(rune(i))+".txt")), []byte("test"), 0644)
	}

	vfs, _ := NewVirtualFileSystem(tmpDir, &Config{})
	defer func() { _ = vfs.Close() }()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		vfs.List()
	}
}

func BenchmarkVFSOpen(b *testing.B) {
	tmpDir := b.TempDir()
	_ = os.WriteFile(filepath.Join(tmpDir, "test.txt"), []byte("test content"), 0644)

	vfs, _ := NewVirtualFileSystem(tmpDir, &Config{})
	defer func() { _ = vfs.Close() }()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r, _ := vfs.Open("test.txt")
		_ = r.Close()
	}
}
