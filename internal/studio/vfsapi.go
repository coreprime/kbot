package studio

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/internal/assetrender"
)

// registerVFSAPI mounts the virtual-filesystem surface under /api/vfs/.
//
// One handler covers every shape because the URL already encodes intent:
//
//	/api/vfs/maps/           → directory listing (trailing slash = folder)
//	/api/vfs/maps/foo.tnt    → the file's raw bytes (ETag + 304 aware)
//	    ?describe            → structured, format-specific facts as JSON
//	    ?layering            → which archive layers carry this path
//	    ?metadata            → a combined doc: identity + layering + describe
//
// Format-specific renders (PNG/GIF/APNG frames, minimaps, video) attach their
// own query parameters and are layered onto this same handler by later stages.
func registerVFSAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/vfs/", handleVFS)
}

// vfsEntry is one row in a directory listing. Type is "file" or "directory";
// Size is the file's byte length (files only). Directories carry recursive
// roll-up counts/size so the browse view can show "N folders, M files".
type vfsEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"`
	Size       int64  `json:"size,omitempty"`
	DirFiles   int    `json:"dirFiles,omitempty"`
	DirFolders int    `json:"dirFolders,omitempty"`
	DirSize    int64  `json:"dirSize,omitempty"`
}

// vfsCrumb is one breadcrumb segment in a listing response.
type vfsCrumb struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func handleVFS(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/api/vfs/")
	q := r.URL.Query()

	// Global, path-independent queries handled first.
	if q.Has("q") || q.Has("search") {
		handleVFSSearch(w, q.Get("q"))
		return
	}
	if q.Has("stats") {
		handleVFSStats(w)
		return
	}

	// A trailing slash (or the bare root) means "list this directory".
	if rel == "" || strings.HasSuffix(rel, "/") {
		handleVFSList(w, strings.TrimSuffix(rel, "/"))
		return
	}

	switch {
	case q.Has("metadata"):
		handleVFSMetadata(w, rel)
	case q.Has("layering"):
		handleVFSLayering(w, rel)
	case q.Has("describe"):
		handleVFSDescribe(w, rel)
	default:
		if req := parseRenderRequest(q); req.IsRender() {
			handleVFSRender(w, r, rel, req, q.Get("source"))
			return
		}
		handleVFSRaw(w, r, rel, q.Get("source"))
	}
}

// readVFS reads a file's bytes, optionally from a specific archive layer
// (the ?source= query param) so the Layering tab can show what a lower
// layer holds for the same path.
func readVFS(vpath, source string) ([]byte, error) {
	if source != "" {
		return vfs.ReadFileFromSource(vpath, source)
	}
	return vfs.ReadFile(vpath)
}

// handleVFSStats returns a filesystem overview (archive count, file/dir
// totals, packed/unpacked sizes, compression) for the explorer Home page.
func handleVFSStats(w http.ResponseWriter) {
	s := vfs.Stats()
	writeJSON(w, map[string]any{
		"basePath":         s["base_path"],
		"archives":         s["archives"],
		"totalFiles":       s["total_files"],
		"archiveFiles":     s["archive_files"],
		"physicalFiles":    s["physical_files"],
		"directories":      s["directories"],
		"unpackedSize":     s["total_unpacked_size"],
		"packedSize":       s["total_packed_size"],
		"compressionRatio": s["compression_ratio"],
	})
}

// handleVFSSearch does a substring match over every VFS path, returning the
// matching files (and their matching parent directories) capped at 50 rows.
func handleVFSSearch(w http.ResponseWriter, query string) {
	query = strings.ToLower(strings.TrimSpace(query))
	if len(query) < 2 {
		writeJSON(w, map[string]any{"results": []any{}})
		return
	}

	type result struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		IsDir bool   `json:"isDir"`
	}
	results := make([]result, 0, 50)
	seen := make(map[string]bool)

	for _, fp := range vfs.List() {
		if len(results) >= 50 {
			break
		}
		if !strings.Contains(strings.ToLower(fp), query) {
			continue
		}
		dir := path.Dir(fp)
		if dir != "." && dir != "" && !seen[dir] && strings.Contains(strings.ToLower(dir), query) {
			seen[dir] = true
			results = append(results, result{Name: path.Base(dir), Path: dir, IsDir: true})
		}
		if !seen[fp] {
			seen[fp] = true
			results = append(results, result{Name: path.Base(fp), Path: fp, IsDir: false})
		}
	}
	writeJSON(w, map[string]any{"results": results})
}

// parseRenderRequest maps the query string onto an assetrender.RenderRequest.
// Numeric selectors default to -1 (unset) so "frame 0" and "no frame" stay
// distinct.
func parseRenderRequest(q url.Values) assetrender.RenderRequest {
	atoi := func(key string) int {
		if v := q.Get(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				return n
			}
		}
		return -1
	}
	return assetrender.RenderRequest{
		Format:       q.Get("format"),
		View:         q.Get("view"),
		Sequence:     atoi("sequence"),
		SequenceName: q.Get("sequenceName"),
		Frame:        atoi("frame"),
		Text:         q.Get("text"),
		Palette:      q.Get("palette"),
		Transparency: q.Get("transparency"),
	}
}

// handleVFSRender renders a format-specific representation (a GAF frame, a TNT
// minimap, a PCX as PNG, …) and serves the encoded bytes with a matching
// content type. Renders are content-addressed and cached on disk by the
// Renderer, so a successful result also carries an ETag for conditional GETs.
func handleVFSRender(w http.ResponseWriter, r *http.Request, vpath string, req assetrender.RenderRequest, source string) {
	data, err := readVFS(vpath, source)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}

	out, err := renderer.Render(vpath, data, req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	etag := `"` + renderer.CacheKey(vpath, data) + "-" + req.CacheTag() + `"`
	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", out.ContentType)
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "public, max-age=3600")

	// Large, seekable artefacts (transcoded video) arrive as a cache path so
	// the browser can scrub via Range requests; everything else is in memory.
	if out.Path != "" {
		f, err := os.Open(out.Path)
		if err != nil {
			http.Error(w, "render unavailable", http.StatusInternalServerError)
			return
		}
		defer func() { _ = f.Close() }()
		info, err := f.Stat()
		if err != nil {
			http.Error(w, "render unavailable", http.StatusInternalServerError)
			return
		}
		http.ServeContent(w, r, path.Base(vpath), info.ModTime(), f)
		return
	}
	_, _ = w.Write(out.Body)
}

// handleVFSList returns the direct children of dir as a sorted listing with
// directories first.
func handleVFSList(w http.ResponseWriter, dir string) {
	names, err := vfs.ListDir(dir)
	if err != nil {
		jsonError(w, "directory not found", http.StatusNotFound)
		return
	}

	entries := make([]vfsEntry, 0, len(names))
	for _, name := range names {
		full := path.Join(dir, name)
		isDir := vfs.IsDir(full)

		// At the root, hide files the VFS config would normally exclude so the
		// listing matches what the rest of the tooling sees.
		if dir == "" && !isDir && vfs.ShouldExclude(name, false) {
			continue
		}

		e := vfsEntry{Name: name, Path: full, Type: "file"}
		if isDir {
			e.Type = "directory"
			ds := vfs.RecursiveDirectoryStats(full)
			if v, ok := ds["files"].(int); ok {
				e.DirFiles = v
			}
			if v, ok := ds["subdirectories"].(int); ok {
				e.DirFolders = v
			}
			if v, ok := ds["total_size"].(int64); ok {
				e.DirSize = v
			}
		} else if info, err := vfs.Stat(full); err == nil {
			e.Size = info.Size
		}
		entries = append(entries, e)
	}

	sort.Slice(entries, func(i, j int) bool {
		di, dj := entries[i].Type == "directory", entries[j].Type == "directory"
		if di != dj {
			return di
		}
		return entries[i].Name < entries[j].Name
	})

	// Breadcrumbs from the root down to this directory.
	crumbs := []vfsCrumb{{Name: "Root", Path: ""}}
	dirName := "Root"
	if dir != "" {
		cur := ""
		for _, part := range strings.Split(dir, "/") {
			if part == "" {
				continue
			}
			cur = path.Join(cur, part)
			crumbs = append(crumbs, vfsCrumb{Name: part, Path: cur})
		}
		dirName = crumbs[len(crumbs)-1].Name
	}

	totals := vfs.RecursiveDirectoryStats(dir)
	writeJSON(w, map[string]any{
		"path":        dir,
		"dirName":     dirName,
		"breadcrumbs": crumbs,
		"entries":     entries,
		"fileCount":   totals["files"],
		"subdirCount": totals["subdirectories"],
		"totalSize":   totals["total_size"],
	})
}

// handleVFSRaw serves the file's bytes verbatim with a content-type derived
// from its extension and a content-hash ETag for cheap conditional GETs.
func handleVFSRaw(w http.ResponseWriter, r *http.Request, vpath string, source string) {
	data, err := readVFS(vpath, source)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}

	etag := `"` + renderer.CacheKey(vpath, data) + `"`
	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	ct, _ := assetrender.RawContentType(path.Ext(vpath))
	w.Header().Set("Content-Type", ct)
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}

// handleVFSDescribe returns the format-specific structured description, or a
// minimal record (format: "") for files no describer recognises.
func handleVFSDescribe(w http.ResponseWriter, vpath string) {
	data, err := vfs.ReadFile(vpath)
	if err != nil {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}
	desc, _ := renderer.Describe(vpath, data)
	desc["path"] = vpath
	desc["name"] = path.Base(vpath)
	writeJSON(w, desc)
}

// handleVFSLayering reports which archive layers contribute this path, ordered
// by priority (the active file first).
func handleVFSLayering(w http.ResponseWriter, vpath string) {
	if _, err := vfs.Stat(vpath); err != nil {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}
	writeJSON(w, map[string]any{
		"path":   vpath,
		"name":   path.Base(vpath),
		"layers": vfs.GetFileLayers(vpath),
	})
}

// handleVFSMetadata folds identity, layering, and the format describe into one
// document so the preview pane can populate its header and detail tabs from a
// single request.
func handleVFSMetadata(w http.ResponseWriter, vpath string) {
	info, err := vfs.Stat(vpath)
	if err != nil {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}
	data, err := vfs.ReadFile(vpath)
	if err != nil {
		jsonError(w, "cannot read file", http.StatusInternalServerError)
		return
	}

	describe, _ := renderer.Describe(vpath, data)

	writeJSON(w, map[string]any{
		"path":     vpath,
		"name":     path.Base(vpath),
		"size":     info.Size,
		"source":   info.Source,
		"layering": vfs.GetFileLayers(vpath),
		"describe": describe,
	})
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
