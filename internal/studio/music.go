package studio

import (
	"encoding/json"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
)

// /api/studio/music
//
// Two endpoints back the React Music panel:
//
//   GET /api/studio/music
//     → JSON {"tracks": ["0.mp3","1.mp3", ...]}, ordered by the numeric
//       prefix of each filename (so "0.mp3", "1.mp3", "2.mp3" sort ahead
//       of "10.mp3") and falls back to lexical order for non-numeric
//       names.  The client picks indices into this list to drive its
//       skip-forward / skip-back controls.
//
//   GET /api/studio/music/<filename>
//     → streams the raw bytes of music/<filename> from the VFS.  Sets
//       a sensible MIME based on extension (.mp3 / .ogg / .wav) and a
//       browser-cache header so Skip ◀ → ▶ back-and-forth doesn't keep
//       re-hitting the disk.
//
// Both endpoints reject path traversals — the slug can only contain
// characters that are reasonable in a filename, no slashes or leading
// dots.

func handleMusicList(w http.ResponseWriter, _ *http.Request) {
	if vfs == nil {
		http.Error(w, "no vfs mounted", http.StatusNotFound)
		return
	}
	out := make([]string, 0, 32)
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "music/") {
			continue
		}
		base := path.Base(p)
		ext := strings.ToLower(path.Ext(base))
		if ext != ".mp3" && ext != ".ogg" && ext != ".wav" {
			continue
		}
		out = append(out, base)
	}
	sort.Slice(out, func(i, j int) bool {
		// Prefer numeric ordering — TA's music folder is 0.mp3 … 17.mp3,
		// and a lexical sort would put 10.mp3 before 2.mp3.
		ni, ok1 := musicNumericPrefix(out[i])
		nj, ok2 := musicNumericPrefix(out[j])
		if ok1 && ok2 {
			return ni < nj
		}
		return out[i] < out[j]
	})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"tracks": out})
}

func musicNumericPrefix(name string) (int, bool) {
	stem := strings.TrimSuffix(name, path.Ext(name))
	n := 0
	if stem == "" {
		return 0, false
	}
	for i := 0; i < len(stem); i++ {
		c := stem[i]
		if c < '0' || c > '9' {
			if i == 0 {
				return 0, false
			}
			break
		}
		n = n*10 + int(c-'0')
	}
	return n, true
}

func handleMusicStream(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/music/")
	name, err := url.PathUnescape(raw)
	if err != nil || strings.TrimSpace(name) == "" {
		http.Error(w, "bad name", http.StatusBadRequest)
		return
	}
	name = strings.TrimSpace(name)
	if strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") {
		http.Error(w, "bad name", http.StatusBadRequest)
		return
	}
	if vfs == nil {
		http.Error(w, "no vfs mounted", http.StatusNotFound)
		return
	}
	// Same case-insensitive lookup pattern as handleSound — try the
	// conventional location first, then walk the listing if the FS is
	// case-sensitive and the casing in the VFS doesn't match.
	candidates := []string{
		path.Join("music", name),
		path.Join("Music", name),
	}
	var data []byte
	for _, p := range candidates {
		if b, err := vfs.ReadFile(p); err == nil {
			data = b
			break
		}
	}
	if data == nil {
		want := strings.ToLower(name)
		for _, p := range vfs.List() {
			lower := strings.ToLower(p)
			if !strings.HasPrefix(lower, "music/") {
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
		http.Error(w, "track not found", http.StatusNotFound)
		return
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".mp3":
		w.Header().Set("Content-Type", "audio/mpeg")
	case ".ogg":
		w.Header().Set("Content-Type", "audio/ogg")
	case ".wav":
		w.Header().Set("Content-Type", "audio/wav")
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}
