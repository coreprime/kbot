package gameserver

import (
	"errors"
	"testing"
	"time"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/session"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/engine/wire"
)

// loopback is an in-memory Conn pair: the match holds one end, the test driver
// the other. It preserves message order, which is what the lockstep guarantee
// relies on.
type loopback struct {
	toServer chan wire.ClientMsg
	toClient chan wire.ServerMsg
	closed   chan struct{}
}

func newLoopback() *loopback {
	return &loopback{
		toServer: make(chan wire.ClientMsg, 64),
		toClient: make(chan wire.ServerMsg, 256),
		closed:   make(chan struct{}),
	}
}

// serverConn is the end the match consumes.
type serverConn struct{ lb *loopback }

func (c serverConn) Send(m wire.ServerMsg) error {
	select {
	case c.lb.toClient <- m:
		return nil
	case <-c.lb.closed:
		return errors.New("closed")
	}
}

func (c serverConn) Recv() (wire.ClientMsg, error) {
	select {
	case m := <-c.lb.toServer:
		return m, nil
	case <-c.lb.closed:
		return wire.ClientMsg{}, errors.New("closed")
	}
}

func (c serverConn) Close() error { return nil }

func testSpawn(name string) (*sim.UnitMeta, sim.Binding) {
	return &sim.UnitMeta{
		Name: name, CanMove: true,
		MaxVelocity: fixed.FromFloat(1.5),
		TurnRate:    fixed.FromInt(800),
		Accel:       fixed.FromFloat(0.1),
		BrakeRate:   fixed.FromFloat(0.2),
	}, nil
}

// TestWireLockstep is TestLockstepAgreement carried over the transport: a client
// that runs the same engine locally and applies the command frames the match
// broadcasts stays bit-identical to the authority, verified against the
// authoritative hash digests.
func TestWireLockstep(t *testing.T) {
	m := NewMatch("t", 7, 3, testSpawn, nil)
	go m.Run()
	defer m.Stop()

	lb := newLoopback()
	m.AddConn(serverConn{lb: lb})

	// Join handshake.
	lb.toServer <- wire.ClientMsg{Type: wire.MsgJoin, Join: &wire.JoinReq{MatchID: "t"}}

	var local *session.Session
	awaitAccept := func() {
		for msg := range lb.toClient {
			if msg.Type == wire.MsgJoinAccept {
				w := sim.New(sim.Config{Seed: msg.JoinAccept.Seed, Spawn: testSpawn})
				local = session.New(session.Config{World: w, InputDelay: uint64(msg.JoinAccept.InputDelay)})
				return
			}
		}
	}
	awaitAccept()
	if local == nil {
		t.Fatal("never received join accept")
	}

	// Issue a spawn then a move; the authority assigns and broadcasts exec ticks.
	lb.toServer <- wire.ClientMsg{Type: wire.MsgOrder, Order: &order.Order{
		Kind: order.KindSpawn, Name: "u", SpawnAt: fixed.Vec2{}, Side: 0,
	}}
	lb.toServer <- wire.ClientMsg{Type: wire.MsgOrder, Order: &order.Order{
		Kind: order.KindMove, UnitIDs: []uint32{1},
		Target: fixed.Vec2{X: fixed.FromInt(150), Z: fixed.FromInt(40)},
	}}

	checks := 0
	deadline := time.After(3 * time.Second)
	for checks < 6 {
		select {
		case <-deadline:
			t.Fatalf("timed out after %d hash checks", checks)
		case msg := <-lb.toClient:
			switch msg.Type {
			case wire.MsgCommand:
				for _, o := range msg.Command.Orders {
					local.ScheduleAt(msg.Command.Tick, o)
				}
			case wire.MsgHash:
				// Step the local engine up to the authoritative tick, applying
				// any command frames scheduled along the way, then compare.
				for local.World().Tick() < msg.Hash.Tick {
					local.Step()
				}
				if got := local.World().Hash(); got != msg.Hash.Hash {
					t.Fatalf("desync at tick %d: local %d != authority %d",
						msg.Hash.Tick, got, msg.Hash.Hash)
				}
				checks++
			}
		}
	}
}
