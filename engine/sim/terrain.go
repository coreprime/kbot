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

// groundHeight samples the terrain's world-Y at a world point, bilinearly
// interpolated between the four surrounding cells in fixed-point (so every
// lockstep peer computes the identical elevation).
func (w *World) groundHeight(p fixed.Vec2) fixed.Fixed {
	t := w.terrain
	if t == nil {
		return 0
	}
	fx := p.X.Div(t.CellWU)
	fz := p.Z.Div(t.CellWU)
	cx, cz := fx.Int(), fz.Int()
	if p.X < 0 {
		cx--
	}
	if p.Z < 0 {
		cz--
	}
	ax := fx - fixed.FromInt(cx)
	az := fz - fixed.FromInt(cz)
	h00 := fixed.FromInt(t.cellHeight(cx, cz))
	h10 := fixed.FromInt(t.cellHeight(cx+1, cz))
	h01 := fixed.FromInt(t.cellHeight(cx, cz+1))
	h11 := fixed.FromInt(t.cellHeight(cx+1, cz+1))
	top := h00 + (h10 - h00).Mul(ax)
	bot := h01 + (h11 - h01).Mul(ax)
	return (top + (bot - top).Mul(az)).Mul(t.HeightScale)
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

// slopeAt returns the steepest height delta (height units) between the cell
// under a world point and its four neighbours — the figure FBI maxslope is
// compared against.
func (w *World) slopeAt(p fixed.Vec2) int {
	t := w.terrain
	if t == nil {
		return 0
	}
	cx := p.X.Div(t.CellWU).Int()
	cz := p.Z.Div(t.CellWU).Int()
	h := t.cellHeight(cx, cz)
	max := 0
	for _, d := range [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
		dh := t.cellHeight(cx+d[0], cz+d[1]) - h
		if dh < 0 {
			dh = -dh
		}
		if dh > max {
			max = dh
		}
	}
	return max
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
	maxDepth := m.MaxWaterDepth
	if m.IsHovercraft {
		// A hovercraft rides its cushion over any water but still cannot
		// climb cliffs.
		maxDepth = 1 << 16
	}
	if depth > maxDepth {
		return false
	}
	if depth == 0 || m.IsHovercraft {
		maxSlope := m.MaxSlope
		if maxSlope <= 0 {
			maxSlope = 16
		}
		if w.slopeAt(p) > maxSlope {
			return false
		}
	}
	return true
}

// canBuildAt reports whether a structure of the given stats may be founded
// at a world point. Water rules match canStand; the slope rule differs from
// movement: a building cares about the height SPREAD across its whole
// footprint (is the plot flat enough?), not the steepest single step — the
// per-cell rule would refuse almost every site on naturally bumpy maps.
func (w *World) canBuildAt(m *UnitMeta, p fixed.Vec2) bool {
	t := w.terrain
	if t == nil || m == nil {
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
	if depth > m.MaxWaterDepth {
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

// settleOnTerrain pins a surface unit's Y to the ground (ships ride the
// waterline, subs the seabed); aircraft handle altitude in stepAltitude.
func (w *World) settleOnTerrain(u *Unit) {
	t := w.terrain
	if t == nil || u.Meta == nil || u.Meta.IsAircraft || u.carriedBy != 0 {
		return
	}
	if u.Meta.IsShip {
		u.PosY = fixed.FromInt(t.SeaLevel).Mul(t.HeightScale)
		return
	}
	// Buildees keep their construction sink offset below grade.
	if u.underConstruction() {
		return
	}
	u.PosY = w.groundHeight(u.loco.Pos)
}