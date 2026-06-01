package gameserver

import (
	"net/http"
	"sort"
	"sync"

	"github.com/coreprime/kbot/engine/sim"
)

// Server hosts one or more matches and routes websocket upgrades to them. It
// owns the lifecycle of each match's authority goroutine.
type Server struct {
	mu         sync.Mutex
	matches    map[string]*Match
	spawn      sim.SpawnFunc
	seed       uint32
	inputDelay uint64
}

// NewServer creates an empty server that builds matches with the given spawn
// provider, seed and input delay.
func NewServer(spawn sim.SpawnFunc, seed uint32, inputDelay uint64) *Server {
	return &Server{
		matches:    make(map[string]*Match),
		spawn:      spawn,
		seed:       seed,
		inputDelay: inputDelay,
	}
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
	m := NewMatch(id, seed, inputDelay, s.spawn)
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

// Stop ends every running match.
func (s *Server) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.matches {
		m.Stop()
	}
}
