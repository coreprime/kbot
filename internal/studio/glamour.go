package studio

import (
	"bytes"
	"net/http"
	"path"
	"sort"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/pcx"
)

// Glamour image slideshow source: TA ships ~50 PCX splash artworks
// under bitmaps/glamour/.  The welcome dialog fades through them; the
// list is fixed for a given VFS so we cache it on first read, and
// each rendered PNG is memoised so flipping through repeats is free.

var (
	glamourListMu sync.Mutex
	glamourList   []string

	glamourPNGMu sync.RWMutex
	glamourPNG   = map[string][]byte{}
)

// listGlamourSlugs walks the VFS for bitmaps/glamour/*.pcx and returns
// the lowercase basenames (without extension), sorted for stability.
// Cached after the first call — the VFS is immutable for a session.
func listGlamourSlugs() []string {
	glamourListMu.Lock()
	defer glamourListMu.Unlock()
	if glamourList != nil {
		out := make([]string, len(glamourList))
		copy(out, glamourList)
		return out
	}
	if vfs == nil {
		glamourList = []string{}
		return nil
	}
	seen := map[string]bool{}
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "bitmaps/glamour/") {
			continue
		}
		if !strings.HasSuffix(lower, ".pcx") {
			continue
		}
		base := strings.TrimSuffix(path.Base(lower), ".pcx")
		if base == "" || seen[base] {
			continue
		}
		seen[base] = true
		glamourList = append(glamourList, base)
	}
	sort.Strings(glamourList)
	out := make([]string, len(glamourList))
	copy(out, glamourList)
	return out
}

func handleGlamourList(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=300")
	writeJSON(w, map[string]any{"images": listGlamourSlugs()})
}

// handleGlamourImage streams a PNG render of bitmaps/glamour/<slug>.pcx.
// Slug is the lowercased basename without extension — keeps the URL
// tidy and side-steps any case sensitivity in the VFS.
func handleGlamourImage(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/glamour/image/")
	slug := strings.ToLower(strings.TrimSpace(raw))
	if slug == "" || strings.ContainsAny(slug, "/\\") {
		http.Error(w, "bad slug", http.StatusBadRequest)
		return
	}
	glamourPNGMu.RLock()
	cached := glamourPNG[slug]
	glamourPNGMu.RUnlock()
	if cached != nil {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	if vfs == nil {
		http.Error(w, "no vfs mounted", http.StatusNotFound)
		return
	}
	data, err := vfs.ReadFile("bitmaps/glamour/" + slug + ".pcx")
	if err != nil {
		http.Error(w, "glamour image not found", http.StatusNotFound)
		return
	}
	var buf bytes.Buffer
	if err := pcx.ConvertToPNG(&buf, bytes.NewReader(data)); err != nil {
		http.Error(w, "convert pcx: "+err.Error(), http.StatusInternalServerError)
		return
	}
	out := buf.Bytes()
	glamourPNGMu.Lock()
	glamourPNG[slug] = out
	glamourPNGMu.Unlock()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(out)
}
