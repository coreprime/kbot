package studio

import (
	"bytes"
	"net/http"
	"path"
	"sort"
	"strings"

	"github.com/coreprime/kbot-io/formats/pcx"
)

// Glamour image slideshow source: TA ships ~50 PCX splash artworks
// under bitmaps/glamour/.  The welcome dialog fades through them; the
// list is fixed for a given VFS so we cache it on first read, and
// each rendered PNG is memoised so flipping through repeats is free.

// listGlamourSlugs walks the VFS for bitmaps/glamour/*.pcx and returns
// the lowercase basenames (without extension), sorted for stability.
// Cached after the first call — the VFS is immutable for a session.
func (sess *Session) listGlamourSlugs() []string {
	sess.glamourListMu.Lock()
	defer sess.glamourListMu.Unlock()
	if sess.glamourList != nil {
		out := make([]string, len(sess.glamourList))
		copy(out, sess.glamourList)
		return out
	}
	if sess.vfs == nil {
		sess.glamourList = []string{}
		return nil
	}
	seen := map[string]bool{}
	for _, p := range sess.vfs.List() {
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
		sess.glamourList = append(sess.glamourList, base)
	}
	sort.Strings(sess.glamourList)
	out := make([]string, len(sess.glamourList))
	copy(out, sess.glamourList)
	return out
}

// handleGlamourList returns the welcome-screen background image URLs for the
// session's game. Total Annihilation uses its bitmaps/glamour/ splash art;
// TA: Kingdoms (which ships none) falls back to map preview minimaps. Keyed on
// the game so the background source stays pluggable per title.
func (sess *Session) handleGlamourList(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=300")
	var urls []string
	for _, slug := range sess.listGlamourSlugs() {
		urls = append(urls, "/api/studio/glamour/image/"+slug)
	}
	// No splash art (e.g. TA:Kingdoms ships none) — fall back to map renders.
	if len(urls) == 0 {
		urls = sess.welcomeMapBackgrounds()
	}
	writeJSON(w, map[string]any{"images": urls})
}

// welcomeMapBackgrounds lists map-render URLs to use as welcome backgrounds when
// no splash art exists. /api/studio/map-render/ serves a full-resolution terrain
// render for TA:Kingdoms maps and falls back to the baked minimap for plain TNT
// maps, so this needs no per-game branch. Renders are lazy + memoised; full
// terrain renders are heavy, so the count is capped.
func (sess *Session) welcomeMapBackgrounds() []string {
	if sess.vfs == nil {
		return nil
	}
	var urls []string
	for _, p := range sess.vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "maps/") || !strings.HasSuffix(lower, ".tnt") {
			continue
		}
		urls = append(urls, "/api/studio/map-render/"+p)
		if len(urls) >= 12 {
			break
		}
	}
	return urls
}

// handleGlamourImage streams a PNG render of bitmaps/glamour/<slug>.pcx.
// Slug is the lowercased basename without extension — keeps the URL
// tidy and side-steps any case sensitivity in the VFS.
func (sess *Session) handleGlamourImage(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/glamour/image/")
	slug := strings.ToLower(strings.TrimSpace(raw))
	if slug == "" || strings.ContainsAny(slug, "/\\") {
		http.Error(w, "bad slug", http.StatusBadRequest)
		return
	}
	sess.glamourPNGMu.RLock()
	cached := sess.glamourPNG[slug]
	sess.glamourPNGMu.RUnlock()
	if cached != nil {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	if sess.vfs == nil {
		http.Error(w, "no vfs mounted", http.StatusNotFound)
		return
	}
	data, err := sess.vfs.ReadFile("bitmaps/glamour/" + slug + ".pcx")
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
	sess.glamourPNGMu.Lock()
	sess.glamourPNG[slug] = out
	sess.glamourPNGMu.Unlock()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(out)
}
