package v1

import (
	"crypto/md5"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
)

const testUFOPath = "../../../../content/base_game/Total Annihilation/AFark.ufo"

// TestExtractAFark extracts every file from AFark.ufo and verifies each can be
// read and hashed.
func TestExtractAFark(t *testing.T) {
	if _, err := os.Stat(testUFOPath); os.IsNotExist(err) {
		t.Skip("Test file not found:", testUFOPath)
	}

	reader, err := Open(testUFOPath)
	if err != nil {
		t.Fatalf("Failed to open AFark.ufo: %v", err)
	}
	defer func() { _ = reader.Close() }()

	files := reader.List()
	t.Logf("AFark.ufo contains %d files", len(files))
	if len(files) == 0 {
		t.Fatal("No files found in archive")
	}

	md5sums := make(map[string]string)
	for _, file := range files {
		rc, err := reader.Open(file)
		if err != nil {
			t.Errorf("Failed to open %s: %v", file, err)
			continue
		}
		hash := md5.New()
		size, err := io.Copy(hash, rc)
		_ = rc.Close()
		if err != nil {
			t.Errorf("Failed to read %s: %v", file, err)
			continue
		}
		md5sums[file] = fmt.Sprintf("%x", hash.Sum(nil))
		t.Logf("  ✓ %s (%d bytes)", file, size)
	}

	if len(md5sums) != len(files) {
		t.Errorf("Expected %d files, got MD5s for %d", len(files), len(md5sums))
	}
}

// TestExtractSpecificFiles tests extraction of known files with expected
// minimum sizes.
func TestExtractSpecificFiles(t *testing.T) {
	if _, err := os.Stat(testUFOPath); os.IsNotExist(err) {
		t.Skip("Test file not found:", testUFOPath)
	}

	reader, err := Open(testUFOPath)
	if err != nil {
		t.Fatalf("Failed to open AFark.ufo: %v", err)
	}
	defer func() { _ = reader.Close() }()

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

			data, err := io.ReadAll(rc)
			if err != nil {
				t.Fatalf("Failed to read %s: %v", tc.path, err)
			}
			if int64(len(data)) < tc.minSize {
				t.Errorf("File %s is too small: got %d bytes, expected at least %d",
					tc.path, len(data), tc.minSize)
			}
		})
	}
}

// TestWriteReadRoundTrip extracts AFark.ufo, repacks the files into a new
// archive with the writer, and verifies every file's MD5 survives the trip.
func TestWriteReadRoundTrip(t *testing.T) {
	if _, err := os.Stat(testUFOPath); os.IsNotExist(err) {
		t.Skip("Test file not found:", testUFOPath)
	}

	extractDir := t.TempDir()
	originalMD5s, err := extractAndComputeMD5s(testUFOPath, extractDir)
	if err != nil {
		t.Fatalf("extracting original: %v", err)
	}

	repacked := filepath.Join(t.TempDir(), "repacked.ufo")
	w, err := CreateWriter(repacked)
	if err != nil {
		t.Fatalf("CreateWriter: %v", err)
	}
	if err := w.AddDirectory("", extractDir); err != nil {
		_ = w.Close()
		t.Fatalf("AddDirectory: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	repackedMD5s, err := extractAndComputeMD5s(repacked, t.TempDir())
	if err != nil {
		t.Fatalf("extracting repacked: %v", err)
	}

	if len(originalMD5s) != len(repackedMD5s) {
		t.Fatalf("file count mismatch: original=%d repacked=%d", len(originalMD5s), len(repackedMD5s))
	}
	for path, want := range originalMD5s {
		got, ok := repackedMD5s[path]
		if !ok {
			t.Errorf("file missing in repacked archive: %s", path)
			continue
		}
		if got != want {
			t.Errorf("MD5 mismatch for %s: original=%s repacked=%s", path, want, got)
		}
	}
}

func extractAndComputeMD5s(archivePath, targetDir string) (map[string]string, error) {
	reader, err := Open(archivePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open archive: %w", err)
	}
	defer func() { _ = reader.Close() }()

	md5sums := make(map[string]string)
	for _, file := range reader.List() {
		outputPath := filepath.Join(targetDir, filepath.FromSlash(file))
		if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
			return nil, fmt.Errorf("creating dir for %s: %w", file, err)
		}
		rc, err := reader.Open(file)
		if err != nil {
			return nil, fmt.Errorf("opening %s: %w", file, err)
		}
		outFile, err := os.Create(outputPath)
		if err != nil {
			_ = rc.Close()
			return nil, fmt.Errorf("creating %s: %w", outputPath, err)
		}
		hash := md5.New()
		_, err = io.Copy(io.MultiWriter(outFile, hash), rc)
		_ = outFile.Close()
		_ = rc.Close()
		if err != nil {
			return nil, fmt.Errorf("writing %s: %w", file, err)
		}
		md5sums[file] = fmt.Sprintf("%x", hash.Sum(nil))
	}
	return md5sums, nil
}
