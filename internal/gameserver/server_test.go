package gameserver

import (
	"testing"
	"time"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/wire"
)

// waitFor polls cond until it holds or the deadline passes. Match state is
// mutated on the authority goroutine and read through atomics, so listings
// settle asynchronously after a join or order.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		if cond() {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func sessionByID(s []SessionInfo, id string) (SessionInfo, bool) {
	for _, si := range s {
		if si.ID == id {
			return si, true
		}
	}
	return SessionInfo{}, false
}

// TestSessionListing covers the discovery surface Phase 0 adds: a lazily created
// match carries its name/kind metadata, its player count tracks join/leave, and
// its unit count reflects spawns once the authority ticks them in.
func TestSessionListing(t *testing.T) {
	s := NewServer(testSpawn, 1, 3)
	defer s.Stop()

	// A freshly created match carries the metadata supplied at creation.
	m := s.match("arena", 1, 3, "My Sandbox", "sandbox")
	got, ok := sessionByID(s.Sessions(), "arena")
	if !ok {
		t.Fatal("created match not listed")
	}
	if got.Name != "My Sandbox" || got.Kind != "sandbox" {
		t.Fatalf("metadata = %q/%q, want My Sandbox/sandbox", got.Name, got.Kind)
	}
	if got.Players != 0 {
		t.Fatalf("players = %d, want 0 before any join", got.Players)
	}

	// Joining bumps the player count.
	lb := newLoopback()
	m.AddConn(serverConn{lb: lb})
	lb.toServer <- wire.ClientMsg{Type: wire.MsgJoin, Join: &wire.JoinReq{MatchID: "arena"}}
	waitFor(t, "player count to reach 1", func() bool {
		si, _ := sessionByID(s.Sessions(), "arena")
		return si.Players == 1
	})

	// Spawning a unit and letting the authority tick it in bumps the unit count.
	lb.toServer <- wire.ClientMsg{Type: wire.MsgOrder, Order: &order.Order{
		Kind: order.KindSpawn, Name: "u", SpawnAt: fixed.Vec2{}, Side: 0,
	}}
	waitFor(t, "unit count to reach 1", func() bool {
		si, _ := sessionByID(s.Sessions(), "arena")
		return si.Units == 1
	})

	// A second match created without metadata still lists, with empty fields.
	s.match("default", 1, 3, "", "")
	if _, ok := sessionByID(s.Sessions(), "default"); !ok {
		t.Fatal("second match not listed")
	}
}
