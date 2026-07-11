package studio

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	hpiv2 "github.com/coreprime/kbot-io/formats/hpi/v2"
	"github.com/coreprime/kbot/internal/workspace"
)

// packModHPI bundles the loose files in a workspace work folder into an HPI
// archive (v2 for TA: Kingdoms, v1 otherwise). The work folder, by copy-on-write,
// holds exactly the files that differ from the base context, so the archive is
// the mod delta. The workspace manifest and dot-prefixed paths are excluded.
func packModHPI(workDir, format string) ([]byte, error) {
	tmp, err := os.CreateTemp("", "kbot-mod-*.hpi")
	if err != nil {
		return nil, fmt.Errorf("temp file: %w", err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer func() { _ = os.Remove(tmpPath) }()

	addAll := func(add func(string, []byte) error) error {
		return filepath.Walk(workDir, func(p string, info os.FileInfo, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if info.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(workDir, p)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if rel == workspace.ManifestName {
				return nil // the manifest is workspace metadata, not mod content
			}
			for _, seg := range strings.Split(rel, "/") {
				if strings.HasPrefix(seg, ".") {
					return nil // skip .git, .DS_Store, etc.
				}
			}
			data, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			return add(rel, data)
		})
	}

	if format == workspace.ExportHPIv2 {
		hw, err := hpiv2.CreateWriter(tmpPath)
		if err != nil {
			return nil, fmt.Errorf("create hpi: %w", err)
		}
		if err := addAll(hw.AddFileFromBytes); err != nil {
			_ = hw.Close()
			return nil, err
		}
		if err := hw.Close(); err != nil {
			return nil, fmt.Errorf("close hpi: %w", err)
		}
	} else {
		hw, err := hpiv1.CreateWriter(tmpPath)
		if err != nil {
			return nil, fmt.Errorf("create hpi: %w", err)
		}
		hw.SetTrailer(nil)
		if err := addAll(hw.AddFileFromBytes); err != nil {
			_ = hw.Close()
			return nil, err
		}
		if err := hw.Close(); err != nil {
			return nil, fmt.Errorf("close hpi: %w", err)
		}
	}
	return os.ReadFile(tmpPath)
}

// handleExportMod serves the current workspace's mod as a downloadable HPI.
// Read-only context sessions (no work folder) return 400.
func (sess *Session) handleExportMod(w http.ResponseWriter, _ *http.Request) {
	if sess.workDir == "" {
		http.Error(w, "this session has no editable workspace to export", http.StatusBadRequest)
		return
	}
	data, err := packModHPI(sess.workDir, sess.exportFormat)
	if err != nil {
		http.Error(w, "export failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	name := sanitiseMapName(sess.name)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name+".hpi"))
	_, _ = w.Write(data)
}
