// Package gameserver hosts authoritative game simulations and relays their
// command stream to connected clients over a transport. The simulation logic
// is the same engine the browser runs as wasm; this package only owns the
// authority loop (one fixed 40 Hz tick) and the fan-out of orders, command
// frames, snapshots and hashes. The transport is abstracted behind Conn so the
// orchestration is testable with an in-memory loopback and the real websocket
// adapter is a thin layer.
package gameserver

import (
	"time"

	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/session"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/engine/wire"
)

// Conn is one client's bidirectional message channel.
type Conn interface {
	Send(wire.ServerMsg) error
	Recv() (wire.ClientMsg, error)
	Close() error
}

const (
	hashEvery     = 8   // broadcast a state hash every N ticks
	snapshotEvery = 200 // broadcast a full snapshot every N ticks
	clientBuffer  = 256 // queued server messages per client before drop
)

type client struct {
	conn Conn
	out  chan wire.ServerMsg
	slot int
}

// Match is one authoritative game running its own tick loop.
type Match struct {
	id         string
	seed       uint32
	inputDelay uint64
	session    *session.Session

	register   chan *client
	unregister chan *client
	orders     chan clientOrder
	quit       chan struct{}

	clients  map[*client]struct{}
	nextSlot int
}

type clientOrder struct {
	from *client
	ord  wire.ClientMsg
}

// NewMatch creates a match with a fresh world and the given spawn provider.
func NewMatch(id string, seed uint32, inputDelay uint64, spawn sim.SpawnFunc) *Match {
	w := sim.New(sim.Config{Seed: seed, Spawn: spawn})
	return &Match{
		id:         id,
		seed:       seed,
		inputDelay: inputDelay,
		session:    session.New(session.Config{World: w, InputDelay: inputDelay}),
		register:   make(chan *client),
		unregister: make(chan *client),
		orders:     make(chan clientOrder, 1024),
		quit:       make(chan struct{}),
		clients:    make(map[*client]struct{}),
	}
}

// Run drives the authority loop until Stop. It must run on its own goroutine;
// it is the sole owner of the session, so no locking is needed.
func (m *Match) Run() {
	ticker := time.NewTicker(time.Duration(sim.TickMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-m.quit:
			return
		case c := <-m.register:
			m.onJoin(c)
		case c := <-m.unregister:
			m.onLeave(c)
		case o := <-m.orders:
			m.onOrder(o)
		case <-ticker.C:
			m.step()
		}
	}
}

// Stop ends the match loop.
func (m *Match) Stop() { close(m.quit) }

func (m *Match) onJoin(c *client) {
	c.slot = m.nextSlot
	m.nextSlot++
	m.clients[c] = struct{}{}
	go c.writePump()
	c.send(wire.ServerMsg{Type: wire.MsgJoinAccept, JoinAccept: &wire.JoinAccept{
		PlayerSlot: c.slot,
		TickRate:   sim.TickHz,
		InputDelay: int(m.inputDelay),
		Seed:       m.seed,
		Tick:       m.session.World().Tick(),
	}})
	// Full state so a late joiner can initialize its local engine.
	c.send(wire.ServerMsg{Type: wire.MsgSnapshot, Snapshot: m.buildSnapshot()})
	// Replay command frames already scheduled for future ticks so the new
	// client does not miss orders issued before it connected.
	for _, t := range m.session.PendingTicks() {
		c.send(wire.ServerMsg{Type: wire.MsgCommand, Command: &wire.CommandFrame{
			Tick:   t,
			Orders: m.session.OrdersForTick(t),
		}})
	}
}

func (m *Match) onLeave(c *client) {
	if _, ok := m.clients[c]; ok {
		delete(m.clients, c)
		close(c.out)
	}
}

func (m *Match) onOrder(o clientOrder) {
	if o.ord.Order == nil {
		return
	}
	// Authority assigns the execution tick; clients receive it ahead of time.
	exec := m.session.World().Tick() + m.inputDelay + 1
	m.session.ScheduleAt(exec, *o.ord.Order)
	m.broadcast(wire.ServerMsg{Type: wire.MsgCommand, Command: &wire.CommandFrame{
		Tick:   exec,
		Orders: []order.Order{*o.ord.Order},
	}})
}

func (m *Match) step() {
	m.session.Step()
	tick := m.session.World().Tick()
	if tick%hashEvery == 0 {
		m.broadcast(wire.ServerMsg{Type: wire.MsgHash, Hash: &wire.HashMsg{
			Tick: tick, Hash: m.session.World().Hash(),
		}})
	}
	if tick%snapshotEvery == 0 {
		m.broadcast(wire.ServerMsg{Type: wire.MsgSnapshot, Snapshot: m.buildSnapshot()})
	}
}

func (m *Match) buildSnapshot() *wire.Snapshot {
	w := m.session.World()
	snap := &wire.Snapshot{Tick: w.Tick(), Hash: w.Hash()}
	for _, ru := range w.ExportUnits() {
		snap.Units = append(snap.Units, wire.UnitSnap{
			ID: ru.ID, Name: ru.Name, Side: ru.Side,
			X: ru.Pos.X, Y: ru.Pos.Y, Z: ru.Pos.Z,
			Heading: ru.Heading, Speed: ru.Speed,
			HasMove: ru.HasMove, TX: ru.MoveTarget.X, TZ: ru.MoveTarget.Z,
			Health: ru.Health, Dead: ru.Dead,
		})
	}
	return snap
}

func (m *Match) broadcast(msg wire.ServerMsg) {
	for c := range m.clients {
		c.send(msg)
	}
}

// AddConn registers a connection with the match and starts its read loop. The
// caller (the websocket handler) provides an already-handshaken Conn.
func (m *Match) AddConn(conn Conn) {
	c := &client{conn: conn, out: make(chan wire.ServerMsg, clientBuffer)}
	go c.readPump(m)
}

func (c *client) readPump(m *Match) {
	registered := false
	for {
		msg, err := c.conn.Recv()
		if err != nil {
			if registered {
				m.unregister <- c
			}
			return
		}
		switch msg.Type {
		case wire.MsgJoin:
			if !registered {
				m.register <- c
				registered = true
			}
		case wire.MsgOrder:
			if registered {
				m.orders <- clientOrder{from: c, ord: msg}
			}
		case wire.MsgAck:
			// flow control hook; no-op for now.
		}
	}
}

func (c *client) writePump() {
	for msg := range c.out {
		if err := c.conn.Send(msg); err != nil {
			return
		}
	}
	_ = c.conn.Close()
}

// send queues a message for the client, dropping it if the buffer is full so a
// slow client never stalls the authority loop.
func (c *client) send(msg wire.ServerMsg) {
	select {
	case c.out <- msg:
	default:
	}
}
