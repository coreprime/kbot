package gameserver

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coreprime/kbot-engine/engine/fixed"
	"github.com/coreprime/kbot-engine/engine/order"
	"github.com/coreprime/kbot-engine/engine/sim"
	"github.com/coreprime/kbot-engine/engine/wire"
)

func captureMatchPanics(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var got []string
	prev := logMatchPanic
	logMatchPanic = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, fmt.Sprintf(format, args...))
	}
	t.Cleanup(func() { logMatchPanic = prev })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), got...)
	}
}

// joinAndSpawn joins a loopback client to m, orders a spawn of unit and waits
// until the authority has stepped past the spawn's execution tick.
func joinAndSpawn(t *testing.T, m *Match, unit string) {
	t.Helper()
	lb := newLoopback()
	m.AddConn(serverConn{lb: lb})
	lb.toServer <- wire.ClientMsg{Type: wire.MsgJoin, Join: &wire.JoinReq{MatchID: m.id}}
	lb.toServer <- wire.ClientMsg{Type: wire.MsgOrder, Order: &order.Order{
		Kind: order.KindSpawn, Name: unit, SpawnAt: fixed.Vec2{}, Side: 0,
	}}
	hashes := 0
	deadline := time.After(5 * time.Second)
	for hashes < 3 {
		select {
		case <-deadline:
			t.Fatalf("match stopped ticking (%d hashes)", hashes)
		case msg := <-lb.toClient:
			if msg.Type == wire.MsgHash {
				hashes++
			}
		}
	}
}

// A unit whose COB panics while loading spawns without its script; the match
// keeps running.
func TestMatchSurvivesAPanickingScript(t *testing.T) {
	logs := captureMatchPanics(t)
	cob := func(name string) ([]byte, bool) { panic("cob table past end of file") }
	m := NewMatch("cob", 7, 3, testSpawn, cob)
	go m.Run()
	defer m.Stop()

	joinAndSpawn(t, m, "armbad")
	if n := m.units.Load(); n != 1 {
		t.Errorf("units = %d, want the unit spawned without its script", n)
	}
	if got := logs(); len(got) != 1 || !strings.Contains(got[0], "scripts/armbad.cob") {
		t.Errorf("log = %q, want one line naming the script", got)
	}
}

// A unit whose definition panics while loading is not spawned; the match keeps
// running.
func TestMatchSkipsAUnitWhoseDefinitionPanics(t *testing.T) {
	logs := captureMatchPanics(t)
	spawn := func(name string) (*sim.UnitMeta, sim.Binding) {
		if name == "armbad" {
			panic("index out of range")
		}
		return testSpawn(name)
	}
	m := NewMatch("fbi", 7, 3, spawn, nil)
	go m.Run()
	defer m.Stop()

	joinAndSpawn(t, m, "armbad")
	if n := m.units.Load(); n != 0 {
		t.Errorf("units = %d, want the unit skipped", n)
	}
	if got := logs(); len(got) != 1 || !strings.Contains(got[0], "armbad") {
		t.Errorf("log = %q, want one line naming the unit", got)
	}
}

// A panic in the authority loop itself stops that match only: Run returns, the
// match is stopped and marked for the reaper.
func TestMatchStopsAfterALoopPanic(t *testing.T) {
	logs := captureMatchPanics(t)
	m := NewMatch("broken", 7, 3, testSpawn, nil)
	m.session = nil // the join handler dereferences it
	done := make(chan struct{})
	go func() {
		defer close(done)
		m.Run()
	}()

	lb := newLoopback()
	m.AddConn(serverConn{lb: lb})
	lb.toServer <- wire.ClientMsg{Type: wire.MsgJoin, Join: &wire.JoinReq{MatchID: "broken"}}

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after the panic")
	}
	select {
	case <-m.quit:
	default:
		t.Error("match not stopped")
	}
	if m.emptySince.Load() != 1 {
		t.Error("match not marked for the reaper")
	}
	if got := logs(); len(got) != 1 || !strings.Contains(got[0], "match broken stopped after a panic") {
		t.Errorf("log = %q", got)
	}
	close(lb.closed)
}
