package studio

import (
	"net/http"
	"path"
	"strings"
)

// handleSound streams sounds/<slug>.wav out of the VFS.  Slug is the
// lowercased basename without extension; we restrict it to a small
// allowlist of files the welcome dialog actually uses so the endpoint
// can't be repurposed to read arbitrary VFS paths.
//
// Currently allowed:
//   - watnano1, watnano2  (nanolathe ambient loop on the welcome screen)
func handleSound(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/sound/")
	slug := strings.ToLower(strings.TrimSpace(raw))
	if slug == "" || strings.ContainsAny(slug, "/\\") {
		http.Error(w, "bad slug", http.StatusBadRequest)
		return
	}
	switch slug {
	case "watnano1", "watnano2":
	default:
		http.Error(w, "sound not in allowlist", http.StatusNotFound)
		return
	}
	if vfs == nil {
		http.Error(w, "no vfs mounted", http.StatusNotFound)
		return
	}
	data, err := vfs.ReadFile(path.Join("sounds", slug+".wav"))
	if err != nil {
		http.Error(w, "sound not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}
