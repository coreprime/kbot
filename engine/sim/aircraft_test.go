package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// fighterMeta is a fixed-wing aircraft (Hawk-like) whose missile flies a guided
// model projectile and only fires once the airframe is lined up within its
// firing arc.
func fighterMeta(name string) *UnitMeta {
	m := &UnitMeta{
		Name:        name,
		CanMove:     true,
		IsAircraft:  true,
		MaxVelocity: fixed.FromFloat(3.0),
		TurnRate:    fixed.FromInt(600),
		Accel:       fixed.FromFloat(0.2),
		BrakeRate:   fixed.FromFloat(0.2),
	}
	m.Weapons[0] = WeaponMeta{
		Name:        "missile",
		Range:       fixed.FromInt(400),
		ReloadMs:    1000,
		Burst:       1,
		Damage:      fixed.FromInt(5), // weak, so the target survives long enough to watch a full loop
		Present:     true,
		Model:       "missile.3do",
		VelocityWU:  fixed.FromInt(360),
		TurnRateAng: halfTurn,
		Tracks:      true,
		Tolerance:   8000, // ~44deg firing arc
	}
	return m
}

// bomberMeta is a fixed-wing bomber (Thunder-like) whose dropped weapon lays a
// string of gravity bombs along its flight path.
func bomberMeta(name string) *UnitMeta {
	m := &UnitMeta{
		Name:        name,
		CanMove:     true,
		IsAircraft:  true,
		MaxVelocity: fixed.FromFloat(3.0),
		TurnRate:    fixed.FromInt(500),
		Accel:       fixed.FromFloat(0.2),
		BrakeRate:   fixed.FromFloat(0.2),
	}
	m.Weapons[0] = WeaponMeta{
		Name:           "bomb",
		Range:          fixed.FromInt(400),
		ReloadMs:       200,
		Burst:          1,
		Damage:         fixed.FromInt(120),
		Present:        true,
		Model:          "bomb.3do",
		AreaOfEffectWU: fixed.FromInt(48),
		Dropped:        true,
	}
	return m
}

// groundMeta is a stationary punching bag for aircraft to attack.
func groundMeta(name string) *UnitMeta {
	return &UnitMeta{Name: name, CanMove: false}
}

// TestTakeoffFiresFlightPose pins the wing-open pose contract: a grounded TA
// fighter that gets a Move order lifts off and fires its Activate script (the
// activatescr wing-open sequence), and folds them again with Deactivate once it
// settles back down. The transition fires exactly once per edge.
func TestTakeoffFiresFlightPose(t *testing.T) {
	w := New(Config{Seed: 21})
	bind := &recordingBinding{scripts: map[string]bool{"Activate": true, "Deactivate": true}}
	id := w.AddUnit("hawk", fighterMeta("hawk"), bind, fixed.Vec2{X: fixed.FromInt(64), Z: fixed.FromInt(64)}, 0, 0)
	// One idle tick to latch the grounded state before takeoff.
	w.Step(nil)
	if n := countCalls(bind.starts, "Activate"); n != 0 {
		t.Fatalf("Activate fired %d times before takeoff, want 0", n)
	}
	// Take off: fly across the field.
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(600), Z: fixed.FromInt(64)}))
	u := w.UnitByID(id)
	tookOff := false
	for i := 0; i < 120 && !tookOff; i++ {
		w.Step(nil)
		if u.wasAirborne {
			tookOff = true
		}
	}
	if !tookOff {
		t.Fatal("fighter never went airborne")
	}
	if n := countCalls(bind.starts, "Activate"); n != 1 {
		t.Fatalf("takeoff fired Activate %d times, want exactly 1 (wings open once)", n)
	}
	// Let it arrive and settle: the air→ground edge folds the wings.
	for i := 0; i < 600 && u.wasAirborne; i++ {
		w.Step(nil)
	}
	if u.wasAirborne {
		t.Fatal("fighter never landed")
	}
	if n := countCalls(bind.starts, "Deactivate"); n != 1 {
		t.Fatalf("landing fired Deactivate %d times, want exactly 1 (wings fold once)", n)
	}
}

// TestAircraftLandsOnLandNotWater pins the no-water-landing rule: an idle
// aircraft hovering over open water drifts to the nearest dry land to set down,
// rather than parking — and sinking to the seabed — over the sea. Reuses the
// raw-byte water-depth machinery from the terrain water gate.
func TestAircraftLandsOnLandNotWater(t *testing.T) {
	w := New(Config{Seed: 22})
	// Sea (height 0) for x-cells < 20, dry land (height 80, above sea 40)
	// beyond. World is 40×40 cells of 16 wu = 640×640 wu.
	w.SetTerrain(testTerrain(40, 40, 40, func(cx, _ int) uint8 {
		if cx < 20 {
			return 0
		}
		return 80
	}))
	// Confirm the landing gate reads the water/land split as expected.
	waterPt := fixed.Vec2{X: fixed.FromInt(5*16 + 8), Z: fixed.FromInt(20*16 + 8)}
	landPt := fixed.Vec2{X: fixed.FromInt(30*16 + 8), Z: fixed.FromInt(20*16 + 8)}
	if w.canLandAt(waterPt) {
		t.Fatal("water cell reported as a legal landing spot")
	}
	if !w.canLandAt(landPt) {
		t.Fatal("dry-land cell rejected as a landing spot")
	}
	// Park an idle flier over the water; it should migrate to land and settle.
	id := w.AddUnit("hawk", fighterMeta("hawk"), nil, waterPt, 0, 0)
	u := w.UnitByID(id)
	for i := 0; i < 400; i++ {
		w.Step(nil)
	}
	if w.waterDepthAt(u.loco.Pos) > 0 {
		t.Fatalf("idle aircraft settled over water at x=%v (depth %d)",
			u.loco.Pos.X.Float(), w.waterDepthAt(u.loco.Pos))
	}
	if !w.canLandAt(u.loco.Pos) {
		t.Fatalf("idle aircraft did not reach a legal landing spot: x=%v", u.loco.Pos.X.Float())
	}
}

// TestAircraftHeldOnAirPad pins the pad-hold core: an idle aircraft next to a
// friendly air-repair pad sets down on it and is parked at the pad until it is
// given somewhere to be, at which point it releases.
func TestAircraftHeldOnAirPad(t *testing.T) {
	w := New(Config{Seed: 23})
	padMeta := &UnitMeta{Name: "airpad", CanMove: false, IsAirBase: true, MaxHealth: fixed.FromInt(1000)}
	pad := w.AddUnit("airpad", padMeta, nil, fixed.Vec2{X: fixed.FromInt(200), Z: fixed.FromInt(200)}, 0, 0)
	// Flier idle just inside service range of the pad.
	id := w.AddUnit("hawk", fighterMeta("hawk"), nil, fixed.Vec2{X: fixed.FromInt(240), Z: fixed.FromInt(200)}, 0, 0)
	u := w.UnitByID(id)
	for i := 0; i < 30; i++ {
		w.Step(nil)
	}
	if u.padHost != pad {
		t.Fatalf("idle aircraft did not attach to the air pad (padHost=%d, pad=%d)", u.padHost, pad)
	}
	padPos := w.UnitByID(pad).loco.Pos
	if u.loco.Pos.DistTo(padPos) > fixed.One {
		t.Fatalf("held aircraft not parked on the pad: %v vs pad %v", u.loco.Pos, padPos)
	}
	// Ordered away: it releases the pad and flies off.
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(500), Z: fixed.FromInt(500)}))
	for i := 0; i < 60; i++ {
		w.Step(nil)
	}
	if u.padHost != 0 {
		t.Fatalf("aircraft still held on pad after a move order (padHost=%d)", u.padHost)
	}
}

// TestFixedWingFliesByAndLoops drives a fighter at a stationary target and
// confirms it behaves like a real fly-by attacker: it closes the distance,
// lines up and fires its missile, overshoots, then banks out to a turn-around
// point (egress) and comes back for another pass — rather than hovering in
// place or tumbling.
func TestFixedWingFliesByAndLoops(t *testing.T) {
	w := New(Config{Seed: 3})
	atk := w.AddUnit("hawk", fighterMeta("hawk"), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("rock", groundMeta("rock"), nil, fixed.Vec2{X: fixed.FromInt(500)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	u := w.UnitByID(atk)

	fired := false
	sawEgress := false
	sawApproachAfterEgress := false
	moved := false
	start := u.loco.Pos
	for i := 0; i < 600; i++ {
		w.Step(nil)
		if len(w.projectiles) > 0 {
			fired = true
		}
		if u.loco.Pos.DistTo(start) > fixed.FromInt(50) {
			moved = true
		}
		if u.atkPhase == atkEgress {
			sawEgress = true
		}
		if sawEgress && u.atkPhase == atkApproach {
			sawApproachAfterEgress = true
		}
	}
	if !moved {
		t.Fatal("fighter never flew toward its target")
	}
	if !fired {
		t.Fatal("fighter never lined up and fired its missile")
	}
	if !sawEgress {
		t.Fatal("fighter never peeled off into an egress turn after its pass")
	}
	if !sawApproachAfterEgress {
		t.Fatal("fighter never came back around for another run")
	}
}

// TestBomberStraddlesTargetWhileMoving models the ARM Thunder: it must keep
// flying while it bombs (not drop in place), and its bomb string must straddle
// the target — at least one release before the aim point and one after — so the
// middle of the run lands on it.
func TestBomberStraddlesTargetWhileMoving(t *testing.T) {
	w := New(Config{Seed: 9})
	atk := w.AddUnit("thunder", bomberMeta("thunder"), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("rock", groundMeta("rock"), nil, fixed.Vec2{X: fixed.FromInt(420)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	u := w.UnitByID(atk)
	targetX := w.UnitByID(def).loco.Pos.X

	var dropXs []fixed.Fixed
	prevProj := 0
	for i := 0; i < 600; i++ {
		w.Step(nil)
		// Each new projectile this tick was released at the bomber's current X.
		if len(w.projectiles) > prevProj {
			for n := 0; n < len(w.projectiles)-prevProj; n++ {
				dropXs = append(dropXs, u.loco.Pos.X)
			}
		}
		prevProj = len(w.projectiles)
		if len(dropXs) >= 3 && u.atkPhase == atkEgress {
			break
		}
	}
	if len(dropXs) < 2 {
		t.Fatalf("bomber dropped %d bombs, want a multi-bomb string", len(dropXs))
	}
	minX, maxX := dropXs[0], dropXs[0]
	for _, x := range dropXs {
		if x < minX {
			minX = x
		}
		if x > maxX {
			maxX = x
		}
	}
	if minX >= targetX || maxX <= targetX {
		t.Fatalf("bomb run did not straddle the target: drops in [%v,%v], target at %v",
			minX.Float(), maxX.Float(), targetX.Float())
	}
}

// TestBombRunPersistsThroughMove guards the bomb-and-bail tactic: once a bomber
// commits to a run, a fresh Move order must not abort it — the carrier keeps
// flying its string out, dropping more bombs after the Move lands.
func TestBombRunPersistsThroughMove(t *testing.T) {
	w := New(Config{Seed: 4})
	atk := w.AddUnit("thunder", bomberMeta("thunder"), nil, fixed.Vec2{}, 0, 0)
	def := w.AddUnit("rock", groundMeta("rock"), nil, fixed.Vec2{X: fixed.FromInt(420)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	u := w.UnitByID(atk)

	// Run until the bomb run has committed (first bomb away).
	committed := false
	for i := 0; i < 600 && !committed; i++ {
		w.Step(nil)
		if u.bombRunActive {
			committed = true
		}
	}
	if !committed {
		t.Fatal("bomber never committed to a bomb run")
	}

	bombsBefore := len(w.projectiles)
	// Bomb-and-bail: order the bomber home mid-run.
	w.ApplyOrder(order.Move([]uint32{atk}, fixed.Vec2{X: fixed.FromInt(-400), Z: fixed.FromInt(-400)}))

	stillDropping := false
	for i := 0; i < 200; i++ {
		w.Step(nil)
		if len(w.projectiles) > bombsBefore {
			stillDropping = true
			break
		}
	}
	if !stillDropping {
		t.Fatal("bomb run aborted by a mid-run Move order; bombs stopped dropping")
	}
}
