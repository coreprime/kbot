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
