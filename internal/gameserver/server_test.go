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

// TestIdleReaper covers the lifecycle reaper: a match that has sat empty past
// the grace is retired, a still-occupied match is spared no matter the clock,
// and a freshly created (never-joined) match survives until the grace lapses.
func TestIdleReaper(t *testing.T) {
	s := NewServer(testSpawn, 1, 3)
	defer s.Stop()

	// A just-created, never-joined match is idle but inside the grace window,
	// so an immediate reap leaves it alone.
	idle := s.match("idle", 1, 3, "", "sandbox")
	s.reapIdle(time.Now())
	if _, ok := sessionByID(s.Sessions(), "idle"); !ok {
		t.Fatal("idle match reaped before grace elapsed")
	}

	// Backdate its empty timestamp past the grace and it is collected.
	idle.emptySince.Store(time.Now().Add(-2 * idleGrace).UnixNano())
	s.reapIdle(time.Now())
	if _, ok := sessionByID(s.Sessions(), "idle"); ok {
		t.Fatal("idle match not reaped after grace elapsed")
	}

	// An occupied match is never reaped, even with the clock pushed far ahead.
	busy := s.match("busy", 1, 3, "", "sandbox")
	lb := newLoopback()
	busy.AddConn(serverConn{lb: lb})
	lb.toServer <- wire.ClientMsg{Type: wire.MsgJoin, Join: &wire.JoinReq{MatchID: "busy"}}
	waitFor(t, "busy match to register its player", func() bool {
		si, _ := sessionByID(s.Sessions(), "busy")
		return si.Players == 1
	})
	s.reapIdle(time.Now().Add(time.Hour))
	if _, ok := sessionByID(s.Sessions(), "busy"); !ok {
		t.Fatal("occupied match was reaped")
	}
}

// TestExplicitLeave covers the voluntary-departure path: a leave message frees
// the player slot and marks the match empty, so the reaper can then collect it.
func TestExplicitLeave(t *testing.T) {
	s := NewServer(testSpawn, 1, 3)
	defer s.Stop()

	m := s.match("room", 1, 3, "", "sandbox")
	lb := newLoopback()
	m.AddConn(serverConn{lb: lb})
	lb.toServer <- wire.ClientMsg{Type: wire.MsgJoin, Join: &wire.JoinReq{MatchID: "room"}}
	waitFor(t, "player count to reach 1", func() bool {
		si, _ := sessionByID(s.Sessions(), "room")
		return si.Players == 1
	})

	// Leaving drops the slot back to zero.
	lb.toServer <- wire.ClientMsg{Type: wire.MsgLeave}
	waitFor(t, "player count to fall to 0", func() bool {
		si, _ := sessionByID(s.Sessions(), "room")
		return si.Players == 0
	})

	// And the now-empty match is eligible for reaping once the grace lapses.
	m.emptySince.Store(time.Now().Add(-2 * idleGrace).UnixNano())
	s.reapIdle(time.Now())
	if _, ok := sessionByID(s.Sessions(), "room"); ok {
		t.Fatal("emptied match not reaped after leave + grace")
	}
}
