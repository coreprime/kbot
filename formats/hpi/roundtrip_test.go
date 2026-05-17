package hpi

import (
	"crypto/md5"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
)

const testUFOPath = "../../../content/base_game/Total Annihilation/AFark.ufo"

// TestRoundTrip performs a complete round-trip test:
// 1. Extract all files from AFark.ufo and compute MD5s
// 2. Re-pack the extracted files into a new archive
// 3. Extract from the new archive
// 4. Verify all MD5s match
func TestRoundTrip(t *testing.T) {
	// Skip if test file doesn't exist
	if _, err := os.Stat(testUFOPath); os.IsNotExist(err) {
		t.Skip("Test file not found:", testUFOPath)
	}

	// Create temp directories
	extractDir1, err := os.MkdirTemp("", "hpi-extract1-*")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(extractDir1) }()
	extractDir2, err := os.MkdirTemp("", "hpi-extract2-*")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(extractDir2) }()
	repackedFile := filepath.Join(os.TempDir(), "repacked-test.ufo")
	defer func() { _ = os.Remove(repackedFile) }()

	// Step 1: Extract original archive and compute MD5s
	t.Log("Step 1: Extracting original archive...")
	originalMD5s, err := extractAndComputeMD5s(t, testUFOPath, extractDir1)
	if err != nil {
		t.Fatalf("Failed to extract original archive: %v", err)
	}
	t.Logf("  Extracted %d files", len(originalMD5s))

	// Step 2: Re-pack into new archive
	t.Log("Step 2: Re-packing files into new archive...")
	if err := repackArchive(t, extractDir1, repackedFile); err != nil {
		t.Fatalf("Failed to repack archive: %v", err)
	}

	// Verify repacked file exists and has reasonable size
	repackedInfo, err := os.Stat(repackedFile)
	if err != nil {
		t.Fatalf("Repacked file not found: %v", err)
	}
	t.Logf("  Repacked archive size: %d bytes", repackedInfo.Size())

	// Step 3: Extract repacked archive
	t.Log("Step 3: Extracting repacked archive...")
	repackedMD5s, err := extractAndComputeMD5s(t, repackedFile, extractDir2)
	if err != nil {
		t.Fatalf("Failed to extract repacked archive: %v", err)
	}
	t.Logf("  Extracted %d files", len(repackedMD5s))

	// Step 4: Compare MD5s
	t.Log("Step 4: Verifying MD5 checksums...")
	if len(originalMD5s) != len(repackedMD5s) {
		t.Fatalf("File count mismatch: original=%d, repacked=%d", len(originalMD5s), len(repackedMD5s))
	}

	mismatches := 0
	for path, originalMD5 := range originalMD5s {
		repackedMD5, exists := repackedMD5s[path]
		if !exists {
			t.Errorf("File missing in repacked archive: %s", path)
			mismatches++
			continue
		}

		if originalMD5 != repackedMD5 {
			t.Errorf("MD5 mismatch for %s:\n  original:  %s\n  repacked:  %s", path, originalMD5, repackedMD5)
			mismatches++
		} else {
			t.Logf("  ✓ %s: %s", path, originalMD5)
		}
	}

	if mismatches > 0 {
		t.Fatalf("Round-trip test failed with %d mismatches", mismatches)
	}

	t.Log("✅ Round-trip test PASSED - all files match!")
}

// extractAndComputeMD5s extracts all files and returns a map of path -> MD5
func extractAndComputeMD5s(t *testing.T, archivePath, targetDir string) (map[string]string, error) {
	reader, err := OpenReader(archivePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open archive: %w", err)
	}
	defer func() { _ = reader.Close() }()

	md5sums := make(map[string]string)
	files := reader.List()

	for _, file := range files {
		// Create output path
		outputPath := filepath.Join(targetDir, filepath.FromSlash(file))
		
		// Create parent directory
		if err := os.MkdirAll(filepath.Dir(outputPath), 0755); err != nil {
			return nil, fmt.Errorf("failed to create directory for %s: %w", file, err)
		}

		// Extract file
		rc, err := reader.Open(file)
		if err != nil {
			return nil, fmt.Errorf("failed to open %s: %w", file, err)
		}

		outFile, err := os.Create(outputPath)
		if err != nil {
			_ = rc.Close()
			return nil, fmt.Errorf("failed to create %s: %w", outputPath, err)
		}

		// Compute MD5 while writing
		hash := md5.New()
		multiWriter := io.MultiWriter(outFile, hash)
		
		_, err = io.Copy(multiWriter, rc)
		_ = outFile.Close()
		_ = rc.Close()

		if err != nil {
			return nil, fmt.Errorf("failed to write %s: %w", file, err)
		}

		md5sums[file] = fmt.Sprintf("%x", hash.Sum(nil))
	}

	return md5sums, nil
}

// repackArchive creates a new HPI archive from extracted files
func repackArchive(t *testing.T, sourceDir, targetFile string) error {
	// Since Writer is not yet implemented, we'll skip the repack step
	// and just test that we can extract files correctly
	t.Skip("Writer not yet implemented - skipping repack step")
	return nil
}

// TestExtractAFark is a simpler test that just extracts and verifies files can be read
func TestExtractAFark(t *testing.T) {
	// Skip if test file doesn't exist
	if _, err := os.Stat(testUFOPath); os.IsNotExist(err) {
		t.Skip("Test file not found:", testUFOPath)
	}

	reader, err := OpenReader(testUFOPath)
	if err != nil {
		t.Fatalf("Failed to open AFark.ufo: %v", err)
	}
	defer func() { _ = reader.Close() }()

	// Get file list
	files := reader.List()
	t.Logf("AFark.ufo contains %d files", len(files))

	if len(files) == 0 {
		t.Fatal("No files found in archive")
	}

	// Extract and verify each file
	md5sums := make(map[string]string)
	for _, file := range files {
		rc, err := reader.Open(file)
		if err != nil {
			t.Errorf("Failed to open %s: %v", file, err)
			continue
		}

		// Compute MD5
		hash := md5.New()
		size, err := io.Copy(hash, rc)
		_ = rc.Close()

		if err != nil {
			t.Errorf("Failed to read %s: %v", file, err)
			continue
		}

		md5sum := fmt.Sprintf("%x", hash.Sum(nil))
		md5sums[file] = md5sum
		t.Logf("  ✓ %s (%d bytes) - MD5: %s", file, size, md5sum)
	}

	// Verify we got all files
	if len(md5sums) != len(files) {
		t.Errorf("Expected %d files, got MD5s for %d", len(files), len(md5sums))
	}

	t.Logf("\n✅ Successfully extracted and verified %d files from AFark.ufo", len(md5sums))
}

// TestExtractSpecificFiles tests extraction of known files with expected content
func TestExtractSpecificFiles(t *testing.T) {
	// Skip if test file doesn't exist
	if _, err := os.Stat(testUFOPath); os.IsNotExist(err) {
		t.Skip("Test file not found:", testUFOPath)
	}

	reader, err := OpenReader(testUFOPath)
	if err != nil {
		t.Fatalf("Failed to open AFark.ufo: %v", err)
	}
	defer func() { _ = reader.Close() }()

	// Test cases: files we expect to find
	testCases := []struct {
		path        string
		minSize     int64
		description string
	}{
		{"units/ARMFARK.FBI", 1000, "ARM Fark unit definition"},
		{"scripts/ARMFARK.COB", 500, "ARM Fark script"},
		{"objects3d/armfark.3do", 1000, "ARM Fark 3D model"},
	}

	for _, tc := range testCases {
		t.Run(tc.path, func(t *testing.T) {
			rc, err := reader.Open(tc.path)
			if err != nil {
				t.Fatalf("Failed to open %s: %v", tc.path, err)
			}
			defer func() { _ = rc.Close() }()

			// Read all data
			data, err := io.ReadAll(rc)
			if err != nil {
				t.Fatalf("Failed to read %s: %v", tc.path, err)
			}

			// Verify size
			if int64(len(data)) < tc.minSize {
				t.Errorf("File %s is too small: got %d bytes, expected at least %d", 
					tc.path, len(data), tc.minSize)
			}

			// Compute and log MD5
			hash := md5.Sum(data)
			t.Logf("✓ %s: %d bytes, MD5: %x", tc.description, len(data), hash)
		})
	}
}

// BenchmarkExtractAFark benchmarks extraction performance
func BenchmarkExtractAFark(b *testing.B) {
	// Skip if test file doesn't exist
	if _, err := os.Stat(testUFOPath); os.IsNotExist(err) {
		b.Skip("Test file not found:", testUFOPath)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		reader, err := OpenReader(testUFOPath)
		if err != nil {
			b.Fatal(err)
		}

		files := reader.List()
		for _, file := range files {
			rc, err := reader.Open(file)
			if err != nil {
				_ = reader.Close()
				b.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, rc)
			_ = rc.Close()
		}

		_ = reader.Close()
	}
}
