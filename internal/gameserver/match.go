// Package gameserver hosts authoritative game simulations and relays their
// command stream to connected clients over a transport. The simulation logic
// is the same engine the browser runs as wasm; this package only owns the
// authority loop (one fixed 40 Hz tick) and the fan-out of orders, command
// frames, snapshots and hashes. The transport is abstracted behind Conn so the
// orchestration is testable with an in-memory loopback and the real websocket
// adapter is a thin layer.
package gameserver

import (
	"bytes"
	"log"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coreprime/kbot-engine/engine/order"
	"github.com/coreprime/kbot-engine/engine/script"
	"github.com/coreprime/kbot-engine/engine/session"
	"github.com/coreprime/kbot-engine/engine/sim"
	"github.com/coreprime/kbot-engine/engine/wire"
	"github.com/coreprime/kbot-io/formats/scripting"
)

// CobSource returns a unit type's raw COB bytecode, with ok=false for a
// script-less type. A match uses it to drive the authority's units through the
// same COB animation + scripted weapon-aim/death threads the browser clients
// run, so the authoritative simulation stays bit-identical to every client's
// prediction during combat — without it, the script-less server diverges from
// the COB-running clients the moment a fight starts.
type CobSource func(name string) ([]byte, bool)

// logMatchPanic reports a panic the match recovered from. It is a variable so
// tests can capture the message.
var logMatchPanic = func(format string, args ...any) { log.Printf(format, args...) }

// loadProgram fetches and compiles a unit type's COB, returning nil (a
// script-less unit) when there is none, when it does not parse, or when
// reading or compiling it panics — a malformed mod script must cost that
// unit its animation, not take down the match.
func loadProgram(name string, cob CobSource) (prog *script.Program) {
	if cob == nil {
		return nil
	}
	defer func() {
		if r := recover(); r != nil {
			logMatchPanic("gameserver: scripts/%s.cob: unit runs without its script after a panic: %v", name, r)
			prog = nil
		}
	}()
	b, _ := cob(name)
	return compileCOB(b)
}

// spawnMeta resolves a unit type's metadata, returning nil (the unit is not
// spawned) when resolving it panics on a malformed unit definition.
func spawnMeta(spawn sim.SpawnFunc, name string) (meta *sim.UnitMeta) {
	defer func() {
		if r := recover(); r != nil {
			logMatchPanic("gameserver: unit %s: not spawned after a panic loading its definition: %v", name, r)
			meta = nil
		}
	}()
	meta, _ = spawn(name)
	return meta
}

// compileCOB disassembles raw COB bytes into a shared program, returning nil
// when the bytes are absent or unparseable so the unit degrades to script-less.
// Mirrors the wasm bridge so server and client compile the identical program.
func compileCOB(b []byte) *script.Program {
	if len(b) == 0 {
		return nil
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(b))
	if err != nil {
		return nil
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		return nil
	}
	return prog
}

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
	// rt is the per-match script runtime. The match holds a reference so a join
	// snapshot can capture the runtime's RNG draw position alongside each unit's
	// COB state, letting a late joiner resume script randomness in lockstep.
	rt *script.Runtime

	// Descriptive metadata for session listings. name and kind are set once,
	// before Run starts, so they are safe to read from other goroutines;
	// players and units are updated inside Run and read atomically.
	name      string
	kind      string
	mapPath   string
	createdAt time.Time
	players   atomic.Int64
	units     atomic.Int64

	// emptySince is the unix-nano timestamp at which the match last held zero
	// connected clients, or 0 while occupied. The server's reaper reads it to
	// retire matches that have sat empty past the idle grace. It is written on
	// the authority goroutine (and at creation, while still single-threaded)
	// and read by the reaper, so it crosses goroutines through an atomic.
	emptySince atomic.Int64

	register   chan *client
	unregister chan *client
	orders     chan clientOrder
	control    chan wire.Control
	// resync carries a Force-Sync request from a client's read loop to the
	// authority goroutine, which alone may read session state to build the full
	// snapshot the client re-seeds from.
	resync chan *client
	// diagnose carries a read-only drift-inspection request. Like resync it is
	// serviced on the authority goroutine, but the client does not re-seed from
	// the reply — the snapshot is flagged Diagnostic for the diff UI.
	diagnose chan *client
	quit     chan struct{}
	stopOnce sync.Once

	clients  map[*client]struct{}
	nextSlot int

	// Sandbox runtime-clock state, owned by the authority goroutine. paused
	// freezes the tick advance; rate is the wall-clock pacing multiplier the
	// ticker interval is derived from. Both are broadcast to clients so every
	// window's local prediction paces to the same clock.
	paused bool
	rate   float64
}

// SessionInfo is a thread-safe snapshot of a match's descriptive state, used by
// the host's session-listing endpoint.
type SessionInfo struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Kind      string    `json:"kind"`
	Map       string    `json:"map,omitempty"`
	Players   int       `json:"players"`
	Units     int       `json:"units"`
	CreatedAt time.Time `json:"createdAt"`
}

// SetInfo records descriptive metadata for listings. It must be called before
// Run starts, while the match is still single-threaded.
func (m *Match) SetInfo(name, kind string) {
	m.name = name
	m.kind = kind
}

// SetMap records the battlefield a match was created with so the session
// listing can echo it to joiners (who load the same height field for their
// local prediction). It must be called before Run starts.
func (m *Match) SetMap(mapPath string) { m.mapPath = mapPath }

// SetTerrain installs the authority world's height field. A nil terrain (an
// unreadable map) leaves the match on the flat grid. It must be called before
// Run starts, while the match is still single-threaded.
func (m *Match) SetTerrain(t *sim.Terrain) {
	if t == nil {
		return
	}
	m.session.World().SetTerrain(t)
}

// info returns a thread-safe snapshot of the match's listing state.
func (m *Match) info() SessionInfo {
	return SessionInfo{
		ID:        m.id,
		Name:      m.name,
		Kind:      m.kind,
		Map:       m.mapPath,
		Players:   int(m.players.Load()),
		Units:     int(m.units.Load()),
		CreatedAt: m.createdAt,
	}
}

type clientOrder struct {
	from *client
	ord  wire.ClientMsg
}

// NewMatch creates a match with a fresh world and the given spawn provider. The
// cob source (optional) backs each spawned unit with its COB script, run by a
// per-match script runtime so the authority animates and fights identically to
// the clients; pass nil for a script-less authority.
func NewMatch(id string, seed uint32, inputDelay uint64, spawn sim.SpawnFunc, cob CobSource) *Match {
	// A per-match runtime drives every unit's COB in lockstep. It is seeded with
	// the match seed (shared with the world and every client via join_accept) so
	// any script RNG draw lands identically on the authority and the clients.
	rt := script.NewRuntime(seed)
	// program cache: a type's bytecode is disassembled at most once; a miss is
	// cached as nil so a script-less type is probed once. Touched only on the
	// authority goroutine (spawn resolves during session.Step / Restore).
	programs := map[string]*script.Program{}
	bound := func(name string) (*sim.UnitMeta, sim.Binding) {
		meta := spawnMeta(spawn, name)
		if meta == nil {
			return nil, nil
		}
		prog, ok := programs[name]
		if !ok {
			prog = loadProgram(name, cob)
			programs[name] = prog
		}
		if prog == nil {
			return meta, nil
		}
		return meta, rt.NewUnit(prog, nil)
	}
	// The world shares the runtime's MINSTD stream so COB RAND and world-side
	// draws consume one generator in call order — the engines' single-stream
	// discipline (and one snapshot word covers both on resync).
	w := sim.New(sim.Config{Seed: seed, Spawn: bound, Rand: rt.Rand()})
	now := time.Now()
	m := &Match{
		id:         id,
		seed:       seed,
		inputDelay: inputDelay,
		createdAt:  now,
		rt:         rt,
		session:    session.New(session.Config{World: w, Runtime: rt, InputDelay: inputDelay}),
		register:   make(chan *client),
		unregister: make(chan *client),
		orders:     make(chan clientOrder, 1024),
		control:    make(chan wire.Control, 16),
		resync:     make(chan *client, 16),
		diagnose:   make(chan *client, 16),
		quit:       make(chan struct{}),
		clients:    make(map[*client]struct{}),
		rate:       1,
	}
	// A match is born empty; mark it idle from creation so one that is created
	// (e.g. by an HTTP upgrade) but never actually joined is still reaped.
	m.emptySince.Store(now.UnixNano())
	return m
}

// Run drives the authority loop until Stop. It must run on its own goroutine;
// it is the sole owner of the session, so no locking is needed. A panic in the
// loop ends this match (see recoverRun), not the process hosting it.
func (m *Match) Run() {
	defer m.recoverRun()
	ticker := time.NewTicker(m.tickInterval())
	defer func() { ticker.Stop() }()
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
		case ctl := <-m.control:
			if m.onControl(ctl) {
				// A rate change resizes the wall-clock tick interval; swap the
				// ticker so the new pace takes effect immediately.
				ticker.Stop()
				ticker = time.NewTicker(m.tickInterval())
			}
		case c := <-m.resync:
			m.onResync(c)
		case c := <-m.diagnose:
			m.onDiagnose(c)
		case <-ticker.C:
			if !m.paused {
				m.step()
			}
		}
	}
}

// tickInterval is the wall-clock period between authoritative ticks at the
// current pacing rate. The per-tick simulation step is always one fixed tick
// of game time; rate only changes how often it fires in real time.
func (m *Match) tickInterval() time.Duration {
	rate := m.rate
	if rate <= 0 {
		rate = 1
	}
	d := time.Duration(float64(sim.TickDuration) / rate)
	if d < time.Millisecond {
		d = time.Millisecond
	}
	return d
}

// onControl applies a client's runtime command to the shared clock and
// broadcasts the resulting state to every client. It returns true when the
// ticker must be resized (a rate change).
func (m *Match) onControl(ctl wire.Control) (resized bool) {
	switch ctl.Action {
	case "pause":
		m.paused = true
	case "resume":
		m.paused = false
	case "step":
		// A single-step is only meaningful while paused; advance exactly one
		// authoritative tick so every client steps with the server.
		if m.paused {
			m.step()
		}
	case "rate":
		r := ctl.Rate
		if r < 0.01 {
			r = 0.01
		} else if r > 10 {
			r = 10
		}
		m.rate = r
		resized = true
	default:
		return false
	}
	m.broadcastControl()
	return resized
}

// broadcastControl tells every client the current shared-clock state so their
// local prediction paces, pauses and steps in lockstep with the authority.
func (m *Match) broadcastControl() {
	m.broadcast(wire.ServerMsg{Type: wire.MsgControl, Control: &wire.Control{
		Paused: m.paused,
		Rate:   m.rate,
		Tick:   m.session.World().Tick(),
	}})
}

// Stop ends the match loop. It is safe to call more than once: the server's
// reaper and an explicit Server.Stop can both target the same match.
func (m *Match) Stop() { m.stopOnce.Do(func() { close(m.quit) }) }

// recoverRun ends a match whose authority loop panicked. Its state may be
// half-updated, so it is not resumed: the panic is logged, the match stops
// (each client's connection closes), and it is marked idle so the reaper
// removes it and the next connection to its id starts a fresh match.
func (m *Match) recoverRun() {
	r := recover()
	if r == nil {
		return
	}
	logMatchPanic("gameserver: match %s stopped after a panic: %v\n%s", m.id, r, debug.Stack())
	m.Stop()
	m.emptySince.Store(1)
}

// post hands v to the authority goroutine on ch, and reports false instead of
// blocking once the match has stopped.
func post[T any](m *Match, ch chan<- T, v T) bool {
	select {
	case ch <- v:
		return true
	case <-m.quit:
		return false
	}
}

func (m *Match) onJoin(c *client) {
	c.slot = m.nextSlot
	m.nextSlot++
	m.clients[c] = struct{}{}
	m.players.Store(int64(len(m.clients)))
	m.emptySince.Store(0)
	go c.writePump(m.quit)
	c.send(wire.ServerMsg{Type: wire.MsgJoinAccept, JoinAccept: &wire.JoinAccept{
		PlayerSlot: c.slot,
		TickRate:   sim.TickHz,
		InputDelay: int(m.inputDelay),
		Seed:       m.seed,
		Tick:       m.session.World().Tick(),
	}})
	// Full state so a late joiner can initialize its local engine, including the
	// live COB VM state so its piece poses match the authority exactly.
	c.send(wire.ServerMsg{Type: wire.MsgSnapshot, Snapshot: m.buildSnapshot(true)})
	// Replay command frames already scheduled for future ticks so the new
	// client does not miss orders issued before it connected.
	for _, t := range m.session.PendingTicks() {
		c.send(wire.ServerMsg{Type: wire.MsgCommand, Command: &wire.CommandFrame{
			Tick:   t,
			Orders: m.session.OrdersForTick(t),
		}})
	}
	// Seed the joiner with the current clock state so a window opened into a
	// paused or slowed sandbox starts out paused / slowed instead of free-running.
	c.send(wire.ServerMsg{Type: wire.MsgControl, Control: &wire.Control{
		Paused: m.paused,
		Rate:   m.rate,
		Tick:   m.session.World().Tick(),
	}})
}

// onResync re-pushes a full authoritative snapshot to one client on demand
// (the sandbox Force-Sync button). The client discards its locally diverged
// state and re-seeds from this payload, exactly as it does on first join.
func (m *Match) onResync(c *client) {
	if _, ok := m.clients[c]; !ok {
		return
	}
	c.send(wire.ServerMsg{Type: wire.MsgSnapshot, Snapshot: m.buildSnapshot(true)})
	// Re-deliver any still-scheduled command frames so the re-seeded client
	// keeps the orders that were queued ahead of the current tick.
	for _, t := range m.session.PendingTicks() {
		c.send(wire.ServerMsg{Type: wire.MsgCommand, Command: &wire.CommandFrame{
			Tick:   t,
			Orders: m.session.OrdersForTick(t),
		}})
	}
}

// onDiagnose pushes a full authoritative snapshot to one client for read-only
// drift inspection (the Network panel's Diagnose button). It is flagged
// Diagnostic so the client routes it to the diff UI rather than re-seeding its
// engine, and unlike onResync it does NOT replay pending command frames — the
// client's prediction is left untouched.
func (m *Match) onDiagnose(c *client) {
	if _, ok := m.clients[c]; !ok {
		return
	}
	snap := m.buildSnapshot(false)
	snap.Diagnostic = true
	c.send(wire.ServerMsg{Type: wire.MsgSnapshot, Snapshot: snap})
}

func (m *Match) onLeave(c *client) {
	if _, ok := m.clients[c]; ok {
		delete(m.clients, c)
		m.players.Store(int64(len(m.clients)))
		if len(m.clients) == 0 {
			m.emptySince.Store(time.Now().UnixNano())
		}
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
	m.units.Store(int64(m.session.World().UnitCount()))
	tick := m.session.World().Tick()
	if tick%hashEvery == 0 {
		m.broadcast(wire.ServerMsg{Type: wire.MsgHash, Hash: &wire.HashMsg{
			Tick: tick, Hash: m.session.World().Hash(),
		}})
	}
	if tick%snapshotEvery == 0 {
		// The periodic backstop omits COB VM state: it is a desync digest, not a
		// join, and shipping every unit's threads + animators every 200 ticks to
		// every client would spike bandwidth for no gain (clients do not re-apply it).
		m.broadcast(wire.ServerMsg{Type: wire.MsgSnapshot, Snapshot: m.buildSnapshot(false)})
	}
}

// buildSnapshot assembles an authoritative state snapshot. When full is true it
// also carries each unit's live COB VM state and the script runtime's RNG draw
// position, the pixel-perfect resync payload a late joiner adopts; periodic
// backstop snapshots pass false to keep the wire small.
func (m *Match) buildSnapshot(full bool) *wire.Snapshot {
	w := m.session.World()
	snap := &wire.Snapshot{Tick: w.Tick(), Hash: w.Hash()}
	if full && m.rt != nil {
		snap.RuntimeRng = m.rt.SnapshotRng()
	}
	for _, ru := range w.ExportUnits() {
		us := wire.UnitSnap{
			ID: ru.ID, Name: ru.Name, Side: ru.Side,
			X: ru.Pos.X, Y: ru.Pos.Y, Z: ru.Pos.Z,
			Heading: ru.Heading, Speed: ru.Speed,
			HasMove: ru.HasMove, TX: ru.MoveTarget.X, TZ: ru.MoveTarget.Z,
			Health: ru.Health, Dead: ru.Dead,
			HasAttack: ru.HasAttack, AttackTarget: ru.AttackTarget,
			BuildPercent: ru.BuildPercent, BuildState: ru.BuildState,
			BuildName: ru.BuildName, BuildSiteX: ru.BuildSite.X, BuildSiteZ: ru.BuildSite.Z,
			BuildTargetID: ru.BuildTargetID, BuildGateMs: ru.BuildGateMs, ProdQueue: ru.ProdQueue,
			MoveMode: ru.MoveMode, FireMode: ru.FireMode,
			HomeX: ru.HomePos.X, HomeZ: ru.HomePos.Z,
			AutoEngaged: ru.AutoEngaged, CurIsPatrol: ru.CurIsPatrol,
			SelfDAtMs: ru.SelfDAtMs,
			CarriedBy: ru.CarriedBy, Carrying: ru.Carrying,
			LoadTarget: ru.LoadTarget, HasUnload: ru.HasUnload,
			StallTicks: ru.StallTicks, AvoidFlip: ru.AvoidFlip,
			ProgressX: ru.ProgressX, ProgressZ: ru.ProgressZ,
			UnloadX: ru.UnloadAt.X, UnloadZ: ru.UnloadAt.Z,
		}
		if full {
			us.Cob = ru.Cob
		}
		for _, q := range ru.Queue {
			us.Queue = append(us.Queue, wire.QueuedSnap{Kind: q.Kind, TX: q.Target.X, TZ: q.Target.Z, TargetUnit: q.TargetUnit, Name: q.Name})
		}
		for i := range ru.Weapons {
			rw := ru.Weapons[i]
			us.Weapons[i] = wire.WeaponSnap{
				HasTarget:  rw.HasTarget,
				TargetUnit: rw.TargetUnit,
				PX:         rw.TargetPt.X,
				PY:         rw.TargetPt.Y,
				PZ:         rw.TargetPt.Z,
				Source:     rw.Source,
				LastFireMs: rw.LastFireMs,
			}
		}
		snap.Units = append(snap.Units, us)
	}
	for _, rp := range w.ExportProjectiles() {
		snap.Projectiles = append(snap.Projectiles, wire.ProjectileSnap{
			ID: rp.ID, OwnerID: rp.OwnerID, TargetID: rp.TargetID, Slot: rp.Slot,
			Mode: rp.Mode, Phase: rp.Phase, Model: rp.Model, Weapon: rp.Weapon,
			X: rp.Pos.X, Y: rp.Pos.Y, Z: rp.Pos.Z,
			VX: rp.Vel.X, VY: rp.Vel.Y, VZ: rp.Vel.Z,
			OX: rp.Origin.X, OY: rp.Origin.Y, OZ: rp.Origin.Z,
			TX: rp.Target.X, TY: rp.Target.Y, TZ: rp.Target.Z,
			LaunchY: rp.LaunchY, Speed: rp.Speed, VMax: rp.VMax, Accel: rp.Accel,
			TurnAng: rp.TurnAng, HomingR: rp.HomingR, Gravity: rp.Gravity,
			AoE: rp.AoE, Damage: rp.Damage, AgeSec: rp.AgeSec, LifeSec: rp.LifeSec,
			LastDist: rp.LastDist, Closing: rp.Closing, Heading: rp.Heading, Pitch: rp.Pitch,
			FromPiece: rp.FromPiece,
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
				post(m, m.unregister, c)
			}
			return
		}
		// Every hand-off to the authority goroutine gives up once the match
		// has stopped, so the read loop ends instead of blocking forever.
		switch msg.Type {
		case wire.MsgJoin:
			if !registered {
				if !post(m, m.register, c) {
					return
				}
				registered = true
			}
		case wire.MsgOrder:
			if registered && !post(m, m.orders, clientOrder{from: c, ord: msg}) {
				return
			}
		case wire.MsgControl:
			if registered && msg.Control != nil && !post(m, m.control, *msg.Control) {
				return
			}
		case wire.MsgLeave:
			// Voluntary departure: free the slot and end the read loop so the
			// match can be reaped without waiting on a transport timeout.
			if registered {
				post(m, m.unregister, c)
			}
			return
		case wire.MsgPing:
			// Latency probe: answer straight off the read loop with the echoed
			// sequence and our wall clock. Bypassing the authority goroutine keeps
			// RTT a measure of the transport, not of tick scheduling jitter.
			if registered {
				seq := uint64(0)
				if msg.Ping != nil {
					seq = msg.Ping.Seq
				}
				c.send(wire.ServerMsg{Type: wire.MsgPong, Pong: &wire.Pong{
					Seq:        seq,
					ServerTime: time.Now().UnixMilli(),
				}})
			}
		case wire.MsgResync:
			// Force Sync: route to the authority goroutine, the sole reader of
			// session state, to build and push a fresh full snapshot.
			if registered && !post(m, m.resync, c) {
				return
			}
		case wire.MsgDiagnose:
			// Diagnose: route to the authority goroutine for a read-only full
			// snapshot the client diffs against its predicted state. No re-seed.
			if registered && !post(m, m.diagnose, c) {
				return
			}
		case wire.MsgAck:
			// flow control hook; no-op for now.
		}
	}
}

// writePump sends the client's queued messages until the match drops the
// client (closing out) or stops, then closes the connection.
func (c *client) writePump(quit <-chan struct{}) {
	defer func() { _ = c.conn.Close() }()
	for {
		select {
		case msg, ok := <-c.out:
			if !ok {
				return
			}
			if err := c.conn.Send(msg); err != nil {
				return
			}
		case <-quit:
			return
		}
	}
}

// send queues a message for the client, dropping it if the buffer is full so a
// slow client never stalls the authority loop.
func (c *client) send(msg wire.ServerMsg) {
	select {
	case c.out <- msg:
	default:
	}
}
