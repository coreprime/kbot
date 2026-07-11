package studio

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot/internal/kbotctx"
	"github.com/coreprime/kbot/internal/workspace"
)

// WorkspaceManager owns the set of live Studio sessions, keyed by a URL-safe id.
// The hub serves a picker at "/", a small JSON API under "/api/hub/", and routes
// "/workspaces/<id>/..." to the matching session (its API mux, or the editor
// SPA for navigations).
type WorkspaceManager struct {
	mu        sync.Mutex
	sessions  map[string]*Session
	cacheRoot string
}

func newWorkspaceManager(cacheRoot string) *WorkspaceManager {
	return &WorkspaceManager{sessions: map[string]*Session{}, cacheRoot: cacheRoot}
}

func (m *WorkspaceManager) getOrNil(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

// adopt registers a started session under id (idempotent: an existing session
// for id is returned and the new one discarded).
func (m *WorkspaceManager) adopt(id string, build func() (*Session, error)) (*Session, error) {
	m.mu.Lock()
	if s, ok := m.sessions[id]; ok {
		m.mu.Unlock()
		return s, nil
	}
	m.mu.Unlock()

	s, err := build()
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	if existing, ok := m.sessions[id]; ok { // lost a race — keep the first
		m.mu.Unlock()
		_ = s.close()
		return existing, nil
	}
	s.id = id
	m.sessions[id] = s
	m.mu.Unlock()
	s.start()
	return s, nil
}

func (m *WorkspaceManager) cacheDir(id string) string {
	return filepath.Join(m.cacheRoot, id)
}

// openLocalPath opens a read-only session over a single directory (the explicit
// `kbot studio <path>` form).
func (m *WorkspaceManager) openLocalPath(id, name, path string) (*Session, error) {
	return m.adopt(id, func() (*Session, error) {
		vfs, err := filesystem.NewVirtualFileSystem(path, studioFSConfig())
		if err != nil {
			return nil, err
		}
		return newSession(id, name, vfs, m.cacheDir(id)), nil
	})
}

// openContext opens a read-only session over a context and its parent chain.
func (m *WorkspaceManager) openContext(cfg *kbotctx.Config, alias string) (*Session, error) {
	id := "ctx-" + slug(alias)
	return m.adopt(id, func() (*Session, error) {
		srcs, err := workspace.ContextSources(cfg, alias)
		if err != nil {
			return nil, err
		}
		vfs, err := filesystem.NewLayered(srcs, studioFSConfig())
		if err != nil {
			return nil, err
		}
		s := newSession(id, alias, vfs, m.cacheDir(id))
		s.game = cfg.Contexts[alias].Game
		return s, nil
	})
}

// openWorkspace opens a writable session over a workspace manifest folder.
func (m *WorkspaceManager) openWorkspace(cfg *kbotctx.Config, dir string) (*Session, error) {
	man, err := workspace.Load(dir)
	if err != nil {
		return nil, err
	}
	id := "ws-" + slug(man.Name) + "-" + shortHash(man.Dir())
	return m.adopt(id, func() (*Session, error) {
		vfs, err := man.OpenVFS(cfg, studioFSConfig())
		if err != nil {
			return nil, err
		}
		s := newSession(id, man.Name, vfs, m.cacheDir(id))
		s.game = man.Game
		s.workDir = man.Dir()
		s.exportFormat = man.Export.Format
		return s, nil
	})
}

// register wires the hub routes onto mux.
func (m *WorkspaceManager) register(mux *http.ServeMux) {
	mux.HandleFunc("/api/hub/contexts", m.handleContexts)
	mux.HandleFunc("/api/hub/workspaces", m.handleWorkspaces)
	mux.HandleFunc("/api/hub/defaults", m.handleDefaults)
	mux.HandleFunc("/api/hub/open", m.handleOpen)
	mux.HandleFunc("/api/hub/forget", m.handleForget)
	mux.HandleFunc("/api/hub/export", m.handleExport)
	mux.HandleFunc("/api/build-id", handleBuildID)
	mux.HandleFunc("/workspaces/", m.handleWorkspace)
	mux.HandleFunc("/", m.handleRoot)
}

var (
	buildIDOnce sync.Once
	buildIDVal  string
)

// buildID fingerprints the embedded web bundle. index.html references every
// hashed asset (the JS chunks AND the wasm engine), so its bytes shift on any
// rebuild — making its hash a one-line "is this the current build?" token. The
// client polls /api/build-id and reloads when it changes, so a server restart
// with a new build never silently leaves an open tab running stale JS.
func buildID() string {
	buildIDOnce.Do(func() {
		buildIDVal = "dev"
		if sub, err := fs.Sub(webFS, "web/dist"); err == nil {
			if data, err := fs.ReadFile(sub, "index.html"); err == nil {
				h := fnv.New64a()
				_, _ = h.Write(data)
				buildIDVal = fmt.Sprintf("%016x", h.Sum64())
			}
		}
	})
	return buildIDVal
}

func handleBuildID(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = fmt.Fprintf(w, `{"id":%q}`, buildID())
}

// handleWorkspace dispatches /workspaces/<id>/... to the session: API/host
// subpaths hit the session mux; everything else serves the editor SPA.
func (m *WorkspaceManager) handleWorkspace(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/workspaces/")
	id, sub, _ := strings.Cut(rest, "/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	sess := m.getOrNil(id)
	if sess == nil {
		http.Error(w, "workspace not open (open it from the picker)", http.StatusNotFound)
		return
	}
	if strings.HasPrefix(sub, "api/") || strings.HasPrefix(sub, "host/") {
		r.URL.Path = "/" + sub
		sess.routes().ServeHTTP(w, r)
		return
	}
	// Navigation within the workspace → the editor SPA. The in-page shim reads
	// the /workspaces/<id>/ prefix from the URL and scopes its API calls.
	serveEmbedFile(w, "index.html")
}

// handleRoot serves static assets from the embedded bundle and the picker page
// (the Preact picker.html entry) at "/".
func (m *WorkspaceManager) handleRoot(w http.ResponseWriter, r *http.Request) {
	clean := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
	if clean == "" || clean == "." {
		serveEmbedFile(w, "picker.html")
		return
	}
	serveEmbedFile(w, clean)
}

// ── hub API ────────────────────────────────────────────────────────────────

type hubContext struct {
	Alias   string `json:"alias"`
	Game    string `json:"game"`
	Version string `json:"version,omitempty"`
	Parent  string `json:"parent,omitempty"`
	Current bool   `json:"current"`
}

func (m *WorkspaceManager) handleContexts(w http.ResponseWriter, _ *http.Request) {
	cfg, err := kbotctx.Load()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	active, _, _, _ := cfg.Active()
	out := make([]hubContext, 0, len(cfg.Contexts))
	for _, alias := range cfg.Aliases() {
		c := cfg.Contexts[alias]
		out = append(out, hubContext{
			Alias: alias, Game: c.Game, Version: c.Version,
			Parent: c.Parent, Current: alias == active,
		})
	}
	writeJSONHub(w, map[string]any{"contexts": out})
}

func (m *WorkspaceManager) handleWorkspaces(w http.ResponseWriter, _ *http.Request) {
	cfg, err := kbotctx.Load()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	type wsOut struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Base string `json:"base"`
		Game string `json:"game,omitempty"`
	}
	out := make([]wsOut, 0, len(cfg.Workspaces))
	for _, ws := range cfg.Workspaces {
		game := ""
		if c, ok := cfg.Contexts[ws.Base]; ok {
			game = c.Game
		}
		out = append(out, wsOut{Name: ws.Name, Path: ws.Path, Base: ws.Base, Game: game})
	}
	writeJSONHub(w, map[string]any{"workspaces": out})
}

// handleForget removes a workspace from the recents index. It does not touch
// files on disk — only the picker's list. Idempotent.
func (m *WorkspaceManager) handleForget(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Dir string `json:"dir"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body: "+err.Error(), http.StatusBadRequest)
		return
	}
	cfg, err := kbotctx.Load()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	cfg.ForgetWorkspace(req.Dir)
	if err := cfg.Save(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSONHub(w, map[string]any{"ok": true})
}

// handleExport serves a workspace's mod as a downloadable HPI, packing the
// work folder at the given ?dir. A GET so the picker can trigger a download
// directly.
func (m *WorkspaceManager) handleExport(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("dir")
	if dir == "" {
		http.Error(w, "missing dir", http.StatusBadRequest)
		return
	}
	man, err := workspace.Load(dir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	data, err := packModHPI(man.Dir(), man.Export.Format)
	if err != nil {
		http.Error(w, "export failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", slug(man.Name)+".hpi"))
	_, _ = w.Write(data)
}

// handleDefaults reports sensible defaults for the New Workspace dialog —
// notably the OS-specific root under which new work folders are suggested.
func (m *WorkspaceManager) handleDefaults(w http.ResponseWriter, _ *http.Request) {
	writeJSONHub(w, map[string]any{"workspaceRoot": defaultWorkspaceRoot()})
}

// defaultWorkspaceRoot is the per-user folder new workspaces default under
// (e.g. ~/kbot-workspaces on macOS/Linux, %USERPROFILE%\kbot-workspaces on
// Windows). Falls back to a relative path if the home dir can't be resolved.
func defaultWorkspaceRoot() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "kbot-workspaces"
	}
	return filepath.Join(home, "kbot-workspaces")
}

type openRequest struct {
	Kind  string `json:"kind"` // "context" | "workspace" | "new"
	Alias string `json:"alias,omitempty"`
	Dir   string `json:"dir,omitempty"`
	Base  string `json:"base,omitempty"`
	Name  string `json:"name,omitempty"`
}

func (m *WorkspaceManager) handleOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var req openRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body: "+err.Error(), http.StatusBadRequest)
		return
	}
	cfg, err := kbotctx.Load()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var sess *Session
	switch req.Kind {
	case "context":
		sess, err = m.openContext(cfg, req.Alias)
	case "workspace":
		sess, err = m.openWorkspace(cfg, req.Dir)
	case "new":
		sess, err = m.createAndOpenWorkspace(cfg, req)
	default:
		http.Error(w, "unknown kind: "+req.Kind, http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSONHub(w, map[string]any{
		"id":   sess.id,
		"name": sess.name,
		"url":  "/workspaces/" + sess.id + "/",
	})
}

// createAndOpenWorkspace writes a new workspace manifest then opens it.
func (m *WorkspaceManager) createAndOpenWorkspace(cfg *kbotctx.Config, req openRequest) (*Session, error) {
	if req.Dir == "" || req.Base == "" || req.Name == "" {
		return nil, fmt.Errorf("new workspace needs dir, base, and name")
	}
	base, ok := cfg.Contexts[req.Base]
	if !ok {
		return nil, fmt.Errorf("base context %q not found", req.Base)
	}
	man := workspace.New(req.Dir, req.Name, base, req.Base)
	if err := man.Save(); err != nil {
		return nil, err
	}
	if err := cfg.RememberWorkspace(man.Ref()); err == nil {
		_ = cfg.Save()
	}
	return m.openWorkspace(cfg, req.Dir)
}

// ── helpers ──────────────────────────────────────────────────────────────

func writeJSONHub(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

// serveEmbedFile serves a file from the embedded web/dist bundle, falling back
// to index.html for unknown paths (SPA routing).
func serveEmbedFile(w http.ResponseWriter, name string) {
	sub, err := fs.Sub(webFS, "web/dist")
	if err != nil {
		http.Error(w, "embed error", http.StatusInternalServerError)
		return
	}
	data, err := fs.ReadFile(sub, name)
	if err != nil {
		data, err = fs.ReadFile(sub, "index.html")
		if err != nil {
			http.NotFound(w, &http.Request{})
			return
		}
		name = "index.html"
	}
	w.Header().Set("Content-Type", contentTypeFor(name))
	// index.html is the entry that names the hashed assets; never let a stale
	// copy stick (it would keep pointing a tab at an old bundle). Hashed assets
	// keep no-cache (revalidated) since their names already bust on change.
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	_, _ = w.Write(data)
}

// slug makes an alias/name safe for a URL path segment.
func slug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '_' || r == '-':
			b.WriteRune('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "ws"
	}
	return out
}

func shortHash(s string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return fmt.Sprintf("%08x", h.Sum32())
}
