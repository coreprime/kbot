package sim

import (
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
)

// featureReclaimerMeta is a mobile builder that can reclaim and resurrect —
// the stand-in for a construction unit in the feature scenarios.
func featureReclaimerMeta(name string) *UnitMeta {
	m := testMeta(name)
	m.CanReclaim = true
	m.CanResurrect = true
	setWorkerTime(m, 300)
	return m
}

// TestFeatureBlocksMovement pins the feature occupancy: a blocking feature
// (a rock) parked across a mover's path stops it, and clearing the feature
// lets the mover through.
func TestFeatureBlocksMovement(t *testing.T) {
	w := New(Config{Seed: 71})
	w.SetTerrain(testTerrain(32, 32, 0, func(_, _ int) uint8 { return 0 }))
	// Unit-level occupancy: a blocking feature makes its footprint cells
	// non-standable and non-traversable; a non-blocking (reclaimable) feature
	// does not.
	m := testMeta("walker")
	m.MaxSlope = 255
	inside := fixed.Vec2{X: fixed.FromInt(192), Z: fixed.FromInt(160)} // over the feature
	outside := fixed.Vec2{X: fixed.FromInt(96), Z: fixed.FromInt(160)} // clear ground
	rock := &FeatureMeta{Name: "rock", FootprintX: 2, FootprintZ: 2, Blocking: true, MaxHP: 100}
	rid := w.AddFeature("rock", rock, FeatureProp, inside, 0, -1)
	if w.canStand(m, inside) {
		t.Fatalf("a ground unit must not stand on a blocking feature")
	}
	if w.canTraverse(m, outside, inside) {
		t.Fatalf("a ground unit must not step into a blocking feature's cell")
	}
	if !w.canStand(m, outside) {
		t.Fatalf("clear ground must be standable")
	}
	// A non-blocking reclaimable tree coexists with movers.
	w.RemoveFeature(rid)
	tree := &FeatureMeta{Name: "tree", FootprintX: 1, FootprintZ: 1, Reclaimable: true}
	w.AddFeature("tree", tree, FeatureProp, inside, 0, -1)
	if !w.canStand(m, inside) {
		t.Fatalf("a non-blocking reclaimable feature must not block movement")
	}

	// Movement scenario: a wall spanning the whole traversable width stops a
	// mover ordered straight through it (no route around).
	w2 := New(Config{Seed: 79})
	w2.SetTerrain(testTerrain(32, 32, 0, func(_, _ int) uint8 { return 0 }))
	for cz := 0; cz < 32; cz++ {
		wall := &FeatureMeta{Name: "wall", FootprintX: 1, FootprintZ: 1, Blocking: true, MaxHP: 100}
		w2.AddFeature("wall", wall, FeatureProp, fixed.Vec2{X: fixed.FromInt(192), Z: fixed.FromInt(cz*16 + 8)}, 0, -1)
	}
	id := w2.AddUnit("walker", m, nil, fixed.Vec2{X: fixed.FromInt(96), Z: fixed.FromInt(160)}, 0, 0)
	w2.ApplyOrder(order.Stance([]uint32{id}, order.MoveHold, order.FireHold))
	w2.ApplyOrder(order.Move([]uint32{id}, fixed.Vec2{X: fixed.FromInt(320), Z: fixed.FromInt(160)}))
	u := w2.UnitByID(id)
	for i := 0; i < 400 && u.hasMove; i++ {
		w2.Step(nil)
	}
	// The wall's cells span world x 192..208; the walker must be stopped at or
	// before its west face, never emerging on the far side.
	if u.loco.Pos.X.Int() >= 208 {
		t.Fatalf("walker crossed a full wall of blocking features: x=%d", u.loco.Pos.X.Int())
	}
}

// TestFeatureReclaimYieldsBothResources pins the feature reclaim payout: a
// reclaimer channeling a tree with metal AND energy credits BOTH resource
// pools when it completes.
func TestFeatureReclaimYieldsBothResources(t *testing.T) {
	w := New(Config{Seed: 72, Economy: EconomyTA, StartMetal: -1, StartEnergy: -1})
	tree := &FeatureMeta{Name: "tree", FootprintX: 1, FootprintZ: 1, Metal: 40, Energy: 20, Reclaimable: true}
	fid := w.AddFeature("tree", tree, FeatureProp, fixed.Vec2{X: fixed.FromInt(48), Z: fixed.FromInt(48)}, 0, -1)

	m := featureReclaimerMeta("con")
	id := w.AddUnit("con", m, nil, fixed.Vec2{X: fixed.FromInt(48), Z: fixed.FromInt(48)}, 0, 0)

	before := w.econView(0).stock
	w.ApplyOrder(order.Reclaim([]uint32{id}, fid))
	// The channel is ftol((40+20)/2 + 15) = 45 ticks; run generously.
	for i := 0; i < 200 && w.FeatureByID(fid) != nil; i++ {
		w.Step(nil)
	}
	if w.FeatureByID(fid) != nil {
		t.Fatalf("feature not reclaimed after 200 ticks")
	}
	after := w.econView(0).stock
	gotM := after.Metal - before.Metal
	gotE := after.Energy - before.Energy
	if gotM < fixed.FromInt(39) || gotE < fixed.FromInt(19) {
		t.Fatalf("reclaim yield metal=%v energy=%v, want ~40/~20", gotM.Float(), gotE.Float())
	}
}

// TestFeatureReclaimTicks pins the flat channel-length arithmetic.
func TestFeatureReclaimTicks(t *testing.T) {
	cases := []struct{ metal, energy, want int }{
		{0, 0, 15},
		{40, 20, 45}, // (60)/2 + 15
		{100, 0, 65}, // 50 + 15
	}
	for _, c := range cases {
		if got := FeatureReclaimTicks(c.metal, c.energy); got != c.want {
			t.Errorf("FeatureReclaimTicks(%d,%d)=%d, want %d", c.metal, c.energy, got, c.want)
		}
	}
}

// TestWreckLeftOnDeathReclaimable pins the wreck chain: a unit that dies leaves
// a persistent reclaimable wreck feature carrying its metal salvage and owner,
// which a reclaimer can then consume for resources.
func TestWreckLeftOnDeathReclaimable(t *testing.T) {
	w := New(Config{Seed: 73, Economy: EconomyTA, StartMetal: -1, StartEnergy: -1})

	victim := testMeta("tank")
	victim.MaxHealth = fixed.FromInt(100)
	victim.Econ.BuildCostMetal = 60
	applyWreckWfrom(victim) // give the synthetic meta a wreck def
	vid := w.AddUnit("tank", victim, nil, fixed.Vec2{X: fixed.FromInt(80), Z: fixed.FromInt(80)}, 0, 1)

	// Kill the victim outright.
	w.killUnit(w.UnitByID(vid), 100, Blast{})
	// Flush the corpse decision (no Killed script -> immediate wreck).
	w.Step(nil)

	if w.FeatureCount() != 1 {
		t.Fatalf("expected 1 wreck after death, got %d", w.FeatureCount())
	}
	var wreck *Feature
	for _, id := range w.featureOrder {
		wreck = w.features[id]
	}
	if wreck.Kind != FeatureWreck {
		t.Fatalf("death feature kind=%d, want wreck", wreck.Kind)
	}
	if wreck.Owner != 1 {
		t.Fatalf("wreck owner=%d, want 1 (the dead unit's side)", wreck.Owner)
	}
	if wreck.DeadName != "tank" {
		t.Fatalf("wreck deadName=%q, want tank", wreck.DeadName)
	}
	if !wreck.Meta.Reclaimable {
		t.Fatalf("wreck not reclaimable")
	}

	// A reclaimer salvages it for metal.
	m := featureReclaimerMeta("con")
	cid := w.AddUnit("con", m, nil, fixed.Vec2{X: fixed.FromInt(80), Z: fixed.FromInt(80)}, 0, 0)
	before := w.econView(0).stock.Metal
	w.ApplyOrder(order.Reclaim([]uint32{cid}, wreck.ID))
	for i := 0; i < 300 && w.FeatureByID(wreck.ID) != nil; i++ {
		w.Step(nil)
	}
	if w.FeatureByID(wreck.ID) != nil {
		t.Fatalf("wreck not reclaimed")
	}
	if got := w.econView(0).stock.Metal - before; got < fixed.FromInt(59) {
		t.Fatalf("wreck reclaim metal=%v, want ~60", got.Float())
	}
}

// applyWreckWfrom mirrors the games asset bridge's wreck default onto a
// synthetic test meta (the bridge is in the games package; the sim test can't
// import it).
func applyWreckWfrom(m *UnitMeta) {
	metal := int(m.Econ.BuildCostMetal)
	if metal < 1 {
		metal = 1
	}
	hp := m.MaxHealth.Int()
	if hp < 1 {
		hp = 1
	}
	m.Wreck = &FeatureMeta{
		Name:        m.Name + "_dead",
		FootprintX:  m.FootprintX,
		FootprintZ:  m.FootprintZ,
		Metal:       metal,
		MaxHP:       hp,
		Reclaimable: true,
	}
}

// TestWreckResurrect pins the resurrect channel: a canresurrect builder raises
// a wreck back into its dead unit type under the builder's side.
func TestWreckResurrect(t *testing.T) {
	w := New(Config{Seed: 74})
	victim := testMeta("tank")
	victim.MaxHealth = fixed.FromInt(100)
	victim.Econ.BuildCostMetal = 60
	applyWreckWfrom(victim)
	// A spawn fn so the resurrect can build the dead unit type back.
	w.spawn = func(name string) (*UnitMeta, Binding) { return victim, nil }
	vid := w.AddUnit("tank", victim, nil, fixed.Vec2{X: fixed.FromInt(80), Z: fixed.FromInt(80)}, 0, 1)
	w.killUnit(w.UnitByID(vid), 100, Blast{})
	w.Step(nil)
	var wreck *Feature
	for _, id := range w.featureOrder {
		wreck = w.features[id]
	}
	if wreck == nil {
		t.Fatal("no wreck to resurrect")
	}

	m := featureReclaimerMeta("necro")
	cid := w.AddUnit("necro", m, nil, fixed.Vec2{X: fixed.FromInt(80), Z: fixed.FromInt(80)}, 0, 0)
	unitsBefore := len(w.order)
	w.ApplyResurrect(cid, wreck.ID, 100)
	for i := 0; i < 400 && w.FeatureByID(wreck.ID) != nil; i++ {
		w.Step(nil)
	}
	if w.FeatureByID(wreck.ID) != nil {
		t.Fatalf("wreck not consumed by resurrect")
	}
	if len(w.order) <= unitsBefore {
		t.Fatalf("resurrect did not spawn a unit (order len %d -> %d)", unitsBefore, len(w.order))
	}
	// The raised unit belongs to the resurrector's side.
	var raised *Unit
	for _, id := range w.order {
		if u := w.units[id]; u != nil && u.Name == "tank" && !u.Dead {
			raised = u
		}
	}
	if raised == nil || raised.Side != 0 {
		t.Fatalf("resurrected unit missing or wrong side")
	}
}

// TestMetalPatchFeedsExtractor pins the metal-in-the-ground reconciliation: an
// indestructible metal patch stamps its metal into the cell grid, so an
// extractor placed on it draws the Σ(cellmetal+1) yield — never double counted.
func TestMetalPatchFeedsExtractor(t *testing.T) {
	w := New(Config{Seed: 75, Economy: EconomyTA})
	w.SetTerrain(testTerrain(32, 32, 0, func(_, _ int) uint8 { return 0 }))
	// A 1x1 metal patch of value 112 at cell (3,3) -> world (56,56).
	patch := &FeatureMeta{Name: "moometal", FootprintX: 1, FootprintZ: 1, Metal: 112, Indestructible: true}
	w.AddFeature("moometal", patch, FeatureMetal, fixed.Vec2{X: fixed.FromInt(56), Z: fixed.FromInt(56)}, 0, -1)

	if got := w.cellMetal(3, 3); got != 112 {
		t.Fatalf("metal patch did not stamp the cell: got %d, want 112", got)
	}

	mex := testMeta("mex")
	mex.CanMove = false
	mex.FootprintX, mex.FootprintZ = 1, 1
	mex.Econ.ExtractsMetal = 0.001
	id := w.AddUnit("mex", mex, nil, fixed.Vec2{X: fixed.FromInt(56), Z: fixed.FromInt(56)}, 0, 0)
	u := w.UnitByID(id)
	// yield = extractsmetal × Σ(cell+1) = 0.001 × (112+1) = 0.113.
	want := float32(0.001 * 113)
	if u.mexYield < want*0.99 || u.mexYield > want*1.01 {
		t.Fatalf("extractor yield=%v, want ~%v", u.mexYield, want)
	}
}

// TestSlopeTiltPitchRoll pins the ground-plate tilt: a vehicle sitting on a
// slope reports a non-zero pitch when the slope runs fore/aft and a non-zero
// roll when it runs left/right, while an upright kbot stays flat.
func TestSlopeTiltPitchRoll(t *testing.T) {
	// A ramp rising 6 height units per cell along +X.
	ramp := func() *Terrain {
		return testTerrain(32, 32, 0, func(cx, _ int) uint8 {
			v := cx * 6
			if v > 255 {
				v = 255
			}
			return uint8(v)
		})
	}

	// At heading 0 the model faces +Z (world +z at heading 0), so a ramp that
	// rises along +X runs LEFT/RIGHT across the hull -> a non-zero ROLL and
	// almost no pitch.
	w := New(Config{Seed: 76})
	w.SetTerrain(ramp())
	veh := testMeta("tank")
	veh.FootprintX, veh.FootprintZ = 3, 3
	veh.MaxSlope = 255
	vid := w.AddUnit("tank", veh, nil, fixed.Vec2{X: fixed.FromInt(160), Z: fixed.FromInt(160)}, 0, 0)
	w.settleOnTerrain(w.UnitByID(vid))
	pitch, roll := w.UnitTilt(vid)
	if abs32(roll) == 0 {
		t.Fatalf("vehicle broadside to the slope should roll: roll=%d", roll)
	}
	if abs32(pitch) > abs32(roll)/2 {
		t.Fatalf("vehicle broadside should tilt in roll not pitch: pitch=%d roll=%d", pitch, roll)
	}

	// Turned a quarter turn the model faces +X, straight up the ramp -> a
	// non-zero PITCH and almost no roll.
	w2 := New(Config{Seed: 77})
	w2.SetTerrain(ramp())
	quarter := int32(fixed.FullCircle / 4)
	vid2 := w2.AddUnit("tank", veh, nil, fixed.Vec2{X: fixed.FromInt(160), Z: fixed.FromInt(160)}, quarter, 0)
	w2.settleOnTerrain(w2.UnitByID(vid2))
	pitch2, roll2 := w2.UnitTilt(vid2)
	if abs32(pitch2) == 0 {
		t.Fatalf("vehicle facing up the slope should pitch: pitch=%d", pitch2)
	}
	if abs32(roll2) > abs32(pitch2)/2 {
		t.Fatalf("vehicle facing up the slope should tilt in pitch not roll: pitch=%d roll=%d", pitch2, roll2)
	}

	// An upright kbot never tilts.
	w3 := New(Config{Seed: 78})
	w3.SetTerrain(ramp())
	kbot := testMeta("kbot")
	kbot.Upright = true
	kbot.FootprintX, kbot.FootprintZ = 2, 2
	kbot.MaxSlope = 255
	kid := w3.AddUnit("kbot", kbot, nil, fixed.Vec2{X: fixed.FromInt(160), Z: fixed.FromInt(160)}, 0, 0)
	w3.settleOnTerrain(w3.UnitByID(kid))
	kp, kr := w3.UnitTilt(kid)
	if kp != 0 || kr != 0 {
		t.Fatalf("upright kbot tilted: pitch=%d roll=%d, want 0/0", kp, kr)
	}
}

// TestSacredSiteIncome pins the TA:K lodestone rule: a sacred-site producer
// standing fully on a sacred stone draws mogriumincome × sacredsite; a
// producer NOT covering a stone (or with only partial coverage) draws nothing.
func TestSacredSiteIncome(t *testing.T) {
	makeWorld := func() *World {
		w := New(Config{Seed: 80, Economy: EconomyTAK})
		w.SetTerrain(testTerrain(32, 32, 0, func(_, _ int) uint8 { return 40 }))
		return w
	}
	lode := func(name string) *UnitMeta {
		m := testMeta(name)
		m.CanMove = false
		m.FootprintX, m.FootprintZ = 2, 2
		m.SacredProducer = true
		m.Econ.ManaIncome = 10
		m.Econ.BuildTimeF = 100
		return m
	}
	// A 2x2 swarthy stone (sacredsite 1.5) at cell (4,4) -> world centre (72,72).
	stoneAt := func(w *World, cx, cz int) {
		s := &FeatureMeta{Name: "stone", FootprintX: 2, FootprintZ: 2, SacredSite: 1.5, Indestructible: true}
		w.AddFeature("stone", s, FeatureSacred, fixed.Vec2{X: fixed.FromInt(cx*16 + 16), Z: fixed.FromInt(cz*16 + 16)}, 0, -1)
	}

	// Producer fully on the stone: income = 10 × 1.5 = 15 mana/s.
	w := makeWorld()
	stoneAt(w, 4, 4)
	id := w.AddUnit("lode", lode("lode"), nil, fixed.Vec2{X: fixed.FromInt(80), Z: fixed.FromInt(80)}, 0, 0)
	on := w.UnitByID(id)
	if got := w.sacredMultiplierFor(on); got != 1.5 {
		t.Fatalf("producer on the stone: multiplier=%v, want 1.5", got)
	}
	for i := 0; i < 30; i++ {
		w.Step(nil)
	}
	incomeOn := w.econView(0).produced.Mana.Float()

	// Producer far from any stone: no sacred income.
	w2 := makeWorld()
	stoneAt(w2, 4, 4)
	id2 := w2.AddUnit("lode", lode("lode"), nil, fixed.Vec2{X: fixed.FromInt(400), Z: fixed.FromInt(400)}, 0, 0)
	if got := w2.sacredMultiplierFor(w2.UnitByID(id2)); got != 0 {
		t.Fatalf("producer off the stone: multiplier=%v, want 0", got)
	}
	for i := 0; i < 30; i++ {
		w2.Step(nil)
	}
	incomeOff := w2.econView(0).produced.Mana.Float()

	if incomeOn <= incomeOff {
		t.Fatalf("sacred producer on the stone should out-earn one off it: on=%v off=%v", incomeOn, incomeOff)
	}
	if incomeOff != 0 {
		t.Fatalf("a sacred producer off any stone should earn no mana: got %v", incomeOff)
	}
}

// TestLavaBlocksAndDamages pins the lavaworld terrain rules: below-sea lava
// cells are unpathable, and water/lava attrition damages a ground unit sitting
// in them every 30 ticks.
func TestLavaBlocksAndDamages(t *testing.T) {
	w := New(Config{Seed: 81})
	// A pit: cells below sea (height 0, sea 20) form a lava trough at x-cell < 8.
	terr := testTerrain(32, 32, 20, func(cx, _ int) uint8 {
		if cx < 8 {
			return 0
		}
		return 40
	})
	terr.LavaWorld = true
	terr.WaterDoesDamage = true
	terr.WaterDamage = 30
	w.SetTerrain(terr)

	m := testMeta("tank")
	m.MaxSlope = 255
	m.MaxHealth = fixed.FromInt(100)
	// A cell inside the lava trough must be unstandable.
	lavaPt := fixed.Vec2{X: fixed.FromInt(48), Z: fixed.FromInt(160)}
	if w.canStand(m, lavaPt) {
		t.Fatalf("lava must be unpathable")
	}
	dryPt := fixed.Vec2{X: fixed.FromInt(240), Z: fixed.FromInt(160)}
	if !w.canStand(m, dryPt) {
		t.Fatalf("dry high ground must be standable")
	}

	// A unit forced into the lava (spawned there) takes attrition over 30 ticks.
	id := w.AddUnit("tank", m, nil, lavaPt, 0, 0)
	u := w.UnitByID(id)
	u.PosY = fixed.FromInt(0) // sitting at the pit floor, below sea
	before := u.Health
	for i := 0; i < 31; i++ {
		w.Step(nil)
	}
	if u.Health >= before {
		t.Fatalf("lava attrition dealt no damage: %v -> %v", before.Float(), u.Health.Float())
	}
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}
