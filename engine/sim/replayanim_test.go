package sim

// Replay-animation hooks: the motion pin (UnitStateOverride.Moving) that
// drives StartMoving/StopMoving from wire truth, its survival across a
// keyframe export/restore, and UnitPlayWeaponFire — the WeaponFire event's
// aim/fire playback. These are the guarantees the replayer's COB animation
// rests on.

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
)

// pinMoving builds the override a replay driver sends for a unit the wire
// reports in motion: pinned moving at speed wu/s along the current heading.
func pinMoving(speed float64) UnitStateOverride {
	return UnitStateOverride{
		HasMoving: true,
		Moving:    true,
		HasSpeed:  true,
		Speed:     fixed.FromFloat(speed),
	}
}

// TestMotionPinDrivesWalkScripts is the core walk-cycle contract: a pinned-
// moving unit fires StartMoving exactly once (not every tick), keeps
// IsMoving latched with no order, coasts along its heading at the injected
// speed, and fires StopMoving exactly once when the pin flips off.
func TestMotionPinDrivesWalkScripts(t *testing.T) {
	w := New(Config{Seed: 3})
	bind := &recordingBinding{scripts: map[string]bool{"StartMoving": true, "StopMoving": true}}
	id := w.AddUnit("walker", testMeta("walker"), bind, fixed.Vec2{X: fixed.FromInt(50), Z: fixed.FromInt(50)}, 0, 0)
	u := w.UnitByID(id)

	// Idle steps: no pin, no orders — the walk scripts must stay silent.
	for i := 0; i < 5; i++ {
		w.Step(nil)
	}
	if n := countCalls(bind.starts, "StartMoving"); n != 0 {
		t.Fatalf("StartMoving fired %d times with no motion", n)
	}

	const speed = 1.25
	if !w.SetUnitState(id, pinMoving(speed)) {
		t.Fatal("SetUnitState failed for a live unit")
	}
	before := u.Pos()
	const n = 8
	for i := 0; i < n; i++ {
		w.Step(nil)
	}
	if got := countCalls(bind.starts, "StartMoving"); got != 1 {
		t.Fatalf("StartMoving fired %d times, want exactly 1", got)
	}
	if !u.IsMoving {
		t.Fatal("pinned-moving unit reads idle")
	}
	// Coast: heading 0 = +Z, so Z advances by speed·dt per tick and X holds.
	wantZ := before.Z + fixed.FromFloat(speed).Mul(dtSec).Mul(fixed.FromInt(n))
	after := u.Pos()
	if after.Z != wantZ {
		t.Fatalf("coast Z = %v, want %v", after.Z.Float(), wantZ.Float())
	}
	if after.X != before.X {
		t.Fatalf("coast drifted in X: %v -> %v", before.X.Float(), after.X.Float())
	}

	// Flip the pin off: StopMoving once, speed wound down, still no repeats.
	if !w.SetUnitState(id, UnitStateOverride{HasMoving: true}) {
		t.Fatal("SetUnitState(stop) failed")
	}
	for i := 0; i < 5; i++ {
		w.Step(nil)
	}
	if got := countCalls(bind.starts, "StopMoving"); got != 1 {
		t.Fatalf("StopMoving fired %d times, want exactly 1", got)
	}
	if got := countCalls(bind.starts, "StartMoving"); got != 1 {
		t.Fatalf("StartMoving refired after the stop (%d total)", got)
	}
	if u.IsMoving || u.loco.Speed != 0 {
		t.Fatalf("pinned-stopped unit still moving (IsMoving=%v speed=%v)", u.IsMoving, u.loco.Speed.Float())
	}
}

// TestMotionPinSurvivesRestore: a keyframe export carries the pin, and the
// restore re-arms the walk cycle (StartMoving on the fresh binding) so a
// seek does not freeze mid-walk units into their rest pose.
func TestMotionPinSurvivesRestore(t *testing.T) {
	w := New(Config{Seed: 4})
	bind := &recordingBinding{scripts: map[string]bool{"StartMoving": true, "StopMoving": true}}
	id := w.AddUnit("walker", testMeta("walker"), bind, fixed.Vec2{X: fixed.FromInt(10), Z: fixed.FromInt(10)}, 0, 0)
	w.SetUnitState(id, pinMoving(1))
	for i := 0; i < 4; i++ {
		w.Step(nil)
	}

	units := w.ExportUnits()
	if len(units) != 1 || units[0].MotionPin != motionPinMoving {
		t.Fatalf("export lost the motion pin: %+v", units[0].MotionPin)
	}

	// Restore into a fresh world whose spawn hands out a fresh binding, the
	// way the wasm bridge re-resolves bindings through its unit resolver.
	fresh := &recordingBinding{scripts: map[string]bool{"StartMoving": true, "StopMoving": true}}
	w2 := New(Config{Seed: 4, Spawn: func(name string) (*UnitMeta, Binding) {
		return testMeta(name), fresh
	}})
	w2.Restore(w.Tick(), units, nil)
	u2 := w2.UnitByID(id)
	if u2 == nil || u2.motionPin != motionPinMoving || !u2.IsMoving {
		t.Fatalf("restore lost the pin (unit=%v)", u2)
	}
	if got := countCalls(fresh.starts, "StartMoving"); got != 1 {
		t.Fatalf("restore re-armed StartMoving %d times, want 1", got)
	}
	// The pin keeps driving after the restore without a fresh override.
	w2.Step(nil)
	if !u2.IsMoving {
		t.Fatal("restored pin did not keep the unit moving")
	}
}

// TestUnitPlayWeaponFire: the replay WeaponFire hook re-drives the slot's aim
// script at the target bearing and starts the fire script, resolving the
// weapon-script convention from the COB exactly as live combat does.
func TestUnitPlayWeaponFire(t *testing.T) {
	w := New(Config{Seed: 5})
	bind := &recordingBinding{scripts: map[string]bool{"AimPrimary": true, "FirePrimary": true}}
	id := w.AddUnit("gunner", testMeta("gunner"), bind, fixed.Vec2{}, 0, 0)

	target := fixed.Vec3{X: fixed.FromInt(120), Y: 0, Z: 0} // due +X
	if !w.UnitPlayWeaponFire(id, 0, target) {
		t.Fatal("UnitPlayWeaponFire reported nothing played")
	}
	if len(bind.restarts) != 1 || bind.restarts[0].name != "AimPrimary" {
		t.Fatalf("aim not re-driven: %+v", bind.restarts)
	}
	// Same bearing convention as live combat: due +X from heading 0 is a
	// negated quarter turn (~-16384 TA-angle units).
	if h := bind.restarts[0].args[0]; h < -18000 || h > -15000 {
		t.Fatalf("aim heading = %d, want ~-16384", h)
	}
	if got := countCalls(bind.starts, "FirePrimary"); got != 1 {
		t.Fatalf("FirePrimary started %d times, want 1", got)
	}

	// TA:K convention: the shared AimWeapon/FireWeapon set receives the slot.
	tak := &recordingBinding{scripts: map[string]bool{"AimWeapon": true, "FireWeapon": true}}
	tid := w.AddUnit("takgunner", testMeta("takgunner"), tak, fixed.Vec2{}, 0, 0)
	if !w.UnitPlayWeaponFire(tid, 1, target) {
		t.Fatal("TA:K playback reported nothing played")
	}
	if len(tak.restarts) != 1 || tak.restarts[0].name != "AimWeapon" {
		t.Fatalf("TA:K aim not re-driven: %+v", tak.restarts)
	}
	if args := tak.restarts[0].args; len(args) != 3 || args[2] != 1 {
		t.Fatalf("AimWeapon args = %v, want (heading, pitch, slot=1)", args)
	}
	if fires := tak.starts; countCalls(fires, "FireWeapon") != 1 {
		t.Fatalf("FireWeapon not started: %+v", fires)
	}

	// A script-less unit plays nothing, so the driver can fall back to a
	// renderer-side tracer.
	bare := w.AddUnit("bare", testMeta("bare"), nil, fixed.Vec2{}, 0, 0)
	if w.UnitPlayWeaponFire(bare, 0, target) {
		t.Fatal("script-less unit claimed to play a weapon fire")
	}
}
