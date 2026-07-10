package sim

import "github.com/coreprime/kbot/engine/fixed"

// Line-of-sight, fog-of-war and radar — the per-side vision layer that gates
// autonomous target acquisition. Modelled from the TA engine's grid-based
// system (combat.md §2.1) and transplanted onto the sandbox substrate:
//
//   - each unit reveals a filled circle of radius FBI sightdistance on its
//     side's LOS layer every tick, and (TA only) a radar/sonar circle of
//     radardistance/sonardistance on the radar layer;
//   - a cell tracks a tri-state per side — fogged (never seen), explored
//     (seen once, sticky) and currently visible (a live sight source covers
//     it this tick);
//   - a unit is VISIBLE to a side when a friendly sight source has it inside
//     sightdistance (own units always; cloaked units never — the TA
//     "cloaked is never in LOS for anyone" rule); it is DETECTED (radar blip,
//     position without identity) when a friendly radar source covers it and
//     no enemy jammer blanks it;
//   - autonomous acquisition may only pick VISIBLE enemies. Radar contact
//     alone does not enable auto-fire — TA gates shoot-the-radar-dot on a
//     Targeting Facility the sandbox does not model — so a radar-only contact
//     surfaces as a blip but is never auto-engaged. Explicit player Attack /
//     force-fire orders bypass the gate entirely (stepAttack is untouched).
//
// Fidelity seams. The sandbox maps world→cell on a straight axis-aligned XZ
// grid (matching its own terrain sampling), not TA's isometric Z-skew; sight
// radius is the raw FBI figure rather than TA's 32-wu-quantised sprite bank;
// TA's per-player-round-robin scan cadence (~1 s stagger) is collapsed to a
// clean per-tick recompute; and event-driven return-fire against an
// out-of-sight attacker is not modelled (a Return Fire unit re-acquires only
// what it can see). TA:K cloak-vs-targeting is UNKNOWN [combat.md U-TAK2];
// the sandbox applies the TA cloak-hides-LOS rule to both games.

// losCellWU is the LOS grid cell edge — 32 world units, one map tile, the
// resolution both engines rasterise sight into (combat.md §2.1.1).
const losCellWU = 32

// sightSource is one unit's per-tick contribution to a side's LOS layer.
type sightSource struct {
	pos   fixed.Vec2
	sight fixed.Fixed
}

// radarSource is one unit's per-tick contribution to a side's radar/sonar
// layer. jam is the unit's radar-jam radius (0 = not a jammer).
type radarSource struct {
	pos   fixed.Vec2
	radar fixed.Fixed
	sonar fixed.Fixed
	jam   fixed.Fixed
	yWU   fixed.Fixed // eye/emit height contribution to the radar threshold
}

// updateSight recomputes the whole per-side vision layer for the current
// tick: it collects each side's sight/radar sources, sets the per-unit
// VISIBLE / DETECTED masks the acquisition gate reads, and (when a map is
// installed) re-stamps the per-side fog grids the render lane draws. It is a
// pure function of hashed unit state — no RNG, stable iteration — so it never
// perturbs determinism and its outputs are neither hashed nor serialised.
func (w *World) updateSight() {
	for s := 0; s < maxSides; s++ {
		w.sightSrc[s] = w.sightSrc[s][:0]
		w.radarSrc[s] = w.radarSrc[s][:0]
		w.sideSightAware[s] = false
		w.sideRadarAware[s] = false
	}
	radarOn := w.econModel != EconomyTAK // TA:K radar is vestigial (combat.md §2.2)
	for _, id := range w.order {
		u := w.units[id]
		if u == nil || u.Dead || u.Meta == nil || u.underConstruction() || u.carriedBy != 0 {
			continue
		}
		if u.Side < 0 || u.Side >= maxSides {
			continue
		}
		if u.Meta.SightDistance > 0 {
			w.sideSightAware[u.Side] = true
			w.sightSrc[u.Side] = append(w.sightSrc[u.Side], sightSource{
				pos:   u.loco.Pos,
				sight: fixed.FromInt(u.Meta.SightDistance),
			})
		}
		if radarOn && (u.Meta.RadarDistance > 0 || u.Meta.SonarDistance > 0 || u.Meta.RadarDistanceJam > 0) {
			if u.Meta.RadarDistance > 0 || u.Meta.SonarDistance > 0 {
				w.sideRadarAware[u.Side] = true
			}
			w.radarSrc[u.Side] = append(w.radarSrc[u.Side], radarSource{
				pos:   u.loco.Pos,
				radar: fixed.FromInt(u.Meta.RadarDistance),
				sonar: fixed.FromInt(u.Meta.SonarDistance),
				jam:   fixed.FromInt(u.Meta.RadarDistanceJam),
				yWU:   u.PosY,
			})
		}
	}
	for _, id := range w.order {
		u := w.units[id]
		if u == nil {
			continue
		}
		u.visibleMask = 0
		u.detectedMask = 0
		if u.Dead || u.carriedBy != 0 {
			continue
		}
		for s := 0; s < maxSides; s++ {
			if w.visibleToSide(s, u) {
				u.visibleMask |= 1 << uint(s)
			} else if w.detectedBySide(s, u) {
				u.detectedMask |= 1 << uint(s)
			}
		}
	}
	w.stampFogGrids()
}

// visibleToSide reports whether unit t is in a side's true line of sight: own
// units always, cloaked enemies never, and — once the side fields any
// sight-bearing unit — only enemies a friendly sight source covers. A side
// with no vision data at all stays omniscient, preserving the pre-vision
// behaviour for bare metas and unenriched browser units.
func (w *World) visibleToSide(side int, t *Unit) bool {
	if t.Meta == nil {
		return true
	}
	if t.Side == side {
		return true
	}
	if t.cloaked {
		return false
	}
	if !w.sideSightAware[side] {
		return true
	}
	for i := range w.sightSrc[side] {
		s := &w.sightSrc[side][i]
		if planarWithin(s.pos, t.loco.Pos, s.sight) {
			return true
		}
	}
	return false
}

// detectedBySide reports whether unit t registers on a side's radar/sonar
// (an enemy blip — position without identity). Own units are excluded (they
// are already fully known). A cloaked-but-not-stealth unit still blips, per
// TA (only the static stealth flag hides a contact, and the sandbox models
// no stealth flag). An enemy jammer covering t blanks the contact.
func (w *World) detectedBySide(side int, t *Unit) bool {
	if t.Meta == nil || t.Side == side || !w.sideRadarAware[side] {
		return false
	}
	hit := false
	for i := range w.radarSrc[side] {
		s := &w.radarSrc[side][i]
		// Altitude raises the radar threshold (combat.md §2.1.4): a high
		// flier is picked up further out.
		if s.radar > 0 && planarWithin(s.pos, t.loco.Pos, s.radar+t.PosY.Mul(fixed.FromInt(2))) {
			hit = true
			break
		}
		if s.sonar > 0 && planarWithin(s.pos, t.loco.Pos, s.sonar) {
			hit = true
			break
		}
	}
	if !hit {
		return false
	}
	// Jamming runs after detection so an enemy jammer hides contacts inside
	// its radius (combat.md §2.1.4 pass 3).
	for other := 0; other < maxSides; other++ {
		if other == side {
			continue
		}
		for i := range w.radarSrc[other] {
			s := &w.radarSrc[other][i]
			if s.jam > 0 && planarWithin(s.pos, t.loco.Pos, s.jam) {
				return false
			}
		}
	}
	return true
}

// autoVisible is the acquisition gate: an autonomous scan may only pick an
// enemy its side currently sees in true LOS. Radar contact alone does not
// qualify (no Targeting Facility in the sandbox).
func (w *World) autoVisible(side int, t *Unit) bool {
	return t.Side == side || t.visibleMask&(1<<uint(side)) != 0
}

// planarWithin reports whether b lies within radius r of a on the XZ plane
// (altitude ignored, matching the engines' planar distance tests). It avoids
// the square-root by comparing squared 32-bit whole-wu distances.
func planarWithin(a, b fixed.Vec2, r fixed.Fixed) bool {
	if r <= 0 {
		return false
	}
	dx := int64((a.X - b.X).Int())
	dz := int64((a.Z - b.Z).Int())
	rr := int64(r.Int())
	return dx*dx+dz*dz <= rr*rr
}

// ensureFogGrids sizes the per-side fog layers to the installed map (LOS cells
// of 32 wu) and clears the sticky explored layer. Called when a terrain is
// installed or replaced; a nil terrain drops the grids (no fog rendering
// without a map — the acquisition gate still runs off the per-unit masks).
func (w *World) ensureFogGrids() {
	t := w.terrain
	if t == nil || t.W <= 0 || t.H <= 0 {
		w.fogCols, w.fogRows = 0, 0
		for s := 0; s < maxSides; s++ {
			w.fogSight[s] = nil
			w.fogRadar[s] = nil
			w.fogSeen[s] = nil
		}
		return
	}
	widthWU := t.W * t.CellWU.Int()
	heightWU := t.H * t.CellWU.Int()
	w.fogCols = (widthWU + losCellWU - 1) / losCellWU
	w.fogRows = (heightWU + losCellWU - 1) / losCellWU
	n := w.fogCols * w.fogRows
	for s := 0; s < maxSides; s++ {
		w.fogSight[s] = make([]uint8, n)
		w.fogRadar[s] = make([]uint8, n)
		w.fogSeen[s] = make([]uint8, n)
	}
}

// stampFogGrids re-rasterises the per-side sight and radar circles into the
// fog layers for the render lane. The live sight/radar layers are cleared and
// rebuilt each tick; the explored layer accumulates (a cell seen once stays
// mapped). No-op when no map is installed.
func (w *World) stampFogGrids() {
	if w.fogCols == 0 {
		return
	}
	for s := 0; s < maxSides; s++ {
		if len(w.sightSrc[s]) == 0 && len(w.radarSrc[s]) == 0 {
			// Clear this side's live layers so a wiped-out army leaves no
			// stale sight (explored persists).
			clearBytes(w.fogSight[s])
			clearBytes(w.fogRadar[s])
			continue
		}
		clearBytes(w.fogSight[s])
		clearBytes(w.fogRadar[s])
		for i := range w.sightSrc[s] {
			src := &w.sightSrc[s][i]
			w.stampCircle(w.fogSight[s], w.fogSeen[s], src.pos, src.sight)
		}
		for i := range w.radarSrc[s] {
			src := &w.radarSrc[s][i]
			if src.radar > 0 {
				w.stampCircle(w.fogRadar[s], nil, src.pos, src.radar)
			}
			if src.sonar > 0 {
				w.stampCircle(w.fogRadar[s], nil, src.pos, src.sonar)
			}
		}
	}
}

// stampCircle marks every LOS cell whose centre lies within radius r of the
// world point into live (set to 1) and, when non-nil, the sticky explored
// layer. Cells are addressed on the straight XZ grid.
func (w *World) stampCircle(live, seen []uint8, at fixed.Vec2, r fixed.Fixed) {
	if r <= 0 {
		return
	}
	rWU := r.Int()
	cx := at.X.Int()
	cz := at.Z.Int()
	minCol := (cx - rWU) / losCellWU
	maxCol := (cx + rWU) / losCellWU
	minRow := (cz - rWU) / losCellWU
	maxRow := (cz + rWU) / losCellWU
	if minCol < 0 {
		minCol = 0
	}
	if minRow < 0 {
		minRow = 0
	}
	if maxCol >= w.fogCols {
		maxCol = w.fogCols - 1
	}
	if maxRow >= w.fogRows {
		maxRow = w.fogRows - 1
	}
	rr := int64(rWU) * int64(rWU)
	for row := minRow; row <= maxRow; row++ {
		centreZ := int64(row*losCellWU + losCellWU/2)
		dz := centreZ - int64(cz)
		for col := minCol; col <= maxCol; col++ {
			centreX := int64(col*losCellWU + losCellWU/2)
			dx := centreX - int64(cx)
			if dx*dx+dz*dz > rr {
				continue
			}
			idx := row*w.fogCols + col
			live[idx] = 1
			if seen != nil {
				seen[idx] = 1
			}
		}
	}
}

// clearBytes zeroes a fog layer between rebuilds.
func clearBytes(b []uint8) {
	for i := range b {
		b[i] = 0
	}
}

// VisibleToSide reports whether a unit is in a side's true line of sight as of
// the last stepped tick (a harness / render-side query). It reads the
// per-unit mask updateSight stamped, so a Step must have run.
func (w *World) VisibleToSide(side int, id uint32) bool {
	u := w.units[id]
	if u == nil || side < 0 || side >= maxSides {
		return false
	}
	return u.Side == side || u.visibleMask&(1<<uint(side)) != 0
}

// DetectedBySide reports whether a unit registers on a side's radar/sonar (a
// blip — position without identity) as of the last stepped tick. A unit that
// is fully visible is not additionally reported as merely detected.
func (w *World) DetectedBySide(side int, id uint32) bool {
	u := w.units[id]
	if u == nil || side < 0 || side >= maxSides {
		return false
	}
	return u.detectedMask&(1<<uint(side)) != 0
}
