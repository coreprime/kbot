package session

// Replay-driver properties: StepTo as the seek clock, snapshot round-trips as
// the keyframe mechanism, and SetUnitState as the per-tick wire-truth pin.
// These are the guarantees the replayer's presentation sim rests on.

import (
	"reflect"
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/sim"
)

// replayGoldenHash is the world hash a fixed seed + fixed order script must
// reach at tick 150 on every architecture and on every run. The engine is
// integer-only (Q16.16 fixed point), so this value is a cross-platform
// constant; a change means the simulation's evolution changed and every
// recorded replay's render would silently shift.
const replayGoldenHash uint64 = 2961949521211098164

func replaySpawn(name string) (*sim.UnitMeta, sim.Binding) {
	if name != "u" {
		return nil, nil
	}
	return meta(), nil
}

// newReplaySession builds the fixed scenario the golden hash is pinned to: two
// units and a small order script scheduled at exact ticks, the same way a
// replay driver feeds a decoded command stream.
func newReplaySession() (*Session, uint32) {
	w := sim.New(sim.Config{Seed: 11, Spawn: replaySpawn})
	id := w.AddUnit("u", meta(), nil, fixed.Vec2{X: fixed.FromInt(100), Z: fixed.FromInt(100)}, 0, 0)
	w.AddUnit("u", meta(), nil, fixed.Vec2{X: fixed.FromInt(400), Z: fixed.FromInt(300)}, 0, 1)
	s := New(Config{World: w})
	s.ScheduleAt(5, order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(350), Z: fixed.FromInt(250)}))
	s.ScheduleAt(60, order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(120), Z: fixed.FromInt(320)}))
	s.ScheduleAt(110, order.Stop([]uint32{id}))
	return s, id
}

// TestStepToDeterministic (V2.1): for a fixed order script, StepTo(K) lands on
// the identical snapshot and world hash on every run — the property that makes
// a replay render reproducible.
func TestStepToDeterministic(t *testing.T) {
	const K = 150
	ref, _ := newReplaySession()
	refSnap := ref.StepTo(K)
	if refSnap.Tick != K {
		t.Fatalf("StepTo(%d) returned snapshot at tick %d", K, refSnap.Tick)
	}
	if got := ref.World().Hash(); got != replayGoldenHash {
		t.Fatalf("golden hash mismatch at tick %d: got %d, want %d", K, got, replayGoldenHash)
	}
	for run := 0; run < 100; run++ {
		s, _ := newReplaySession()
		snap := s.StepTo(K)
		if got := s.World().Hash(); got != replayGoldenHash {
			t.Fatalf("run %d: hash %d != golden %d", run, got, replayGoldenHash)
		}
		if !reflect.DeepEqual(snap, refSnap) {
			t.Fatalf("run %d: snapshot differs from reference", run)
		}
	}
}

// TestStepToNeverRewinds: a target at or before the current tick steps nothing
// and reports the world's current state — rewind is Restore's job.
func TestStepToNeverRewinds(t *testing.T) {
	s, _ := newReplaySession()
	s.StepTo(40)
	before := s.World().Hash()
	for _, target := range []uint64{0, 39, 40} {
		snap := s.StepTo(target)
		if snap.Tick != 40 {
			t.Fatalf("StepTo(%d) after tick 40 returned tick %d", target, snap.Tick)
		}
		if got := s.World().Hash(); got != before {
			t.Fatalf("StepTo(%d) mutated the world: hash %d != %d", target, got, before)
		}
	}
}

// TestSnapshotRoundTripSeek (V2.2): create → run to K → keyframe → run further
// → restore(K) → StepTo(K+M) matches the uninterrupted run to K+M. This is the
// seek-correctness foundation: a rewind is a keyframe restore plus a forward
// StepTo, and it must land bit-identical to never having seeked at all.
func TestSnapshotRoundTripSeek(t *testing.T) {
	const (
		K = 80
		M = 70
	)
	// Reference: an uninterrupted run to K+M.
	ref, refID := newReplaySession()
	refSnap := ref.StepTo(K + M)
	refHash := ref.World().Hash()

	// Seeking session: same script, keyframe at K, overshoot, then seek back.
	s, id := newReplaySession()
	if id != refID {
		t.Fatal("setup mismatch")
	}
	s.StepTo(K)
	units := s.World().ExportUnits()
	projectiles := s.World().ExportProjectiles()
	s.StepTo(K + M + 45) // run past the seek target so the restore really rewinds

	s.Restore(K, units, projectiles)
	if got := s.World().Tick(); got != K {
		t.Fatalf("restored tick = %d, want %d", got, K)
	}
	// Restore drops scheduled orders, so the driver re-feeds the command
	// stream past the keyframe — here the one order that executes after K.
	s.ScheduleAt(110, order.Stop([]uint32{id}))

	snap := s.StepTo(K + M)
	if got := s.World().Hash(); got != refHash {
		t.Fatalf("seeked hash %d != uninterrupted hash %d", got, refHash)
	}
	if !reflect.DeepEqual(snap, refSnap) {
		t.Fatal("seeked snapshot differs from the uninterrupted run")
	}
}

// TestSetUnitState (V2.3): an authoritative override lands exactly in the next
// snapshot, and a subsequent order-free StepTo keeps the unit within vel·dt of
// the injected pose — the sim coasts from wire truth instead of fighting it.
func TestSetUnitState(t *testing.T) {
	w := sim.New(sim.Config{Seed: 3, Spawn: replaySpawn})
	id := w.AddUnit("u", meta(), nil, fixed.Vec2{X: fixed.FromInt(50), Z: fixed.FromInt(50)}, 0, 0)
	s := New(Config{World: w})
	s.StepTo(10)

	ov := sim.UnitStateOverride{
		HasPos:          true,
		Pos:             fixed.Vec3{X: fixed.FromFloat(210.5), Y: fixed.FromInt(12), Z: fixed.FromFloat(305.25)},
		HasHeading:      true,
		Heading:         fixed.FromInt(12345),
		HasSpeed:        true,
		Speed:           fixed.FromFloat(1.25),
		HasHealth:       true,
		Health:          fixed.FromFloat(37.5),
		HasBuildPercent: true,
		BuildPercent:    fixed.FromInt(100),
	}
	if !s.SetUnitState(id, ov) {
		t.Fatal("SetUnitState reported failure for a live unit")
	}
	if s.SetUnitState(9999, ov) {
		t.Fatal("SetUnitState reported success for a missing unit")
	}

	// The un-stepped snapshot reflects the injected state exactly.
	snap := s.World().Snapshot()
	found := false
	for i := range snap.Units {
		u := &snap.Units[i]
		if u.ID != id {
			continue
		}
		found = true
		if u.Pos != ov.Pos {
			t.Fatalf("pos = %+v, want %+v", u.Pos, ov.Pos)
		}
		if u.Heading != 12345 {
			t.Fatalf("heading = %d, want 12345", u.Heading)
		}
		if u.Speed != ov.Speed {
			t.Fatalf("speed = %v, want %v", u.Speed, ov.Speed)
		}
		if u.Health != ov.Health {
			t.Fatalf("health = %v, want %v", u.Health, ov.Health)
		}
		if u.BuildPercent != ov.BuildPercent {
			t.Fatalf("buildPercent = %v, want %v", u.BuildPercent, ov.BuildPercent)
		}
	}
	if !found {
		t.Fatal("overridden unit missing from snapshot")
	}

	// With no orders, N further ticks can displace the unit by at most
	// speed · dt per tick (braking only shrinks that bound).
	const n = 20
	s.StepTo(s.World().Tick() + n)
	u := s.World().UnitByID(id)
	pos := u.Pos()
	maxDrift := ov.Speed.Div(fixed.FromInt(sim.TickHz)).Mul(fixed.FromInt(n))
	dx, dz := pos.X-ov.Pos.X, pos.Z-ov.Pos.Z
	if dx < 0 {
		dx = -dx
	}
	if dz < 0 {
		dz = -dz
	}
	if dx > maxDrift || dz > maxDrift {
		t.Fatalf("unit drifted (%v, %v) from the injected pose; bound %v", dx, dz, maxDrift)
	}
}
