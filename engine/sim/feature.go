package sim

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
)

// Features and wreckage as first-class sim state (world.md §1.5 / §2.5).
//
// A Feature is a placed map object — a tree, a rock, a metal patch, a sacred
// stone, or the wreck a dead unit leaves behind. Unlike units they never move
// or think; they occupy footprint cells (blocking movement and placement when
// the def says so), carry hit points and a reclaim value, and are the targets
// the reclaim and resurrect channels consume. Metal patches additionally feed
// the extractor income by stamping their metal into the cell-metal grid at
// placement, so the once-at-placement extractor sum picks them up with no
// double counting.
//
// Features are sim STATE (unlike the terrain height field, which is shared
// configuration): they are created and destroyed during play, so they carry
// into the world hash and the render snapshot. Iteration follows a stable
// insertion-ordered slice, exactly like units, so every lockstep peer walks
// them identically.

// featureIDBase offsets every feature id into a high range disjoint from unit
// ids, so a single order/target id disambiguates a wreck-or-feature reclaim
// target from a unit target with no extra wire field. Unit ids climb from 1
// and never approach this base.
const featureIDBase uint32 = 0x40000000

// isFeatureID reports whether an entity id names a feature (vs a unit).
func isFeatureID(id uint32) bool { return id >= featureIDBase }

// FeatureKind classifies a feature for the render lane and the sim rules that
// key off object class. The values are stable — the JS bridge exports them as
// the numeric `kind` field.
type FeatureKind uint8

const (
	// FeatureProp is a generic scenery object (tree, rock, bush): it may
	// block, may be reclaimable, may burn.
	FeatureProp FeatureKind = iota
	// FeatureMetal is an indestructible metal patch: it stamps its metal into
	// the cell grid and can never be cleared or reclaimed.
	FeatureMetal
	// FeatureWreck is the corpse a dead unit leaves: reclaimable salvage,
	// resurrect-eligible, carrying the dead unit's owner.
	FeatureWreck
	// FeatureSacred is a TA:K sacred site (lodestone): an indestructible stone
	// carrying a mana multiplier producers standing fully on it draw income
	// from.
	FeatureSacred
)

// FeatureMeta is the featuredef stat block a feature instance carries into the
// sim — the world.md §1.5 (TA) / §2.5 (TA:K) fields that have a simulation
// consequence. Floats are pre-resolved at the asset boundary. A nil FeatureMeta
// is never valid; every feature carries one.
type FeatureMeta struct {
	Name string

	// FootprintX/Z are the feature's occupancy size in map cells (16 wu). A
	// zero footprint is treated as 1×1.
	FootprintX int
	FootprintZ int

	// Metal / Energy are the reclaim yield (FBI metal / energy). TA reclaim
	// lumps BOTH into the reclaimer's pools; a metal patch additionally
	// stamps Metal into the cell-metal grid. TA:K reclaim credits nothing —
	// the fields are vestigial there (world.md §2.5) — so the TAK economy
	// path simply never reads them.
	Metal  int
	Energy int

	// MaxHP is the feature's maximum hit points (FBI damage). Zero means the
	// feature has no HP ladder (sprite scenery that dies in one splash); the
	// wreck path defaults it to a small value so a wreck can be eroded.
	MaxHP int

	// Blocking marks the feature as an obstacle: it occupies its footprint
	// cells so movers and build sites treat it as impassable (FBI blocking).
	Blocking bool
	// Reclaimable marks the feature as a valid reclaim target (FBI
	// reclaimable). Indestructible features (metal patches, sacred stones)
	// are never reclaimable regardless.
	Reclaimable bool
	// Indestructible marks a feature that can never be cleared, damaged or
	// reclaimed (FBI indestructible) — metal patches and sacred stones.
	Indestructible bool

	// SacredSite is the TA:K mana multiplier a sacred stone carries (FBI
	// sacredsite, 0 = not sacred). A producer standing fully on it adds
	// mogriumincome × SacredSite to its income.
	SacredSite float64

	// FeatureDead is the successor feature name a destructible feature
	// transitions to when it dies or is reclaimed one stage down the wreck
	// heap chain (FBI featuredead). Empty = the cell simply empties.
	FeatureDead string
}

// Feature is one live placed feature (scenery, metal patch, wreck or sacred
// stone).
type Feature struct {
	ID   uint32
	Meta *FeatureMeta
	Kind FeatureKind

	// Pos is the feature's world position (its footprint centre). Cx/Cz are
	// the anchor cell (the footprint's minimum corner) the occupancy grid is
	// stamped from.
	Pos      fixed.Vec3
	Cx, Cz   int
	Heading  int32  // TA-angle orientation (wrecks keep the dead unit's facing)
	HP       int    // current hit points; erodes down the featuredead chain
	Owner    int    // owning side for a wreck (-1 = neutral map feature)
	DeadName string // the unit type name a wreck resurrects back into ("" = none)
}

// footprint returns the feature's occupancy size in cells, flooring a missing
// footprint at 1×1.
func (f *Feature) footprint() (fx, fz int) {
	fx, fz = 1, 1
	if f.Meta != nil {
		if f.Meta.FootprintX > 0 {
			fx = f.Meta.FootprintX
		}
		if f.Meta.FootprintZ > 0 {
			fz = f.Meta.FootprintZ
		}
	}
	return fx, fz
}

// blocks reports whether the feature occupies its footprint cells for
// movement/placement. Blocking and indestructible (metal/sacred) features both
// block; plain reclaimable scenery coexists with movers unless it declares
// blocking.
func (f *Feature) blocks() bool {
	if f == nil || f.Meta == nil {
		return false
	}
	return f.Meta.Blocking || f.Meta.Indestructible
}

// AddFeature places a feature at a world position and returns its id. Metal
// patches stamp their metal into the cell grid so the extractor income picks
// them up (world.md §1.6); blocking features register footprint occupancy.
// Called during map setup and, for wrecks, from the death path.
func (w *World) AddFeature(name string, meta *FeatureMeta, kind FeatureKind, at fixed.Vec2, heading int32, owner int) uint32 {
	if meta == nil {
		return 0
	}
	id := w.nextFeatureID
	w.nextFeatureID++
	fx, fz := 1, 1
	if meta.FootprintX > 0 {
		fx = meta.FootprintX
	}
	if meta.FootprintZ > 0 {
		fz = meta.FootprintZ
	}
	hp := meta.MaxHP
	f := &Feature{
		ID:      id,
		Meta:    meta,
		Kind:    kind,
		Pos:     fixed.Vec3{X: at.X, Y: w.groundHeight(at), Z: at.Z},
		Heading: fixed.WrapAngle(heading),
		HP:      hp,
		Owner:   owner,
	}
	// Anchor the footprint on the centre cell, minimum corner (the engines
	// place sprite features offset by −footprint/2). The cell math uses the
	// terrain pitch (16 wu) when a map is loaded and falls back to the same
	// 16-wu convention on the flat grid so occupancy still works in tests.
	f.Cx, f.Cz = w.featureAnchorCell(at, fx, fz)
	w.features[id] = f
	w.featureOrder = append(w.featureOrder, id)
	if kind == FeatureMetal {
		w.stampMetalPatch(f)
	}
	return id
}

// featureAnchorCell maps a feature's centre world position to its footprint's
// minimum-corner cell.
func (w *World) featureAnchorCell(at fixed.Vec2, fx, fz int) (cx, cz int) {
	cell := fixed.FromInt(16)
	if w.terrain != nil {
		cell = w.terrain.CellWU
	}
	cx = at.X.Div(cell).Int() - fx/2
	cz = at.Z.Div(cell).Int() - fz/2
	return cx, cz
}

// stampMetalPatch writes an indestructible metal feature's metal value into
// every footprint cell of the terrain metal grid, exactly the map loader's
// `featuredef_apply_height_to_cells` pass (world.md §1.6 item 3). The extractor
// income then sums Σ(cellMetal+1) at placement and picks the patch up with no
// double counting. Needs a loaded terrain to have a grid to stamp; a metal
// patch on the flat grid still exists as an entity but feeds no income.
func (w *World) stampMetalPatch(f *Feature) {
	t := w.terrain
	if t == nil || f.Meta == nil || f.Meta.Metal <= 0 {
		return
	}
	if t.Metal == nil {
		t.Metal = make([]uint8, t.W*t.H)
	}
	val := f.Meta.Metal
	if val > 255 {
		val = 255
	}
	fx, fz := f.footprint()
	for dz := 0; dz < fz; dz++ {
		for dx := 0; dx < fx; dx++ {
			cx, cz := f.Cx+dx, f.Cz+dz
			if cx < 0 || cz < 0 || cx >= t.W || cz >= t.H {
				continue
			}
			t.Metal[cz*t.W+cx] = uint8(val)
		}
	}
}

// FeatureByID returns a feature or nil.
func (w *World) FeatureByID(id uint32) *Feature { return w.features[id] }

// RemoveFeature deletes a feature by id — the exported bridge/scenario entry
// point (a map tool clearing scenery, or a test tearing down state).
func (w *World) RemoveFeature(id uint32) { w.removeFeature(id) }

// FeatureCount reports how many live features the world holds (harness/inspection).
func (w *World) FeatureCount() int { return len(w.featureOrder) }

// removeFeature deletes a feature from the world (reclaimed to nothing,
// resurrected, or eroded off the chain end). Metal-patch stamps are left in
// the cell grid — the engines never clear a stamped metal cell, and metal
// patches are indestructible so they never reach this path anyway.
func (w *World) removeFeature(id uint32) {
	if _, ok := w.features[id]; !ok {
		return
	}
	delete(w.features, id)
	for i, fid := range w.featureOrder {
		if fid == id {
			w.featureOrder = append(w.featureOrder[:i], w.featureOrder[i+1:]...)
			break
		}
	}
}

// featureBlocksCell reports whether any blocking feature occupies terrain cell
// (cx, cz). Movers and build sites consult it. Linear over the feature list —
// the sandbox map holds a modest feature count and the check runs only on cell
// crossings, so a per-cell index is unnecessary until feature counts grow.
func (w *World) featureBlocksCell(cx, cz int) bool {
	for _, id := range w.featureOrder {
		f := w.features[id]
		if f == nil || !f.blocks() {
			continue
		}
		fx, fz := f.footprint()
		if cx >= f.Cx && cx < f.Cx+fx && cz >= f.Cz && cz < f.Cz+fz {
			return true
		}
	}
	return false
}

// featureAt returns the feature whose footprint covers world point p, or nil.
func (w *World) featureAt(p fixed.Vec2) *Feature {
	cell := fixed.FromInt(16)
	if w.terrain != nil {
		cell = w.terrain.CellWU
	}
	cx := p.X.Div(cell).Int()
	cz := p.Z.Div(cell).Int()
	for _, id := range w.featureOrder {
		f := w.features[id]
		if f == nil {
			continue
		}
		fx, fz := f.footprint()
		if cx >= f.Cx && cx < f.Cx+fx && cz >= f.Cz && cz < f.Cz+fz {
			return f
		}
	}
	return nil
}

// FeatureIDAt resolves the feature id under a world point (the render lane's
// reclaim/resurrect cursor hit-test), or 0 when the point covers no feature.
func (w *World) FeatureIDAt(x, z fixed.Fixed) uint32 {
	if f := w.featureAt(fixed.Vec2{X: x, Z: z}); f != nil {
		return f.ID
	}
	return 0
}

// featureReclaimTicks is the feature reclaim channel length (world.md §1.5 /
// specials.md §3.2): ftol((metal + energy)/2 + 15) ticks. Independent of the
// reclaimer's worker time — a feature reclaims in a flat, def-driven time.
func featureReclaimTicks(meta *FeatureMeta) int {
	if meta == nil {
		return 15
	}
	t := int(ftol(float64(meta.Metal+meta.Energy)/2 + 15))
	if t < 1 {
		t = 1
	}
	return t
}

// FeatureReclaimTicks exposes the feature reclaim channel length for a feature
// def — the gradeable arithmetic.
func FeatureReclaimTicks(metal, energy int) int {
	return featureReclaimTicks(&FeatureMeta{Metal: metal, Energy: energy})
}

// creditFeatureReclaim pays out a completed feature reclaim to a side's pools.
// TA lumps BOTH the metal and energy yields into the reclaimer's pools (note
// the world.md econ-helper label swap: the `metal_add` path adds ENERGY and
// vice-versa, so a feature carrying metal=M energy=E credits M metal and E
// energy — the labels cancel and the yield lands on the natural axes). TA:K
// reclaim credits nothing (the energy field is vestigial there), so this is a
// no-op under the TAK economy model.
func (w *World) creditFeatureReclaim(side int, meta *FeatureMeta) {
	if meta == nil || w.econModel == EconomyTAK {
		return
	}
	if meta.Metal > 0 {
		w.creditMetal(side, float32(meta.Metal))
	}
	if meta.Energy > 0 {
		w.creditEnergy(side, float32(meta.Energy))
	}
}

// featureToState builds one feature's render snapshot entry.
func (w *World) featureToState(f *Feature) frame.FeatureState {
	var reclaimM, reclaimE int
	if f.Meta != nil && f.Meta.Reclaimable && !f.Meta.Indestructible {
		reclaimM, reclaimE = f.Meta.Metal, f.Meta.Energy
	}
	name := ""
	if f.Meta != nil {
		name = f.Meta.Name
	}
	return frame.FeatureState{
		ID:            f.ID,
		Name:          name,
		Kind:          uint8(f.Kind),
		Pos:           f.Pos,
		Heading:       f.Heading,
		HP:            f.HP,
		Owner:         f.Owner,
		Blocking:      f.blocks(),
		Reclaimable:   f.Meta != nil && f.Meta.Reclaimable && !f.Meta.Indestructible,
		ReclaimMetal:  reclaimM,
		ReclaimEnergy: reclaimE,
		DeadName:      f.DeadName,
	}
}
