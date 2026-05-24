package studio

import (
	"net/http"
	"net/url"
	"path"
	"strings"
)

// handleSound streams sounds/<slug>.wav out of the VFS.  Slug is the
// basename without extension (case-insensitive); originally limited
// to a welcome-dialog allowlist, now opened up so the Controls
// overlay can play the FBI SoundCategory sounds (select/ok/arrived/
// activate/deactivate/...) for any loaded unit.
//
// Security: the slug is checked for path-separators + traversal
// segments before being joined onto "sounds/", so the endpoint
// can't be coaxed into reading arbitrary VFS paths.  This is a
// local CLI serving local game assets, so widening past the
// allowlist is appropriate.
func handleSound(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/sound/")
	name, err := url.PathUnescape(raw)
	if err != nil || strings.TrimSpace(name) == "" {
		http.Error(w, "bad slug", http.StatusBadRequest)
		return
	}
	// Accept either a bare stem or an explicit .wav extension; the
	// FBI-derived sound names come without the extension.
	slug := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(name), ".wav"))
	// Hard-reject anything that could escape sounds/.  Path separators
	// + leading-dot directory segments cover the obvious attacks; the
	// ReadFile fallback won't follow them anyway, but a clean 400
	// here keeps the access log readable.
	if slug == "" || strings.ContainsAny(slug, `/\`) || strings.HasPrefix(slug, ".") {
		http.Error(w, "bad slug", http.StatusBadRequest)
		return
	}
	if vfs == nil {
		http.Error(w, "no vfs mounted", http.StatusNotFound)
		return
	}
	// Probe the conventional location first, then fall back to a
	// case-insensitive walk through sounds/ — TA mixes casing across
	// the original release + mods, and ReadFile is path-sensitive on
	// case-aware filesystems.
	candidates := []string{
		path.Join("sounds", slug+".wav"),
		path.Join("sounds", strings.ToUpper(slug)+".WAV"),
		path.Join("Sounds", slug+".wav"),
	}
	var data []byte
	for _, p := range candidates {
		if b, err := vfs.ReadFile(p); err == nil {
			data = b
			break
		}
	}
	if data == nil {
		want := slug + ".wav"
		for _, p := range vfs.List() {
			lower := strings.ToLower(p)
			if !strings.HasPrefix(lower, "sounds/") {
				continue
			}
			if strings.ToLower(path.Base(lower)) == want {
				if b, err := vfs.ReadFile(p); err == nil {
					data = b
					break
				}
			}
		}
	}
	if data == nil {
		http.Error(w, "sound not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}
