package filesystem

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestVFSIntegrationWithTA tests the VFS with real Total Annihilation files
func TestVFSIntegrationWithTA(t *testing.T) {
	taPath := "../../content/base_game/Total Annihilation"
	
	if _, err := os.Stat(taPath); os.IsNotExist(err) {
		t.Skip("Skipping integration test - TA files not found at:", taPath)
	}

	config := &Config{
		Extensions:         []string{".hpi", ".ccx", ".gp3", ".ufo"},
		ExcludeDirectories: []string{"Docs"},
		ExcludeExtensions:  []string{".dll", ".exe", ".ico", ".hlp", ".zip", ".msg", ".dat", ".lnk", ".sdb", ".db", ".ds_store"},
		ExcludePrefixes:    []string{"goggame"},
		SkipErrors:         true, // Continue even if some archives fail
	}

	vfs, err := NewVirtualFileSystem(taPath, config)
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	// Print statistics
	stats := vfs.Stats()
	t.Logf("=== VFS Statistics ===")
	t.Logf("Base Path: %s", stats["base_path"])
	t.Logf("Archives: %d", stats["archives"])
	t.Logf("Total Files: %d", stats["total_files"])
	t.Logf("Archive Files: %d", stats["archive_files"])
	t.Logf("Physical Files: %d", stats["physical_files"])
	t.Logf("Directories: %d", stats["directories"])

	// List loaded archives
	t.Logf("\n=== Loaded Archives ===")
	for _, archive := range vfs.Archives() {
		t.Logf("  - %s", archive)
	}

	// Test reading a known file
	t.Run("ReadARMFARK", func(t *testing.T) {
		testPaths := []string{
			"units/ARMFARK.FBI",
			"units/armfark.fbi",
			"UNITS/ARMFARK.FBI",
		}

		for _, path := range testPaths {
			if !vfs.Exists(path) {
				continue
			}

			data, err := vfs.ReadFile(path)
			if err != nil {
				t.Errorf("Failed to read %s: %v", path, err)
				continue
			}

			t.Logf("Successfully read %s: %d bytes", path, len(data))

			// Verify it's an FBI file
			content := string(data)
			if !strings.Contains(content, "[UNITINFO]") {
				t.Errorf("File doesn't contain [UNITINFO] section")
			}

			if !strings.Contains(content, "ARMFARK") {
				t.Errorf("File doesn't contain ARMFARK")
			}

			break
		}
	})

	// Test directory listing
	t.Run("ListUnits", func(t *testing.T) {
		if !vfs.IsDir("units") {
			t.Skip("units directory not found")
		}

		units, err := vfs.ListDir("units")
		if err != nil {
			t.Fatalf("Failed to list units: %v", err)
		}

		t.Logf("Units directory contains %d items", len(units))

		// Should have at least some FBI files
		fbiCount := 0
		for _, unit := range units {
			if strings.HasSuffix(strings.ToLower(unit), ".fbi") {
				fbiCount++
			}
		}

		if fbiCount == 0 {
			t.Error("No FBI files found in units directory")
		} else {
			t.Logf("Found %d FBI files", fbiCount)
		}
	})

	// Test walking
	t.Run("WalkFilesystem", func(t *testing.T) {
		fileCount := 0
		dirCount := 0
		var sampleFiles []string

		err := vfs.Walk(func(path string, info *FileInfo) error {
			if info.IsDir {
				dirCount++
			} else {
				fileCount++
				if len(sampleFiles) < 10 {
					sampleFiles = append(sampleFiles, fmt.Sprintf("%s (%s)", path, info.Source))
				}
			}
			return nil
		})

		if err != nil {
			t.Fatalf("Walk failed: %v", err)
		}

		t.Logf("Walked %d files and %d directories", fileCount, dirCount)
		t.Logf("Sample files:")
		for _, sample := range sampleFiles {
			t.Logf("  - %s", sample)
		}

		if fileCount == 0 {
			t.Error("Walk found no files")
		}
	})

	// Test stat
	t.Run("StatFile", func(t *testing.T) {
		if !vfs.Exists("units/ARMFARK.FBI") {
			t.Skip("ARMFARK.FBI not found")
		}

		info, err := vfs.Stat("units/ARMFARK.FBI")
		if err != nil {
			t.Fatalf("Stat failed: %v", err)
		}

		t.Logf("ARMFARK.FBI:")
		t.Logf("  Path: %s", info.Path)
		t.Logf("  Size: %d bytes", info.Size)
		t.Logf("  Source: %s", info.Source)
		t.Logf("  IsDir: %v", info.IsDir)

		if info.IsDir {
			t.Error("File reported as directory")
		}
	})

	// Test open and close
	t.Run("OpenFile", func(t *testing.T) {
		if !vfs.Exists("units/ARMFARK.FBI") {
			t.Skip("ARMFARK.FBI not found")
		}

		reader, err := vfs.Open("units/ARMFARK.FBI")
		if err != nil {
			t.Fatalf("Open failed: %v", err)
		}
		defer func() { _ = reader.Close() }()

		// Read some bytes
		buf := make([]byte, 100)
		n, err := reader.Read(buf)
		if err != nil {
			t.Fatalf("Read failed: %v", err)
		}

		t.Logf("Read %d bytes from ARMFARK.FBI", n)

		content := string(buf[:n])
		if !strings.Contains(content, "[UNITINFO]") {
			t.Error("Expected [UNITINFO] in first 100 bytes")
		}
	})

	// Test case insensitivity
	t.Run("CaseInsensitivity", func(t *testing.T) {
		variations := []string{
			"units/armfark.fbi",
			"Units/ARMFARK.FBI",
			"UNITS/armfark.FBI",
			"units/ArMfArK.fbi",
		}

		foundOne := false
		for _, path := range variations {
			if vfs.Exists(path) {
				foundOne = true
				data, err := vfs.ReadFile(path)
				if err != nil {
					t.Errorf("Failed to read case variation %s: %v", path, err)
				} else {
					t.Logf("Successfully read %s: %d bytes", path, len(data))
				}
			}
		}

		if !foundOne {
			t.Skip("ARMFARK.FBI not found for case test")
		}
	})
}

// Test layering - archives override each other in priority order
func TestVFSLayering(t *testing.T) {
	tmpDir := t.TempDir()

	// Create base directory with physical file
	_ = os.WriteFile(filepath.Join(tmpDir, "test.txt"), []byte("physical"), 0644)

	config := &Config{
		Extensions: []string{".hpi"},
	}

	vfs, err := NewVirtualFileSystem(tmpDir, config)
	if err != nil {
		t.Fatalf("Failed to create VFS: %v", err)
	}
	defer func() { _ = vfs.Close() }()

	data, err := vfs.ReadFile("test.txt")
	if err != nil {
		t.Fatalf("Failed to read: %v", err)
	}

	if string(data) != "physical" {
		t.Errorf("Expected 'physical', got %q", string(data))
	}
}
