// Package session is the transport-agnostic driver that wraps a simulation
// world and turns submitted orders into stepped ticks and render snapshots. It
// is the single piece both deployment targets share: the native server runs a
// Session as the authority and ships its command stream over a websocket; the
// wasm client runs the same Session locally for offline play and for predicting
// ahead of the server. Because the Session has no I/O of its own, the two
// builds differ only in the thin transport wrappers that feed and drain it.
package session

import (
	"sort"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/sim"
)

// Config configures a Session.
type Config struct {
	World *sim.World
	// Runtime is the optional COB script VM advanced each tick.
	Runtime sim.Runtime
	// InputDelay is how many ticks ahead a Submit()ed order is scheduled, the
	// window that hides network latency. Zero is correct for single-player
	// offline play.
	InputDelay uint64
}

// FrameSink receives the render snapshot produced after each stepped tick.
type FrameSink func(frame.Snapshot)

// Session advances a world deterministically and delivers snapshots.
type Session struct {
	world      *sim.World
	rt         sim.Runtime
	inputDelay uint64
	pending    map[uint64][]order.Order
	sink       FrameSink
}

// New builds a Session around an already-constructed world.
func New(cfg Config) *Session {
	return &Session{
		world:      cfg.World,
		rt:         cfg.Runtime,
		inputDelay: cfg.InputDelay,
		pending:    make(map[uint64][]order.Order),
	}
}

// World exposes the underlying world for snapshotting and inspection.
func (s *Session) World() *sim.World { return s.world }

// SetFrameSink installs the callback invoked with each tick's snapshot.
func (s *Session) SetFrameSink(sink FrameSink) { s.sink = sink }

// Submit schedules a local order for execution InputDelay ticks in the future.
// Offline this is effectively "next tick"; in multiplayer the authoritative
// server reassigns the execution tick before broadcasting.
func (s *Session) Submit(o order.Order) uint64 {
	exec := s.world.Tick() + s.inputDelay + 1
	s.ScheduleAt(exec, o)
	return exec
}

// ScheduleAt queues an order to execute exactly at the given tick. The server
// uses this when it assigns execution ticks; clients use it when they receive a
// command frame. Orders within a tick keep submission order.
func (s *Session) ScheduleAt(tick uint64, o order.Order) {
	s.pending[tick] = append(s.pending[tick], o)
}

// Step advances the simulation by exactly one tick: it applies every order
// scheduled for the upcoming tick (in submission order), steps the world, and
// delivers the resulting snapshot. It returns the snapshot for callers that
// prefer a pull model over the sink.
func (s *Session) Step() frame.Snapshot {
	next := s.world.Tick() + 1
	if orders, ok := s.pending[next]; ok {
		for _, o := range orders {
			s.world.ApplyOrder(o)
		}
		delete(s.pending, next)
	}
	s.world.Step(s.rt)
	snap := s.world.Snapshot()
	if s.sink != nil {
		s.sink(snap)
	}
	return snap
}

// StepTo advances the simulation tick by tick until the world reaches the
// target tick, returning the last stepped snapshot. This is the replay driver's
// clock: seek by restoring a keyframe then StepTo the wanted tick. The call is
// guarded against going backwards — a target at or before the current tick
// steps nothing and returns the world's current-state snapshot unchanged
// (rewind is a Restore, never a negative step).
func (s *Session) StepTo(target uint64) frame.Snapshot {
	if target <= s.world.Tick() {
		return s.world.Snapshot()
	}
	var snap frame.Snapshot
	for s.world.Tick() < target {
		snap = s.Step()
	}
	return snap
}

// SetUnitState authoritatively overwrites one live unit's pose/state — the
// per-tick hook a replay driver uses to pin units to decoded wire truth. The
// unit must already exist; a missing id returns false. See
// sim.UnitStateOverride for the field contract.
func (s *Session) SetUnitState(id uint32, ov sim.UnitStateOverride) bool {
	return s.world.SetUnitState(id, ov)
}

// PlayWeaponFire plays a unit's aim + fire scripts for a wire-reported shot —
// the replay driver's WeaponFire hook. Presentation only: no projectile, no
// damage. See sim.World.UnitPlayWeaponFire.
func (s *Session) PlayWeaponFire(id uint32, slot int, target fixed.Vec3) bool {
	return s.world.UnitPlayWeaponFire(id, slot, target)
}

// Restore reinitializes the world from an authoritative snapshot and discards
// any locally scheduled orders, so a late-joining client resyncs to the
// server's current tick before applying the command frames that follow. The
// in-flight projectiles are restored alongside the units so the joiner's sky
// matches the authority's and any shot still en route lands identically.
func (s *Session) Restore(tick uint64, units []sim.RestoredUnit, projectiles []sim.RestoredProjectile) {
	s.pending = make(map[uint64][]order.Order)
	s.world.Restore(tick, units, projectiles)
}

// PendingTicks returns the sorted ticks that have scheduled orders, used by the
// server to assemble command frames.
func (s *Session) PendingTicks() []uint64 {
	ticks := make([]uint64, 0, len(s.pending))
	for t := range s.pending {
		ticks = append(ticks, t)
	}
	sort.Slice(ticks, func(i, j int) bool { return ticks[i] < ticks[j] })
	return ticks
}

// OrdersForTick returns the orders scheduled for a given tick, for command
// frame assembly.
func (s *Session) OrdersForTick(tick uint64) []order.Order { return s.pending[tick] }
