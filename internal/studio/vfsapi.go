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
// Size is the file's byte length (0 for directories).
type vfsEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
}

func handleVFS(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/api/vfs/")

	// A trailing slash (or the bare root) means "list this directory".
	if rel == "" || strings.HasSuffix(rel, "/") {
		handleVFSList(w, strings.TrimSuffix(rel, "/"))
		return
	}

	q := r.URL.Query()
	switch {
	case q.Has("metadata"):
		handleVFSMetadata(w, rel)
	case q.Has("layering"):
		handleVFSLayering(w, rel)
	case q.Has("describe"):
		handleVFSDescribe(w, rel)
	default:
		if req := parseRenderRequest(q); req.IsRender() {
			handleVFSRender(w, r, rel, req)
			return
		}
		handleVFSRaw(w, r, rel)
	}
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
func handleVFSRender(w http.ResponseWriter, r *http.Request, vpath string, req assetrender.RenderRequest) {
	data, err := vfs.ReadFile(vpath)
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

	writeJSON(w, map[string]any{"path": dir, "entries": entries})
}

// handleVFSRaw serves the file's bytes verbatim with a content-type derived
// from its extension and a content-hash ETag for cheap conditional GETs.
func handleVFSRaw(w http.ResponseWriter, r *http.Request, vpath string) {
	data, err := vfs.ReadFile(vpath)
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
