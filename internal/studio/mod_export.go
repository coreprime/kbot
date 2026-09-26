package studio

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/coreprime/kbot-io/filesystem"
	hpiv1 "github.com/coreprime/kbot-io/formats/hpi/v1"
	hpiv2 "github.com/coreprime/kbot-io/formats/hpi/v2"
	"github.com/coreprime/kbot/internal/gamevfs"
	"github.com/coreprime/kbot/internal/workspace"
)

// modFiles lists the files a workspace mod export packs: every file in the
// work folder, as '/'-separated paths relative to it, except the workspace
// manifest and dot-prefixed paths (.git, .DS_Store, …). The work folder, by
// copy-on-write, holds exactly the files that differ from the base context.
func modFiles(workDir string) ([]string, error) {
	var out []string
	err := filepath.Walk(workDir, func(p string, info os.FileInfo, walkErr error) error {
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
		out = append(out, rel)
		return nil
	})
	return out, err
}

// packModHPI bundles the loose files in a workspace work folder into an HPI
// archive (v2 for TA: Kingdoms, v1 otherwise); see modFiles for what goes
// in. The archive format is the same whatever extension the download
// carries (.hpi, .ufo or .ccx).
func packModHPI(workDir, format string) ([]byte, error) {
	files, err := modFiles(workDir)
	if err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp("", "kbot-mod-*.hpi")
	if err != nil {
		return nil, fmt.Errorf("temp file: %w", err)
	}
	tmpPath := tmp.Name()
	_ = tmp.Close()
	defer func() { _ = os.Remove(tmpPath) }()

	addAll := func(add func(string, []byte) error) error {
		for _, rel := range files {
			data, err := os.ReadFile(filepath.Join(workDir, filepath.FromSlash(rel)))
			if err != nil {
				return err
			}
			if err := add(rel, data); err != nil {
				return err
			}
		}
		return nil
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
		// The writer's default trailer ("Copyright 1997 Cavedog
		// Entertainment") stays: TA 3.1c refuses to mount an archive
		// without it.
		hw, err := hpiv1.CreateWriter(tmpPath)
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
	}
	return os.ReadFile(tmpPath)
}

// exportExtensions lists the archive extensions a mod export may carry,
// the preferred one first. Total Annihilation archives (hpi-v1) can ship as
// .ufo, which has no count limit and ranks above every .hpi in TA 3.1c's
// mount order, as .ccx, which ranks above every .ufo, or as .hpi, which the
// game mounts only when fewer than ten *.hpi sort before it. TA: Kingdoms
// archives ship as .hpi.
func exportExtensions(format string) []string {
	if format == workspace.ExportHPIv2 {
		return []string{"hpi"}
	}
	return []string{"ufo", "ccx", "hpi"}
}

// exportRequest is a parsed mod-export query.
type exportRequest struct {
	// Archive is the download's file name, such as "my-mod.ufo".
	Archive string
	// Preflight asks for the ExportCheck report instead of the archive.
	Preflight bool
}

// parseExportRequest reads ?name=, ?ext= and ?preflight from an export
// query. The name defaults to defaultName and is reduced to a URL- and
// file-safe slug; the extension defaults to the format's preferred one and
// must be one exportExtensions allows.
func parseExportRequest(q url.Values, defaultName, format string) (exportRequest, error) {
	name := strings.TrimSpace(q.Get("name"))
	if name == "" {
		name = defaultName
	}
	name = slug(name)
	allowed := exportExtensions(format)
	ext := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(q.Get("ext"))), ".")
	if ext == "" {
		ext = allowed[0]
	}
	ok := false
	for _, a := range allowed {
		ok = ok || a == ext
	}
	if !ok {
		return exportRequest{}, fmt.Errorf("unsupported export extension %q (use %s)", ext, strings.Join(allowed, ", "))
	}
	return exportRequest{Archive: name + "." + ext, Preflight: q.Has("preflight")}, nil
}

// exportPreflight is the ?preflight answer of a mod export: the export
// check plus what the dialog needs to offer the choices.
type exportPreflight struct {
	gamevfs.ExportCheck
	Files      int      `json:"files"`
	Extensions []string `json:"extensions"`
}

// preflightExport checks where the archive would rank in the base
// install's mount order and which workspace files a source the game reads
// first also provides. skipLabel names vfs's workspace layer ("" when vfs
// holds only the base install).
func preflightExport(vfs *filesystem.VirtualFileSystem, workDir, format, archive, skipLabel string) (exportPreflight, error) {
	files, err := modFiles(workDir)
	if err != nil {
		return exportPreflight{}, err
	}
	return exportPreflight{
		ExportCheck: gamevfs.CheckExport(vfs, archive, files, skipLabel),
		Files:       len(files),
		Extensions:  exportExtensions(format),
	}, nil
}

// serveModArchive writes the packed mod as a download named archive.
func serveModArchive(w http.ResponseWriter, workDir, format, archive string) {
	data, err := packModHPI(workDir, format)
	if err != nil {
		http.Error(w, "export failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", archive))
	_, _ = w.Write(data)
}

// handleExportMod serves the current workspace's mod as a downloadable
// archive. ?ext= picks .ufo (the default for Total Annihilation), .ccx or
// .hpi and ?name= the file name; with ?preflight it answers the export
// check as JSON instead. Read-only context sessions (no work folder)
// return 400.
func (sess *Session) handleExportMod(w http.ResponseWriter, r *http.Request) {
	if sess.workDir == "" {
		http.Error(w, "this session has no editable workspace to export", http.StatusBadRequest)
		return
	}
	req, err := parseExportRequest(r.URL.Query(), sess.name, sess.exportFormat)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Preflight {
		report, err := preflightExport(sess.vfs, sess.workDir, sess.exportFormat, req.Archive, workspace.WorkspaceLabel)
		if err != nil {
			http.Error(w, "preflight failed: "+err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, report)
		return
	}
	serveModArchive(w, sess.workDir, sess.exportFormat, req.Archive)
}
