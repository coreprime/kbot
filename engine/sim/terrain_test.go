package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
)

// testTerrain builds a W×H height field from a fill function, at the TNT
// attribute scale (16 wu cells, heights rendered at 1/2).
func testTerrain(w, h, seaLevel int, fill func(cx, cz int) uint8) *Terrain {
	data := make([]uint8, w*h)
	for cz := 0; cz < h; cz++ {
		for cx := 0; cx < w; cx++ {
			data[cz*w+cx] = fill(cx, cz)
		}
	}
	return &Terrain{W: w, H: h, CellWU: fixed.FromInt(16), HeightScale: fixed.FromFloat(0.5), SeaLevel: seaLevel, Data: data}
}

// TestTerrainElevation pins heightmap riding: a unit walking up a ramp
// carries the interpolated ground height in PosY.
func TestTerrainElevation(t *testing.T) {
	w := New(Config{Seed: 61})
	// Ramp rising 6 height units per cell along +X — within the walker's
	// scaled climb limit (MaxSlope 20 -> ~8).
	w.SetTerrain(testTerrain(32, 32, 0, func(cx, _ int) uint8 {
		v := cx * 6
		if v > 255 {
			v = 255
		}
		return uint8(v)
	}))
	m := testMeta("walker")
	m.MaxSlope = 20
	id := w.AddUnit("walker", m, nil, fixed.Vec2{X: fixed.FromInt(32), Z: fixed.FromInt(64)}, 0, 0)
	w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(360), Z: fixed.FromInt(64)}))
	u := w.UnitByID(id)
	for i := 0; i < 900 && u.hasMove; i++ {
		w.Step(nil)
	}
	// At x≈360 the cell height is (360/16)*6 ≈ 135 units -> Y ≈ 67.
	want := w.groundHeight(u.loco.Pos)
	if u.PosY != want || u.PosY < fixed.FromInt(50) {
		t.Fatalf("walker PosY=%v, want ground %v (>50)", u.PosY.Float(), want.Float())
	}
}

// TestTerrainBlocksSteepSlope pins slope legality: a cliff stops a tank but
// not a high-maxslope climber starting from the same side.
func TestTerrainBlocksSteepSlope(t *testing.T) {
	w := New(Config{Seed: 62})
	// Flat 0 until x-cell 12, then a 60-unit step — a wall to the tank
	// (scaled limit ~6), a climbable ramp to the high-slope spider (~102).
	w.SetTerrain(testTerrain(32, 32, 0, func(cx, _ int) uint8 {
		if cx >= 12 {
			return 60
		}
		return 0
	}))
	tank := testMeta("tank")
	tank.MaxSlope = 16
	spider := testMeta("spider")
	spider.MaxSlope = 255
	a := w.AddUnit("tank", tank, nil, fixed.Vec2{X: fixed.FromInt(64), Z: fixed.FromInt(96)}, 0, 0)
	b := w.AddUnit("spider", spider, nil, fixed.Vec2{X: fixed.FromInt(64), Z: fixed.FromInt(160)}, 0, 0)
	for _, id := range []uint32{a, b} {
		w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	}
	w.ApplyOrder(order.Move([]uint32{a}, fixed.Vec2{X: fixed.FromInt(360), Z: fixed.FromInt(96)}))
	w.ApplyOrder(order.Move([]uint32{b}, fixed.Vec2{X: fixed.FromInt(360), Z: fixed.FromInt(160)}))
	for i := 0; i < 800; i++ {
		w.Step(nil)
	}
	ua, ub := w.UnitByID(a), w.UnitByID(b)
	cliffX := fixed.FromInt(12 * 16)
	if ua.loco.Pos.X >= cliffX {
		t.Fatalf("tank climbed the cliff to x=%v", ua.loco.Pos.X.Float())
	}
	if ub.loco.Pos.X < fixed.FromInt(340) {
		t.Fatalf("spider never crossed the cliff: x=%v", ub.loco.Pos.X.Float())
	}
}

// TestShipStaysInWater pins water legality both ways: a ship cannot drive
// ashore and a tank cannot wade past its depth.
func TestShipStaysInWater(t *testing.T) {
	w := New(Config{Seed: 63})
	// Sea (height 0) for x-cells < 16, beach rising to dry land after.
	w.SetTerrain(testTerrain(32, 32, 40, func(cx, _ int) uint8 {
		if cx < 16 {
			return 0
		}
		return uint8(40 + (cx-16)*4)
	}))
	ship := testMeta("ship")
	ship.IsShip = true
	ship.MinWaterDepth = 12
	tank := testMeta("tank")
	tank.MaxWaterDepth = 10
	tank.MaxSlope = 30
	a := w.AddUnit("ship", ship, nil, fixed.Vec2{X: fixed.FromInt(64), Z: fixed.FromInt(96)}, 0, 0)
	b := w.AddUnit("tank", tank, nil, fixed.Vec2{X: fixed.FromInt(400), Z: fixed.FromInt(160)}, 0, 0)
	for _, id := range []uint32{a, b} {
		w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	}
	w.ApplyOrder(order.Move([]uint32{a}, fixed.Vec2{X: fixed.FromInt(440), Z: fixed.FromInt(96)}))
	w.ApplyOrder(order.Move([]uint32{b}, fixed.Vec2{X: fixed.FromInt(64), Z: fixed.FromInt(160)}))
	for i := 0; i < 800; i++ {
		w.Step(nil)
	}
	ua, ub := w.UnitByID(a), w.UnitByID(b)
	// Ship blocked roughly where depth thins past 12 (height 28 = cell 23
	// at most; in practice the beach starts at cell 16).
	if ua.loco.Pos.X > fixed.FromInt(23*16) {
		t.Fatalf("ship drove ashore to x=%v", ua.loco.Pos.X.Float())
	}
	// Tank blocked where depth exceeds 10 (height < 30 -> cells < 18ish).
	if ub.loco.Pos.X < fixed.FromInt(16*16-8) {
		t.Fatalf("tank waded into deep water to x=%v", ub.loco.Pos.X.Float())
	}
	// And the ship floats at the waterline, not the seabed.
	if ua.PosY != fixed.FromInt(40).Mul(fixed.FromFloat(0.5)) {
		t.Fatalf("ship Y=%v, want waterline 20", ua.PosY.Float())
	}
}

// TestProjectileHitsTerrain pins terrain occlusion: a flat shot at a point
// beyond a high ridge detonates on the ridge instead of reaching it.
func TestProjectileHitsTerrain(t *testing.T) {
	w := New(Config{Seed: 64})
	// Ridge of height 240 across x-cells 14..15; flat elsewhere.
	w.SetTerrain(testTerrain(40, 32, 0, func(cx, _ int) uint8 {
		if cx >= 14 && cx <= 15 {
			return 240
		}
		return 0
	}))
	m := testMeta("gunner")
	m.Weapons[0] = WeaponMeta{
		Name: "cannon", Range: fixed.FromInt(500), ReloadMs: 800, Burst: 1,
		Damage: fixed.FromInt(30), Present: true,
		VelocityWU: fixed.FromInt(300),
	}
	id := w.AddUnit("gunner", m, nil, fixed.Vec2{X: fixed.FromInt(64), Z: fixed.FromInt(128)}, 0, 0)
	w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.FireAtPoint(id, 0, fixed.Vec2{X: fixed.FromInt(420), Z: fixed.FromInt(128)}))
	var hitX fixed.Fixed = -1
	for i := 0; i < 400 && hitX < 0; i++ {
		w.Step(nil)
		for _, ev := range w.Snapshot().Events {
			if ev.Kind == frame.EvProjectileHit {
				hitX = ev.Anchor.X
			}
		}
	}
	if hitX < 0 {
		t.Fatalf("shot never detonated")
	}
	// The ridge spans x 224..256; the shot must die there, far short of 420.
	if hitX > fixed.FromInt(280) {
		t.Fatalf("shot cleared the ridge and landed at x=%v", hitX.Float())
	}
}

// TestBuildRefusedOnIllegalSite pins build legality: a structure that needs
// water cannot be ordered onto dry land.
func TestBuildRefusedOnIllegalSite(t *testing.T) {
	spawn := func(name string) (*UnitMeta, Binding) {
		m := testMeta(name)
		m.CanMove = false
		m.MinWaterDepth = 12
		m.IsShip = true // floating structure: needs depth
		return m, nil
	}
	w := New(Config{Seed: 65, Spawn: spawn})
	w.SetTerrain(testTerrain(32, 32, 0, func(_, _ int) uint8 { return 100 })) // bone dry
	bm := testMeta("builder")
	bm.IsBuilder = true
	bm.WorkerTime = 100
	bm.MaxSlope = 50
	bld := w.AddUnit("builder", bm, nil, fixed.Vec2{X: fixed.FromInt(64), Z: fixed.FromInt(64)}, 0, 0)
	w.ApplyOrder(order.Build(bld, "sonar", fixed.Vec2{X: fixed.FromInt(120), Z: fixed.FromInt(64)}, 0))
	for i := 0; i < 200; i++ {
		w.Step(nil)
	}
	count := 0
	w.ForEachUnit(func(u *Unit) { count++ })
	if count != 1 {
		t.Fatalf("illegal build site still spawned a buildee (units=%d)", count)
	}
}

// TestShorelineTurnaround pins the boundary-turn trap: a unit that walked to
// its depth limit (order dropped at the boundary) must be able to turn
// around and walk back out — the mid-turn forward creep over the boundary
// must not drop the outbound order.
func TestShorelineTurnaround(t *testing.T) {
	w := New(Config{Seed: 31})
	// Heights descend westward: x cell 0..63 → height 10..73; sea level 60
	// puts everything west of cell ~25 underwater, deepening westward.
	data := make([]uint8, 64*64)
	for cz := 0; cz < 64; cz++ {
		for cx := 0; cx < 64; cx++ {
			data[cz*64+cx] = uint8(10 + cx)
		}
	}
	w.SetTerrain(&Terrain{W: 64, H: 64, CellWU: fixed.FromInt(16), HeightScale: fixed.FromInt(1), SeaLevel: 60, Data: data})
	m := testMeta("amphib")
	m.Weapons[0] = WeaponMeta{}
	m.MaxSlope = 20
	m.MaxWaterDepth = 30
	id := w.AddUnit("amphib", m, nil, fixed.Vec2{X: fixed.FromInt(800), Z: fixed.FromInt(512)}, 0, 0)
	u := w.UnitByID(id)
	// Wade west until the depth limit stops him.
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(100), Z: fixed.FromInt(512)}))
	for i := 0; i < 4000 && u.hasMove; i++ {
		w.Step(nil)
	}
	if u.hasMove {
		t.Fatal("never reached the depth boundary")
	}
	atShore := u.loco.Pos
	// Now walk back east — the turn at the boundary must not strand him.
	goal := fixed.Vec2{X: fixed.FromInt(800), Z: fixed.FromInt(512)}
	w.ApplyOrder(order.Move([]uint32{id}, goal))
	for i := 0; i < 6000 && u.hasMove; i++ {
		w.Step(nil)
	}
	if u.loco.Pos.DistTo(goal) > fixed.FromInt(40) {
		t.Fatalf("unit stranded at the shoreline: stopped (%v,%v), was at (%v,%v)",
			u.loco.Pos.X.Float(), u.loco.Pos.Z.Float(), atShore.X.Float(), atShore.Z.Float())
	}
}

// TestWalkAlongCliffBase pins directional slope semantics: ground running
// flat alongside a cliff is walkable even though the adjacent cells tower
// over it — only CLIMBING costs slope.
func TestWalkAlongCliffBase(t *testing.T) {
	w := New(Config{Seed: 33})
	// A cliff wall along z: cells with x >= 32 are 200 high, the west
	// plain is 10. Walking north-south at the base (x cell 31) is flat.
	data := make([]uint8, 64*64)
	for cz := 0; cz < 64; cz++ {
		for cx := 0; cx < 64; cx++ {
			h := uint8(10)
			if cx >= 32 {
				h = 200
			}
			data[cz*64+cx] = h
		}
	}
	w.SetTerrain(&Terrain{W: 64, H: 64, CellWU: fixed.FromInt(16), HeightScale: fixed.FromInt(1), Data: data})
	m := testMeta("tank")
	m.Weapons[0] = WeaponMeta{}
	m.MaxSlope = 14
	id := w.AddUnit("tank", m, nil, fixed.Vec2{X: fixed.FromInt(500), Z: fixed.FromInt(200)}, 0, 0)
	u := w.UnitByID(id)
	goal := fixed.Vec2{X: fixed.FromInt(500), Z: fixed.FromInt(800)}
	w.ApplyOrder(order.Move([]uint32{id}, goal))
	for i := 0; i < 4000 && u.hasMove; i++ {
		w.Step(nil)
	}
	if u.loco.Pos.DistTo(goal) > fixed.FromInt(40) {
		t.Fatalf("tank could not walk along the cliff base: stopped at (%v,%v)",
			u.loco.Pos.X.Float(), u.loco.Pos.Z.Float())
	}
	// And the cliff itself stays unclimbable.
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(700), Z: fixed.FromInt(800)}))
	for i := 0; i < 2000 && u.hasMove; i++ {
		w.Step(nil)
	}
	if u.loco.Pos.X > fixed.FromInt(520) {
		t.Fatalf("tank climbed a 190-unit cliff (x=%v)", u.loco.Pos.X.Float())
	}
}
