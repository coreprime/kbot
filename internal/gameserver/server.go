package gameserver

import (
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/coreprime/kbot-engine/engine/sim"
)

const (
	// idleGrace is how long a match may sit with no connected clients before
	// the reaper retires it. It is long enough to survive a brief reconnect
	// (a page reload, a flaky network) without orphaning abandoned sessions.
	idleGrace = 30 * time.Second
	// reapInterval is how often the reaper scans for idle matches.
	reapInterval = 10 * time.Second
)

// Server hosts one or more matches and routes websocket upgrades to them. It
// owns the lifecycle of each match's authority goroutine.
type Server struct {
	mu         sync.Mutex
	matches    map[string]*Match
	spawn      sim.SpawnFunc
	cob        CobSource
	seed       uint32
	inputDelay uint64
	// terrain resolves a map path (as named in the "map" upgrade parameter)
	// into the height field the authority installs on a freshly created match,
	// so a hosted game runs its lockstep sim on the real battlefield. Optional
	// (nil = every match plays on the flat grid).
	terrain TerrainProvider

	done     chan struct{}
	doneOnce sync.Once
}

// TerrainProvider builds the authority-side height field for a map path. It
// returns nil for an unknown/unreadable map so the match falls back to the
// flat grid. The host injects one via SetTerrainProvider.
type TerrainProvider func(mapPath string) *sim.Terrain

// NewServer creates an empty server that builds matches with the given spawn
// provider, COB source, seed and input delay. The cob source (optional, may be
// nil) backs each match's units with their scripts so the authority stays
// bit-identical to the COB-running clients. It starts a background reaper that
// retires matches left empty past the idle grace.
func NewServer(spawn sim.SpawnFunc, cob CobSource, seed uint32, inputDelay uint64) *Server {
	s := &Server{
		matches:    make(map[string]*Match),
		spawn:      spawn,
		cob:        cob,
		seed:       seed,
		inputDelay: inputDelay,
		done:       make(chan struct{}),
	}
	go s.reapLoop()
	return s
}

// SetTerrainProvider installs the map-to-terrain resolver used to seed a new
// match's authority world when a client names a "map" on the upgrade. It must
// be set before any match is created (during host wiring), and is safe to call
// once at startup.
func (s *Server) SetTerrainProvider(fn TerrainProvider) { s.terrain = fn }

// Match returns the match with the given id, creating and starting it on first
// use so a client can connect to a fresh game by naming it.
func (s *Server) Match(id string, seed uint32, inputDelay uint64) *Match {
	return s.match(id, seed, inputDelay, "", "", "")
}

// match returns (or lazily creates) the named match, tagging a freshly created
// one with the given listing metadata. Metadata only applies on creation: a
// joiner reaching an existing match keeps the creator's name, kind and map. A
// non-empty mapPath installs that map's height field on the new match's
// authority world (when a terrain provider is set) so the hosted sim runs on
// the real battlefield.
func (s *Server) match(id string, seed uint32, inputDelay uint64, name, kind, mapPath string) *Match {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m, ok := s.matches[id]; ok {
		return m
	}
	m := NewMatch(id, seed, inputDelay, s.spawn, s.cob)
	m.SetInfo(name, kind)
	// Install terrain before the authority goroutine starts so the world's
	// height field is in place for tick 0 — a lockstep peer must share the
	// identical grid before any unit exists (units, not terrain, are hashed).
	if mapPath != "" {
		m.SetMap(mapPath)
		if s.terrain != nil {
			m.SetTerrain(s.terrain(mapPath))
		}
	}
	go m.Run()
	s.matches[id] = m
	return m
}

// Sessions returns a snapshot of every active match for discovery/listing,
// oldest first.
func (s *Server) Sessions() []SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SessionInfo, 0, len(s.matches))
	for _, m := range s.matches {
		out = append(out, m.info())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

// ServeHTTP upgrades websocket connections and binds them to the match named by
// the "match" query parameter (defaulting to "default"). A connection that
// creates a new match may name and classify it via the "name" and "kind"
// parameters (which feed the session listing) and choose its battlefield via
// the "map" parameter (which installs the authority's terrain and is echoed to
// joiners so they load the same height field).
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("match")
	if id == "" {
		id = "default"
	}
	m := s.match(id, s.seed, s.inputDelay, q.Get("name"), q.Get("kind"), q.Get("map"))
	m.ServeWS(w, r)
}

// reapLoop scans for idle matches on a fixed interval until the server stops.
func (s *Server) reapLoop() {
	ticker := time.NewTicker(reapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.reapIdle(time.Now())
		}
	}
}

// reapIdle stops and removes every match that has sat empty since before
// now-idleGrace. A match reports the moment it last emptied via emptySince
// (zero while occupied), so an occupied match is never reaped.
func (s *Server) reapIdle(now time.Time) {
	cutoff := now.Add(-idleGrace).UnixNano()
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, m := range s.matches {
		if since := m.emptySince.Load(); since != 0 && since <= cutoff {
			m.Stop()
			delete(s.matches, id)
		}
	}
}

// Stop ends every running match and halts the reaper.
func (s *Server) Stop() {
	s.doneOnce.Do(func() { close(s.done) })
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.matches {
		m.Stop()
	}
}
