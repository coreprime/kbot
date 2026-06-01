package gameserver

import (
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/coreprime/kbot/engine/sim"
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

	done     chan struct{}
	doneOnce sync.Once
}

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

// Match returns the match with the given id, creating and starting it on first
// use so a client can connect to a fresh game by naming it.
func (s *Server) Match(id string, seed uint32, inputDelay uint64) *Match {
	return s.match(id, seed, inputDelay, "", "")
}

// match returns (or lazily creates) the named match, tagging a freshly created
// one with the given listing metadata. Metadata only applies on creation: a
// joiner reaching an existing match keeps the creator's name and kind.
func (s *Server) match(id string, seed uint32, inputDelay uint64, name, kind string) *Match {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m, ok := s.matches[id]; ok {
		return m
	}
	m := NewMatch(id, seed, inputDelay, s.spawn, s.cob)
	m.SetInfo(name, kind)
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
// parameters, which feed the session listing.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id := q.Get("match")
	if id == "" {
		id = "default"
	}
	m := s.match(id, s.seed, s.inputDelay, q.Get("name"), q.Get("kind"))
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
