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
	// Ramp rising 10 height units per cell along +X.
	w.SetTerrain(testTerrain(32, 32, 0, func(cx, _ int) uint8 {
		v := cx * 10
		if v > 255 {
			v = 255
		}
		return uint8(v)
	}))
	m := testMeta("walker")
	m.MaxSlope = 20
	id := w.AddUnit("walker", m, nil, fixed.Vec2{X: fixed.FromInt(32), Z: fixed.FromInt(64)}, 0, 0)
	w.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	w.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(200), Z: fixed.FromInt(64)}))
	u := w.UnitByID(id)
	for i := 0; i < 600 && u.hasMove; i++ {
		w.Step(nil)
	}
	// At x≈200 the cell height is (200/16)*10 = 125 units -> Y ≈ 62.5.
	want := w.groundHeight(u.loco.Pos)
	if u.PosY != want || u.PosY < fixed.FromInt(50) {
		t.Fatalf("walker PosY=%v, want ground %v (>50)", u.PosY.Float(), want.Float())
	}
}

// TestTerrainBlocksSteepSlope pins slope legality: a cliff stops a tank but
// not a high-maxslope climber starting from the same side.
func TestTerrainBlocksSteepSlope(t *testing.T) {
	w := New(Config{Seed: 62})
	// Flat 0 until x-cell 12, then a 200-unit cliff.
	w.SetTerrain(testTerrain(32, 32, 0, func(cx, _ int) uint8 {
		if cx >= 12 {
			return 200
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
	w.ApplyOrder(order.Build(bld, "sonar", fixed.Vec2{X: fixed.FromInt(120), Z: fixed.FromInt(64)}))
	for i := 0; i < 200; i++ {
		w.Step(nil)
	}
	count := 0
	w.ForEachUnit(func(u *Unit) { count++ })
	if count != 1 {
		t.Fatalf("illegal build site still spawned a buildee (units=%d)", count)
	}
}
