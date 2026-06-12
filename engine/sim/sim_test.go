package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
)

func testMeta(name string) *UnitMeta {
	m := &UnitMeta{
		Name:        name,
		CanMove:     true,
		MaxVelocity: fixed.FromFloat(1.2),
		TurnRate:    fixed.FromInt(600),
		Accel:       fixed.FromFloat(0.1),
		BrakeRate:   fixed.FromFloat(0.2),
	}
	m.Weapons[0] = WeaponMeta{Name: "test", Range: fixed.FromInt(200), ReloadMs: 250, Burst: 1, Damage: fixed.FromInt(25), Present: true}
	return m
}

func runScenario(seed uint32) *World {
	w := New(Config{Seed: seed})
	a := w.AddUnit("mover", testMeta("mover"), nil, fixed.Vec2{}, 0, 0)
	b := w.AddUnit("target", testMeta("target"), nil, fixed.Vec2{X: fixed.FromInt(300)}, 0, 1)
	w.ApplyOrder(order.Move([]uint32{a}, fixed.Vec2{X: fixed.FromInt(150), Z: fixed.FromInt(150)}))
	w.ApplyOrder(order.Attack([]uint32{b}, a))
	for i := 0; i < 400; i++ {
		w.Step(nil)
	}
	return w
}

// TestDeterminism is the property the whole engine rests on: identical seed +
// identical orders + fixed ticks produce bit-identical state.
func TestDeterminism(t *testing.T) {
	h1 := runScenario(99).Hash()
	h2 := runScenario(99).Hash()
	if h1 != h2 {
		t.Fatalf("non-deterministic: %x != %x", h1, h2)
	}
}

func TestMovementProgresses(t *testing.T) {
	w := New(Config{Seed: 1})
	id := w.AddUnit("m", testMeta("m"), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(100)}))
	w.Step(nil)
	start := w.UnitByID(id).loco.Pos
	for i := 0; i < 200; i++ {
		w.Step(nil)
	}
	end := w.UnitByID(id).loco.Pos
	if start.DistTo(end) < fixed.FromInt(50) {
		t.Errorf("unit did not move appreciably: %v -> %v", start.X.Float(), end.X.Float())
	}
	// It should arrive near the target and stop moving.
	if w.UnitByID(id).IsMoving {
		t.Errorf("unit should have arrived and stopped, still moving")
	}
}

func TestCombatKills(t *testing.T) {
	w := New(Config{Seed: 5})
	atk := w.AddUnit("atk", testMeta("atk"), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(120)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))
	killed := false
	for i := 0; i < 500 && !killed; i++ {
		w.Step(nil)
		if w.UnitByID(def).Dead {
			killed = true
		}
	}
	if !killed {
		t.Errorf("attacker never killed defender; def hp=%v", w.UnitByID(def).Health.Float())
	}
}

// recordedCall captures a script invocation and its integer arguments.
type recordedCall struct {
	name string
	args []int
}

// recordingBinding is a fake sim.Binding that records which scripts the world
// drives, so a test can assert the weapon aim/fire threads are invoked without
// standing up a real COB program.
type recordingBinding struct {
	scripts  map[string]bool
	starts   []recordedCall
	restarts []recordedCall
}

func (b *recordingBinding) HasScript(name string) bool { return b.scripts[name] }
func (b *recordingBinding) Start(name string, args ...int) {
	b.starts = append(b.starts, recordedCall{name, append([]int(nil), args...)})
}
func (b *recordingBinding) Restart(name string, args ...int) {
	b.restarts = append(b.restarts, recordedCall{name, append([]int(nil), args...)})
}
func (b *recordingBinding) Pieces() []frame.PieceState { return nil }

func countCalls(calls []recordedCall, name string) int {
	n := 0
	for _, c := range calls {
		if c.name == name {
			n++
		}
	}
	return n
}

// TestWeaponScriptsDriven proves stepWeapons drives the COB aim and fire
// threads: the turret is re-aimed via Restart("AimPrimary", heading, pitch) with
// a bearing pointing at the target, and each shot starts FirePrimary for the
// recoil/muzzle animation.
func TestWeaponScriptsDriven(t *testing.T) {
	w := New(Config{Seed: 7})
	bind := &recordingBinding{scripts: map[string]bool{"AimPrimary": true, "FirePrimary": true}}
	atk := w.AddUnit("atk", testMeta("atk"), bind, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(120)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))
	for i := 0; i < 60; i++ {
		w.Step(nil)
	}
	if len(bind.restarts) == 0 {
		t.Fatal("aim thread was never driven")
	}
	if got := bind.restarts[0].name; got != "AimPrimary" {
		t.Fatalf("first restart = %q, want AimPrimary", got)
	}
	// Target sits due +X of the attacker (heading 0 = +Z), so the bearing is a
	// quarter turn (~16384 TA-angle units). The aim heading is negated to match
	// the render pipeline's inverse Y rotation (piece rot[1] = -ry), so the
	// script receives ~-16384.
	if h := bind.restarts[0].args[0]; h < -18000 || h > -15000 {
		t.Fatalf("aim heading = %d, want ~-16384 (negated quarter turn toward +X)", h)
	}
	if got := countCalls(bind.starts, "FirePrimary"); got == 0 {
		t.Fatal("FirePrimary was never started on a shot")
	}
}

// aimGatingBinding is a fake that implements the optional aimBinding surface,
// reporting an aim as incomplete until it has been polled readyAfter times. It
// lets a test assert the weapon SM waits for the aim thread before firing.
type aimGatingBinding struct {
	recordingBinding
	readyAfter int
	polls      int
}

func (b *aimGatingBinding) StartAim(name string, args ...int) int32 {
	b.restarts = append(b.restarts, recordedCall{name, append([]int(nil), args...)})
	b.polls = 0
	return 1
}

func (b *aimGatingBinding) AimStatus(id int32) (bool, int32) {
	b.polls++
	if b.polls >= b.readyAfter {
		return true, 1
	}
	return false, 0
}

// TestFireGatedOnAimCompletion proves the weapon holds fire until the COB aim
// thread reports completion: with a target already in range and the reload
// elapsed, no FirePrimary is started while the aim is pending, and the first
// shot only lands once the aim thread returns TRUE.
func TestFireGatedOnAimCompletion(t *testing.T) {
	w := New(Config{Seed: 11})
	bind := &aimGatingBinding{
		recordingBinding: recordingBinding{scripts: map[string]bool{"AimPrimary": true, "FirePrimary": true}},
		readyAfter:       10,
	}
	atk := w.AddUnit("atk", testMeta("atk"), bind, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(80)}, 0, 1)
	w.ApplyOrder(order.Stance([]uint32{def}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	// First few ticks: in range and reloaded, but the aim is still turning, so
	// the weapon must not have fired yet.
	for i := 0; i < 5; i++ {
		w.Step(nil)
	}
	if got := countCalls(bind.starts, "FirePrimary"); got != 0 {
		t.Fatalf("fired %d times before aim completed, want 0", got)
	}

	// Run past the point the aim reports done; the weapon should now fire.
	for i := 0; i < 30; i++ {
		w.Step(nil)
	}
	if got := countCalls(bind.starts, "FirePrimary"); got == 0 {
		t.Fatal("weapon never fired after the aim thread completed")
	}
}

// TestAimReDrivenWhileTracking proves the world keeps re-issuing the COB aim
// thread on a steady cadence while a target stays in range, even when the
// bearing never drifts. Without that keep-alive the turret is aimed once and a
// unit's own restore-after-delay script then walks it back to its home pose; the
// cadence re-drive is what holds the barrel on target. The shot must also keep
// firing — a cadence refresh must not re-gate fire the way an actual drift does.
func TestAimReDrivenWhileTracking(t *testing.T) {
	w := New(Config{Seed: 21})
	meta := testMeta("turret")
	meta.CanMove = false // hold position so the bearing to the target can't drift
	bind := &aimGatingBinding{
		recordingBinding: recordingBinding{scripts: map[string]bool{"AimPrimary": true, "FirePrimary": true}},
		readyAfter:       1, // aim completes on the first poll
	}
	atk := w.AddUnit("turret", meta, bind, fixed.Vec2{}, 0, 0)

	// Force-fire a fixed ground point comfortably in range. Nothing moves, so the
	// only reason to re-issue the aim thread is the keep-alive cadence.
	u := w.units[atk]
	u.weapons[0] = weaponSlot{hasTarget: true, targetPt: fixed.Vec3{X: fixed.FromInt(100)}, source: "manual"}

	const ticks = 130 // aimRefreshMs (1000ms) is 40 ticks, so this spans ~3 windows
	for i := 0; i < ticks; i++ {
		w.Step(nil)
	}

	aimCalls := countCalls(bind.restarts, "AimPrimary")
	wantMin := ticks * TickMs / int(aimRefreshMs) // one re-drive per refresh window
	if aimCalls < wantMin {
		t.Fatalf("AimPrimary issued %d times over %d ticks, want >= %d (cadence re-drive)", aimCalls, ticks, wantMin)
	}
	if countCalls(bind.starts, "FirePrimary") == 0 {
		t.Fatal("weapon never fired while tracking a stationary target")
	}
}

// TestSnapshotCarriesSpeed guards the render-snapshot speed enrichment: a unit
// mid-move reports a positive speed the renderer can drive gait/effects from,
// and a stationary unit reports zero.
func TestSnapshotCarriesSpeed(t *testing.T) {
	w := New(Config{Seed: 3})
	id := w.AddUnit("m", testMeta("m"), nil, fixed.Vec2{}, 0, 0)
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(400)}))
	var sawMoving bool
	for i := 0; i < 60; i++ {
		w.Step(nil)
		snap := w.Snapshot()
		if snap.Units[0].Speed > 0 {
			sawMoving = true
			break
		}
	}
	if !sawMoving {
		t.Fatal("snapshot never reported a positive speed while moving")
	}

	stopped := New(Config{Seed: 3})
	stopped.AddUnit("s", testMeta("s"), nil, fixed.Vec2{}, 0, 0)
	stopped.Step(nil)
	if got := stopped.Snapshot().Units[0].Speed; got != 0 {
		t.Fatalf("idle unit speed = %v, want 0", got.Float())
	}
}

// takWeaponBinding fakes a TA:K v6 script binding: the shared AimWeapon /
// FireWeapon / QueryWeapon set with the WEAPON_READY port handshake instead of
// aim-thread return values. It signals ready for the slot named in the last
// StartAim once readyAfterAims aim drives have been issued.
type takWeaponBinding struct {
	recordingBinding
	readyAfterAims int
	aims           int
	ready          uint32
	aborted        uint32
}

func (b *takWeaponBinding) StartAim(name string, args ...int) int32 {
	b.restarts = append(b.restarts, recordedCall{name, append([]int(nil), args...)})
	b.aims++
	if b.aims >= b.readyAfterAims && len(args) >= 3 {
		b.ready |= 1 << uint(args[2])
	}
	return int32(b.aims)
}

// AimStatus is TA's protocol; a TA:K unit must never be gated through it.
func (b *takWeaponBinding) AimStatus(id int32) (bool, int32) { return false, 0 }

func (b *takWeaponBinding) TakeWeaponReady(slot int) bool {
	bit := uint32(1) << uint(slot)
	if b.ready&bit == 0 {
		return false
	}
	b.ready &^= bit
	return true
}

func (b *takWeaponBinding) TakeWeaponAimAborted(slot int) bool {
	bit := uint32(1) << uint(slot)
	if b.aborted&bit == 0 {
		return false
	}
	b.aborted &^= bit
	return true
}

// TestTAKWeaponConvention proves the weapon SM speaks TA:K when the unit's
// script defines AimWeapon: the aim drive passes (heading, pitch, slot), fire
// is gated on the WEAPON_READY port write rather than a thread return, and the
// shot starts FireWeapon with the slot argument.
func TestTAKWeaponConvention(t *testing.T) {
	w := New(Config{Seed: 13})
	bind := &takWeaponBinding{
		recordingBinding: recordingBinding{scripts: map[string]bool{
			"AimWeapon": true, "FireWeapon": true, "TargetCleared": true,
		}},
		readyAfterAims: 1,
	}
	atk := w.AddUnit("atk", testMeta("atk"), bind, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(80)}, 0, 1)
	w.ApplyOrder(order.Stance([]uint32{def}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Attack([]uint32{atk}, def))
	for i := 0; i < 80; i++ {
		w.Step(nil)
	}
	if len(bind.restarts) == 0 {
		t.Fatal("AimWeapon was never driven")
	}
	first := bind.restarts[0]
	if first.name != "AimWeapon" {
		t.Fatalf("first aim drive = %q, want AimWeapon", first.name)
	}
	if len(first.args) != 3 || first.args[2] != 0 {
		t.Fatalf("AimWeapon args = %v, want (heading, pitch, 0)", first.args)
	}
	fires := 0
	for _, c := range bind.starts {
		if c.name == "FireWeapon" {
			fires++
			if len(c.args) != 1 || c.args[0] != 0 {
				t.Fatalf("FireWeapon args = %v, want (0)", c.args)
			}
		}
	}
	if fires == 0 {
		t.Fatal("FireWeapon was never started on a shot")
	}
}

// TestTAKFireGatedOnWeaponReady holds the WEAPON_READY write back and asserts
// no shot lands before it: the TA:K gate must come from the port handshake,
// not from AimStatus (which a TA:K binding never satisfies).
func TestTAKFireGatedOnWeaponReady(t *testing.T) {
	w := New(Config{Seed: 17})
	bind := &takWeaponBinding{
		recordingBinding: recordingBinding{scripts: map[string]bool{
			"AimWeapon": true, "FireWeapon": true,
		}},
		readyAfterAims: 1 << 30, // never signals ready
	}
	atk := w.AddUnit("atk", testMeta("atk"), bind, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(80)}, 0, 1)
	w.ApplyOrder(order.Stance([]uint32{def}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Attack([]uint32{atk}, def))
	for i := 0; i < 20; i++ {
		w.Step(nil)
	}
	if got := countCalls(bind.starts, "FireWeapon"); got != 0 {
		t.Fatalf("fired %d times without WEAPON_READY, want 0", got)
	}
}

// TestTAKTargetClearedNotified proves a TA:K unit hears TargetCleared with the
// weapon index when its tracked target dies, so its script can abort the aim
// loop and restore the turret pose.
func TestTAKTargetClearedNotified(t *testing.T) {
	w := New(Config{Seed: 19})
	bind := &takWeaponBinding{
		recordingBinding: recordingBinding{scripts: map[string]bool{
			"AimWeapon": true, "FireWeapon": true, "TargetCleared": true,
		}},
		readyAfterAims: 1,
	}
	atk := w.AddUnit("atk", testMeta("atk"), bind, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("def", testMeta("def"), nil, fixed.Vec2{X: fixed.FromInt(80)}, 0, 1)
	w.ApplyOrder(order.Stance([]uint32{def}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Attack([]uint32{atk}, def))
	for i := 0; i < 500; i++ {
		w.Step(nil)
		if w.UnitByID(def).Dead {
			break
		}
	}
	if !w.UnitByID(def).Dead {
		t.Fatal("defender never died; cannot exercise TargetCleared")
	}
	// Step once more so stepAttack sweeps the dead target's slot.
	w.Step(nil)
	if got := countCalls(bind.starts, "TargetCleared"); got == 0 {
		t.Fatal("TargetCleared was never started after the target died")
	}
}
