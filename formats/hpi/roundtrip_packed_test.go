package hpi

import (
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/testutil"
)

// TestPackedArchivesRoundTrip walks every HPI/UFO/CCX/GP3 archive under
// TA_PACKED_PATH, streams each entry out while computing SHA-512s, repacks the
// extracted files into fresh archives with the writer API, then re-reads the
// new archives and verifies that every file's SHA-512 still matches the
// original. The intent is to confirm that the decompression and recompression
// paths are reciprocal at the per-file level.
func TestPackedArchivesRoundTrip(t *testing.T) {
	packedRoot := testutil.PackedPath(t)

	archives, err := findPackedArchives(packedRoot)
	if err != nil {
		t.Fatalf("scanning %s: %v", packedRoot, err)
	}
	if len(archives) == 0 {
		t.Fatalf("no .hpi/.ufo/.ccx/.gp3 archives found under %s", packedRoot)
	}
	t.Logf("discovered %d packed archives under %s", len(archives), packedRoot)

	tmpRoot := t.TempDir()
	extractRoot := filepath.Join(tmpRoot, "extracted")
	repackRoot := filepath.Join(tmpRoot, "repacked")

	type archiveJob struct {
		path       string // original archive path
		rel        string // relative to packedRoot (unique key)
		extractDir string // where the streamed-out files live
		repackPath string // where the rebuilt archive is written
		origHashes map[string]string
	}

	jobs := make([]*archiveJob, 0, len(archives))
	for _, ap := range archives {
		rel, relErr := filepath.Rel(packedRoot, ap)
		if relErr != nil {
			t.Fatalf("computing relative path for %s: %v", ap, relErr)
		}
		jobs = append(jobs, &archiveJob{
			path:       ap,
			rel:        rel,
			extractDir: filepath.Join(extractRoot, rel),
			repackPath: filepath.Join(repackRoot, rel),
		})
	}

	// Phase 1 — stream every entry out, SHA-512 each, persist to disk.
	totalOriginalEntries := 0
	for _, job := range jobs {
		if err := os.MkdirAll(job.extractDir, 0o755); err != nil {
			t.Fatalf("creating extract dir %s: %v", job.extractDir, err)
		}
		hashes, err := streamHashHPI(job.path, job.extractDir)
		if err != nil {
			t.Fatalf("streaming %s: %v", job.path, err)
		}
		if len(hashes) == 0 {
			t.Errorf("archive %s contains no files", job.path)
			continue
		}
		job.origHashes = hashes
		totalOriginalEntries += len(hashes)
	}
	t.Logf("milestone: read and SHA-512 hashed %d entries across %d archives",
		totalOriginalEntries, len(jobs))

	// Phase 2 — repack the extracted files back into fresh archives.
	for _, job := range jobs {
		if job.origHashes == nil {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(job.repackPath), 0o755); err != nil {
			t.Fatalf("creating repack dir for %s: %v", job.repackPath, err)
		}
		if err := repackDirectory(job.extractDir, job.repackPath); err != nil {
			t.Fatalf("repacking %s -> %s: %v", job.extractDir, job.repackPath, err)
		}
	}
	t.Logf("milestone: repacked %d archives into %s", len(jobs), repackRoot)

	// Phase 3 — re-read the repacked archives and verify every hash matches.
	t.Logf("milestone: starting SHA-512 verification of repacked archives")
	totalVerified := 0
	totalMismatches := 0
	for _, job := range jobs {
		if job.origHashes == nil {
			continue
		}
		repackedHashes, err := streamHashHPI(job.repackPath, "")
		if err != nil {
			t.Errorf("re-reading repacked archive %s: %v", job.repackPath, err)
			continue
		}

		if len(repackedHashes) != len(job.origHashes) {
			t.Errorf("%s: entry count mismatch: original=%d repacked=%d",
				job.rel, len(job.origHashes), len(repackedHashes))
		}

		for path, want := range job.origHashes {
			got, ok := repackedHashes[path]
			if !ok {
				t.Errorf("%s: entry %s missing from repacked archive", job.rel, path)
				totalMismatches++
				continue
			}
			if got != want {
				t.Errorf("%s: SHA-512 mismatch for %s\n  original: %s\n  repacked: %s",
					job.rel, path, want, got)
				totalMismatches++
				continue
			}
			totalVerified++
		}
		for path := range repackedHashes {
			if _, ok := job.origHashes[path]; !ok {
				t.Errorf("%s: unexpected entry %s in repacked archive", job.rel, path)
				totalMismatches++
			}
		}
	}
	t.Logf("milestone: verification complete — %d entries matched, %d mismatches",
		totalVerified, totalMismatches)
}

// findPackedArchives returns absolute paths to every file under root whose
// extension is one of the TA archive container formats.
func findPackedArchives(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		switch strings.ToLower(filepath.Ext(path)) {
		case ".hpi", ".ufo", ".ccx", ".gp3":
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// streamHashHPI opens archivePath, iterates every file entry via the streaming
// reader API, computes a SHA-512 for each entry, and optionally writes a copy
// to extractDir. Returns a map keyed by the lower-cased forward-slashed entry
// path so it can be compared case-insensitively across reads.
func streamHashHPI(archivePath, extractDir string) (map[string]string, error) {
	reader, err := OpenReader(archivePath)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", archivePath, err)
	}
	defer func() { _ = reader.Close() }()

	hashes := make(map[string]string)
	for _, entry := range reader.List() {
		if err := streamHashEntry(reader, entry, extractDir, hashes); err != nil {
			return nil, err
		}
	}
	return hashes, nil
}

// streamHashEntry copies one entry to its destination (if any) while feeding a
// SHA-512 hasher, then records the hex digest in hashes.
func streamHashEntry(reader *Reader, entry, extractDir string, hashes map[string]string) error {
	rc, err := reader.Open(entry)
	if err != nil {
		return fmt.Errorf("opening entry %s: %w", entry, err)
	}
	defer func() { _ = rc.Close() }()

	h := sha512.New()
	var dest io.Writer = h
	var out *os.File
	if extractDir != "" {
		outPath := filepath.Join(extractDir, filepath.FromSlash(entry))
		if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
			return fmt.Errorf("preparing output dir for %s: %w", entry, err)
		}
		f, err := os.Create(outPath)
		if err != nil {
			return fmt.Errorf("creating %s: %w", outPath, err)
		}
		out = f
		dest = io.MultiWriter(h, f)
	}

	if _, err := io.Copy(dest, rc); err != nil {
		if out != nil {
			_ = out.Close()
		}
		return fmt.Errorf("streaming entry %s: %w", entry, err)
	}
	if out != nil {
		if err := out.Close(); err != nil {
			return fmt.Errorf("closing %s: %w", out.Name(), err)
		}
	}

	hashes[normalizeEntryKey(entry)] = hex.EncodeToString(h.Sum(nil))
	return nil
}

// repackDirectory builds a fresh HPI archive at outPath from the files under
// srcDir, using the writer's directory-walk helper so every file is
// re-compressed.
func repackDirectory(srcDir, outPath string) error {
	w, err := CreateWriter(outPath)
	if err != nil {
		return fmt.Errorf("creating writer for %s: %w", outPath, err)
	}
	if err := w.AddDirectory("", srcDir); err != nil {
		_ = w.Close()
		return fmt.Errorf("adding directory %s: %w", srcDir, err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("closing writer for %s: %w", outPath, err)
	}
	return nil
}

func normalizeEntryKey(p string) string {
	return strings.ToLower(filepath.ToSlash(p))
}
