package sim

import "github.com/coreprime/kbot/engine/fixed"

// Terrain is the map's height field, sampled by the simulation for unit
// elevation, movement legality (slope and water-depth limits), build-site
// checks and projectile-vs-ground hits. The grid is the TNT attribute-
// resolution heightmap (one cell per 16 world units); heights are the raw
// 0..255 bytes, scaled to world Y by HeightScale. A nil terrain (The Grid)
// behaves as an infinite flat plane at Y 0 with no movement restrictions.
//
// Terrain is configuration, not simulation state: every lockstep peer must
// install the identical grid before stepping (exactly like unit meta), so it
// is never hashed or carried in snapshots.
type Terrain struct {
	W, H        int         // cells
	CellWU      fixed.Fixed // world units per cell (16 for TNT attr grid)
	HeightScale fixed.Fixed // world Y per height unit (TA renders at 1/2)
	SeaLevel    int         // height units; cells below it are underwater
	Data        []uint8     // row-major heights, len = W*H
	// Void marks cells the map carves out entirely (the TNT 0xFFFC
	// sentinel): nothing stands, walks or builds there. Optional —
	// nil means no voids.
	Void []uint8
	// Metal carries the per-cell metal byte (the plot-cell field the map
	// loader floods from SurfaceMetal and stamps metal-patch features
	// into; cell metal never changes at runtime). Optional — nil means
	// bare ground everywhere. Extractor yield samples it once, at
	// placement.
	Metal []uint8
}

// cellMetal reads the metal byte at cell (cx, cz); off-map and metal-less
// worlds read zero (the extractor formula's +1 floor still applies there).
func (w *World) cellMetal(cx, cz int) uint8 {
	t := w.terrain
	if t == nil || t.Metal == nil || cx < 0 || cz < 0 || cx >= t.W || cz >= t.H {
		return 0
	}
	return t.Metal[cz*t.W+cx]
}

// SetTerrain installs (or clears, with nil) the world's height field.
func (w *World) SetTerrain(t *Terrain) {
	if t != nil && (t.W <= 0 || t.H <= 0 || len(t.Data) < t.W*t.H) {
		return
	}
	w.terrain = t
}

// Terrain returns the installed height field (nil = flat sandbox grid).
func (w *World) Terrain() *Terrain { return w.terrain }

// clampToMap pins a position inside the loaded map's world-unit extent,
// keeping `margin` (typically a unit's collision radius) clear of every edge so
// the body stays fully on-map. The hard battlefield border. With no terrain
// (The Grid) the world is unbounded and the point is returned unchanged.
func (w *World) clampToMap(p fixed.Vec2, margin fixed.Fixed) fixed.Vec2 {
	if w.terrain == nil {
		return p
	}
	maxX := w.terrain.CellWU.Mul(fixed.FromInt(w.terrain.W)) - margin
	maxZ := w.terrain.CellWU.Mul(fixed.FromInt(w.terrain.H)) - margin
	// Degenerate guard: a map smaller than two margins collapses to its centre.
	if maxX < margin {
		maxX, margin = w.terrain.CellWU.Mul(fixed.FromInt(w.terrain.W)).Div(fixed.FromInt(2)), 0
	}
	if maxZ < margin {
		maxZ = w.terrain.CellWU.Mul(fixed.FromInt(w.terrain.H)).Div(fixed.FromInt(2))
	}
	p.X = fixed.Clamp(p.X, margin, maxX)
	p.Z = fixed.Clamp(p.Z, margin, maxZ)
	return p
}

// cellVoid reports whether cell (cx, cz) is carved out of the map.
func (t *Terrain) cellVoid(cx, cz int) bool {
	if t.Void == nil {
		return false
	}
	if cx < 0 || cz < 0 || cx >= t.W || cz >= t.H {
		return true // off-map counts as void
	}
	return t.Void[cz*t.W+cx] != 0
}

// cellHeight reads the raw height byte at cell (cx, cz), clamped at the rim
// so off-map queries extend the edge rather than falling to zero.
func (t *Terrain) cellHeight(cx, cz int) int {
	if cx < 0 {
		cx = 0
	} else if cx >= t.W {
		cx = t.W - 1
	}
	if cz < 0 {
		cz = 0
	} else if cz >= t.H {
		cz = t.H - 1
	}
	return int(t.Data[cz*t.W+cx])
}

// cellAt maps a world point onto the terrain cell grid (floor convention).
func (t *Terrain) cellAt(p fixed.Vec2) (cx, cz int) {
	cx = p.X.Div(t.CellWU).Int()
	cz = p.Z.Div(t.CellWU).Int()
	if p.X < 0 {
		cx--
	}
	if p.Z < 0 {
		cz--
	}
	return cx, cz
}

// rawHeightAt samples the heightmap bilinearly at a world point in RAW height
// units (16.16) — the engines' own sim Y axis: a unit's integer Y compares
// directly against the map's sea-level byte, and the slope pitch mixes these
// raw heights with wu runs. HeightScale applies only at the world-Y boundary.
func (t *Terrain) rawHeightAt(p fixed.Vec2) fixed.Fixed {
	fx := p.X.Div(t.CellWU)
	fz := p.Z.Div(t.CellWU)
	cx, cz := t.cellAt(p)
	ax := fx - fixed.FromInt(cx)
	az := fz - fixed.FromInt(cz)
	h00 := fixed.FromInt(t.cellHeight(cx, cz))
	h10 := fixed.FromInt(t.cellHeight(cx+1, cz))
	h01 := fixed.FromInt(t.cellHeight(cx, cz+1))
	h11 := fixed.FromInt(t.cellHeight(cx+1, cz+1))
	top := h00 + (h10 - h00).Mul(ax)
	bot := h01 + (h11 - h01).Mul(ax)
	return top + (bot - top).Mul(az)
}

// groundHeight samples the terrain's world-Y at a world point, bilinearly
// interpolated between the four surrounding cells in fixed-point (so every
// lockstep peer computes the identical elevation).
func (w *World) groundHeight(p fixed.Vec2) fixed.Fixed {
	t := w.terrain
	if t == nil {
		return 0
	}
	return t.rawHeightAt(p).Mul(t.HeightScale)
}

// unitUnderwater reports whether the unit counts as underwater for the speed
// law: integer Y below the map's sea-level byte. Ground units ride the
// terrain, so the raw ground height at their position stands in for the
// engines' unit-Y read (which comes off the footprint median — the same
// value up to interpolation detail).
func (w *World) unitUnderwater(u *Unit) bool {
	t := w.terrain
	if t == nil {
		return false
	}
	return t.rawHeightAt(u.loco.Pos).Int() < t.SeaLevel
}

// waterDepthAt returns how far underwater the terrain sits at a world point,
// in height units (0 on dry land).
func (w *World) waterDepthAt(p fixed.Vec2) int {
	t := w.terrain
	if t == nil {
		return 0
	}
	cx := p.X.Div(t.CellWU).Int()
	cz := p.Z.Div(t.CellWU).Int()
	d := t.SeaLevel - t.cellHeight(cx, cz)
	if d < 0 {
		return 0
	}
	return d
}

// canStand reports whether a unit of the given stats may occupy a world
// point under the installed terrain: ships and subs need their minimum
// water depth, surface units respect their maximum depth and slope limits,
// aircraft go anywhere. With no terrain everything is legal.
func (w *World) canStand(m *UnitMeta, p fixed.Vec2) bool {
	if w.terrain == nil || m == nil || m.IsAircraft {
		return true
	}
	if w.terrain.cellVoid(p.X.Div(w.terrain.CellWU).Int(), p.Z.Div(w.terrain.CellWU).Int()) {
		return false
	}
	depth := w.waterDepthAt(p)
	if m.IsShip || m.IsSub {
		min := m.MinWaterDepth
		if min <= 0 {
			min = 12
		}
		return depth >= min
	}
	// Hovercraft ride any water through their movement class's permissive
	// depth window (moveinfo classes omit maxwaterdepth; the load default is
	// permissive) — no special case here, the meta carries the resolved value.
	if depth > m.MaxWaterDepth {
		return false
	}
	return true
}

// canLandAt reports whether an aircraft may touch down at a world point: the
// cell must exist (not void / off-map) and be dry land, never open water — TA
// aircraft select a land spot and refuse to land on the sea. This is the
// airborne mirror of canStand's water gate (which exempts aircraft outright
// because they fly over everything); landing re-imposes the ground rule for
// the touchdown cell only. With no terrain (The Grid) everything is land.
func (w *World) canLandAt(p fixed.Vec2) bool {
	t := w.terrain
	if t == nil {
		return true
	}
	cx := p.X.Div(t.CellWU).Int()
	cz := p.Z.Div(t.CellWU).Int()
	if t.cellVoid(cx, cz) {
		return false
	}
	return w.waterDepthAt(p) <= 0
}

// canTraverse reports whether a unit may STEP from one world point to
// another: the destination must satisfy canStand (void / water rules) and,
// when the step crosses into a different terrain cell, the cell-pair height
// delta must be within the unit's slope limit — raw height units against the
// raw FBI/moveinfo maxslope, ≤ comparison (a delta exactly at maxslope is
// legal). The badslope penalty band, the per-class blocker raster and its
// 3×3 min-filter inflation belong to the passability block; until it lands
// this pairwise test is the legality stand-in the mover and pathfinder share.
// The check is directional on purpose — standing beside a cliff and walking
// along its base is level ground, only climbing it costs slope.
func (w *World) canTraverse(m *UnitMeta, from, to fixed.Vec2) bool {
	if !w.canStand(m, to) {
		return false
	}
	t := w.terrain
	if t == nil || m == nil || m.IsAircraft || m.IsShip || m.IsSub {
		return true
	}
	fx, fz := t.cellAt(from)
	tx, tz := t.cellAt(to)
	if fx == tx && fz == tz {
		return true
	}
	dh := t.cellHeight(tx, tz) - t.cellHeight(fx, fz)
	if dh < 0 {
		dh = -dh
	}
	return dh <= m.MaxSlope
}

// canBuildAt reports whether a structure of the given stats may be founded
// at a world point. Water rules match canStand; the slope rule differs from
// movement: a building cares about the height SPREAD across its whole
// footprint (is the plot flat enough?), not the steepest single step — the
// per-cell rule would refuse almost every site on naturally bumpy maps.
func (w *World) canBuildAt(m *UnitMeta, p fixed.Vec2) bool {
	if m == nil {
		return true
	}
	// Buildings can't stack — reject a footprint that overlaps an existing
	// standing structure. Runs first, in world units, so it applies on The
	// Grid (no height field) as well as on loaded maps.
	phx, phz := yardHalfExtents(m)
	for _, id := range w.order {
		o := w.units[id]
		if o == nil || o.Dead || o.Meta == nil || o.Meta.CanMove {
			continue
		}
		ohx, ohz := yardHalfExtents(o.Meta)
		dx := p.X - o.loco.Pos.X
		if dx < 0 {
			dx = -dx
		}
		dz := p.Z - o.loco.Pos.Z
		if dz < 0 {
			dz = -dz
		}
		if dx < phx+ohx && dz < phz+ohz {
			return false
		}
	}
	t := w.terrain
	if t == nil {
		return true
	}
	depth := w.waterDepthAt(p)
	if m.IsShip || m.IsSub {
		min := m.MinWaterDepth
		if min <= 0 {
			min = 12
		}
		return depth >= min
	}
	// A structure that declares MinWaterDepth (an underwater storage / mex /
	// fusion) must sit in at least that depth — the mirror of a land building's
	// MaxWaterDepth ceiling. Without this branch its MaxWaterDepth defaults to 0,
	// so every water cell is rejected and it reads as land-only. The footprint
	// flatness check below still runs against the seabed.
	if m.MinWaterDepth > 0 {
		if depth < m.MinWaterDepth {
			return false
		}
	} else if depth > m.MaxWaterDepth {
		return false
	}
	fx, fz := m.FootprintX, m.FootprintZ
	if fx <= 0 {
		fx = 2
	}
	if fz <= 0 {
		fz = 2
	}
	cx := p.X.Div(t.CellWU).Int()
	cz := p.Z.Div(t.CellWU).Int()
	lo, hi := 255, 0
	for dz := -fz / 2; dz <= fz/2; dz++ {
		for dx := -fx / 2; dx <= fx/2; dx++ {
			// Any carved-out cell under the footprint kills the plot.
			if t.cellVoid(cx+dx, cz+dz) {
				return false
			}
			h := t.cellHeight(cx+dx, cz+dz)
			if h < lo {
				lo = h
			}
			if h > hi {
				hi = h
			}
		}
	}
	maxSlope := m.MaxSlope
	if maxSlope <= 0 {
		maxSlope = 16
	}
	return hi-lo <= maxSlope
}

// CanBuildAt reports whether unit type `name` may legally occupy the ground
// point — the exported form the studio client calls to colour the build
// placement ghost (green vs red). Unknown types stay neutral (true) so a
// missing spawn fn never paints a false negative.
func (w *World) CanBuildAt(name string, x, z fixed.Fixed) bool {
	if w.spawn == nil {
		return true
	}
	m, _ := w.spawn(name)
	if m == nil {
		return true
	}
	return w.canBuildAt(m, fixed.Vec2{X: x, Z: z})
}

// settleOnTerrain is the terrain snap that runs after each unit's move:
// it pins a surface unit's Y and measures the pitch the slope-speed law
// consumes next frame. Aircraft handle altitude in stepAltitude.
func (w *World) settleOnTerrain(u *Unit) {
	t := w.terrain
	if t == nil || u.Meta == nil || u.Meta.IsAircraft || u.carriedBy != 0 {
		return
	}
	m := u.Meta
	if m.IsShip || m.Floater {
		// Floaters ride the surface: Y = waterline·0xffff + seaLevel in the
		// engines' raw height units (the 0xffff — not 0x10000 — multiplier is
		// the engines' own quirk, preserved); world Y scales from there.
		y := fixed.Fixed((int64(m.WaterLine)*0xffff)>>16) + fixed.FromInt(t.SeaLevel)
		u.PosY = y.Mul(t.HeightScale)
		u.pitch = 0
		return
	}
	// Buildees keep their construction sink offset below grade.
	if u.underConstruction() {
		return
	}
	if m.IsSub {
		// Subs take the Y-only snap: depth is a static function of the
		// seabed (no dynamic depth-holding in the engines); the seabed pin
		// stands in for the engine's minimum-depth clamp off the unitdef
		// depth field.
		u.PosY = w.groundHeight(u.loco.Pos)
		u.pitch = 0
		return
	}
	ground := w.groundHeight(u.loco.Pos)
	if m.CanHover || m.IsHovercraft {
		// A hovercraft's cushion floors every sample at sea level, so it
		// rides the water surface. (The engines add a speed-damped idle bob
		// on top — render-only, so the sim skips it.)
		sea := fixed.FromInt(t.SeaLevel).Mul(t.HeightScale)
		if ground < sea {
			ground = sea
		}
	}
	u.PosY = ground
	if m.Upright {
		// Upright units (kbots) snap Y only — they stand vertical, their
		// pitch stays 0 and the slope table never slows them. (UNKNOWN-7b:
		// whether something else writes their pitch is unresolved; the
		// terrain-snap dispatch is implemented as decompiled.)
		u.pitch = 0
		return
	}
	u.pitch = w.groundPitch(u)
}

// groundPitch measures the unit's pitch from the terrain: the footprint
// corners, rotated by heading, each sample the heightmap bilinearly in RAW
// height units (hover corners floored at sea level), and the pitch is
// atan2 of the front/back height delta over the footprint length in wu —
// the engines' unit conventions exactly (raw heights over wu runs). The
// positive-pitch-equals-climbing orientation follows the slope table's
// asymmetry (spec UNKNOWN-7a pins it empirically).
func (w *World) groundPitch(u *Unit) int32 {
	t := w.terrain
	m := u.Meta
	fx, fz := m.FootprintX, m.FootprintZ
	if fx <= 0 {
		fx = 1
	}
	if fz <= 0 {
		fz = 1
	}
	hw := fixed.FromInt(fx * 8) // half width in wu (16 wu cells)
	hl := fixed.FromInt(fz * 8) // half length in wu
	sin, cos := fixed.SinCos(int32(u.Heading()))
	sea := fixed.FromInt(t.SeaLevel)
	corner := func(df, dr fixed.Fixed) fixed.Fixed {
		p := fixed.Vec2{
			X: u.loco.Pos.X + sin.Mul(df) + cos.Mul(dr),
			Z: u.loco.Pos.Z + cos.Mul(df) - sin.Mul(dr),
		}
		h := t.rawHeightAt(p)
		if (m.CanHover || m.IsHovercraft) && h < sea {
			h = sea
		}
		return h
	}
	front := corner(hl, -hw) + corner(hl, hw)
	back := corner(-hl, -hw) + corner(-hl, hw)
	rise := (front - back).Div(fixed.FromInt(2))
	return fixed.ShortestArc(fixed.Atan2(rise, fixed.FromInt(fz*16)))
}