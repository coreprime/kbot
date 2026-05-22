package studio

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/tnt"
)

// Sentinels + thresholds shared by the checks.  Documented here so a
// future tuner can find them in one place.
const (
	// voidFeatureLow / voidFeatureHigh — TA marks impassable / void
	// attribute cells with one of two sentinels in TileAttr.Feature.
	// 0xFFFF means "no feature, passable".
	voidFeatureLow  = uint16(0xFFFC)
	voidFeatureHigh = uint16(0xFFFE)

	// metalProximityTiles — a start position is flagged when its
	// nearest metal-producing feature is further than this many
	// tiles (1 tile = 32 game-pixels, 1 attribute cell = 16 px).
	// 24 tiles ≈ 1.5× commander beam reach, generous early-game
	// expansion range.
	metalProximityTiles = 24

	// heightDiscontinuityThreshold — adjacent attribute cells with
	// |Δheight| beyond this read as cliffs that walking units
	// can't traverse.  TA's units can step ~16 height per attr
	// cell; 32 is double that and a reliable "this looks broken"
	// floor.
	heightDiscontinuityThreshold = 32
)

// qualityIssue is one row in the Quality Checker dialog.  Severity is
// a coarse traffic-light: "ok" (green tick), "warning" (yellow, save
// proceeds with confirmation), or "error" (red, blocks save).  When
// CanAutoFix is true the Fix field names the saveRequest.Fixes id the
// client should add to clear the issue.
type qualityIssue struct {
	Check      string `json:"check"`
	Label      string `json:"label"`
	Severity   string `json:"severity"`
	Message    string `json:"message"`
	CanAutoFix bool   `json:"canAutoFix"`
	Fix        string `json:"fix,omitempty"`
}

// runQualityChecks inspects the built map and returns one issue per
// check.  The order matches the order the client renders rows; keep it
// stable so the Fix-then-rerun cycle doesn't shuffle results under the
// user's cursor.
func runQualityChecks(m *tnt.Map, req saveRequest, applied []string) []qualityIssue {
	return []qualityIssue{
		checkDuplicateTiles(m, applied),
		checkMissingOTAFields(req),
		checkStartPositionsInBounds(m, req),
		checkSchemaSlotsVsPlayers(req),
		checkMetalProximity(req),
		checkVoidIslands(m, req),
		checkHeightDiscontinuities(m),
	}
}

// checkDuplicateTiles flags any byte-identical entries in the TNT
// tile pool.  When the "compressTiles" fix has already been applied
// the pool is dedup-by-construction, so we shortcut to OK without
// re-hashing.
func checkDuplicateTiles(m *tnt.Map, applied []string) qualityIssue {
	const fixID = "compressTiles"
	for _, f := range applied {
		if f == fixID {
			return qualityIssue{
				Check:    "dedupTiles",
				Label:    "Deduplicate Tiles",
				Severity: "ok",
				Message:  fmt.Sprintf("All %d tiles are unique.", len(m.Tiles)),
			}
		}
	}
	seen := make(map[[1024]byte]bool, len(m.Tiles))
	dups := 0
	for _, t := range m.Tiles {
		if len(t) < 1024 {
			continue
		}
		var key [1024]byte
		copy(key[:], t)
		if seen[key] {
			dups++
		} else {
			seen[key] = true
		}
	}
	if dups == 0 {
		return qualityIssue{
			Check:    "dedupTiles",
			Label:    "Deduplicate Tiles",
			Severity: "ok",
			Message:  fmt.Sprintf("All %d tiles are unique.", len(m.Tiles)),
		}
	}
	return qualityIssue{
		Check:      "dedupTiles",
		Label:      "Deduplicate Tiles",
		Severity:   "warning",
		Message:    fmt.Sprintf("%d duplicate tiles. Compress to %d distinct.", dups, len(seen)),
		CanAutoFix: true,
		Fix:        fixID,
	}
}

// ── Map-geometry checks ────────────────────────────────────────────────────

// checkStartPositionsInBounds confirms every schema's start positions
// land on a passable attribute cell that's inside the map.  Cells
// outside the bounds or sitting on a void marker get flagged — the
// commander spawns there and the game silently strands him on
// unreachable terrain.
func checkStartPositionsInBounds(m *tnt.Map, req saveRequest) qualityIssue {
	const id = "startsInBounds"
	const label = "Reachable Start Positions"
	if req.OTA == nil || len(req.OTA.Schemas) == 0 {
		return ok(id, label, "No schemas to check.")
	}
	attrW, attrH := m.AttrW, m.AttrH
	var bad []string
	for si, s := range req.OTA.Schemas {
		for _, sp := range s.StartPos {
			ax := sp.X / 16
			ay := sp.Z / 16
			if ax < 0 || ay < 0 || ax >= attrW || ay >= attrH {
				bad = append(bad, fmt.Sprintf("Schema %d / StartPos%d (out of bounds)", si+1, sp.Number))
				continue
			}
			a := m.TileAttr[ay*attrW+ax]
			if a.Feature == voidFeatureLow || a.Feature == voidFeatureHigh {
				bad = append(bad, fmt.Sprintf("Schema %d / StartPos%d (in void)", si+1, sp.Number))
			}
		}
	}
	if len(bad) == 0 {
		return ok(id, label, "Every start position lands on passable ground.")
	}
	return qualityIssue{
		Check: id, Label: label, Severity: "warning",
		Message: fmt.Sprintf("%d unreachable: %s", len(bad), joinTop(bad, 3)),
	}
}

// checkMetalProximity walks each start position and finds the
// distance to its nearest metal-producing feature.  Anything past
// the metalProximityTiles radius gets flagged — the commander can't
// reach metal in the opening seconds and the player has a stunted
// economy.
func checkMetalProximity(req saveRequest) qualityIssue {
	const id = "metalProximity"
	const label = "Metal Near Starts"
	if req.OTA == nil || len(req.OTA.Schemas) == 0 {
		return ok(id, label, "No schemas to check.")
	}
	_, byName := scanFeatures()
	if len(byName) == 0 {
		return skip(id, label, "Feature library unavailable.")
	}
	type pt struct{ x, y float64 }
	var metals []pt
	for _, f := range req.Features {
		entry, found := byName[strings.ToLower(f.Name)]
		if !found || entry.Metal <= 0 {
			continue
		}
		// Attribute cells → tile units (1 tile = 2 attr cells).
		metals = append(metals, pt{x: float64(f.AX) / 2, y: float64(f.AY) / 2})
	}
	if len(metals) == 0 {
		return qualityIssue{
			Check: id, Label: label, Severity: "warning",
			Message: "No metal-producing features placed anywhere on the map.",
		}
	}
	limitSq := float64(metalProximityTiles * metalProximityTiles)
	var bad []string
	for si, s := range req.OTA.Schemas {
		for _, sp := range s.StartPos {
			// Game pixels → tile units (1 tile = 32 px).
			sx := float64(sp.X) / 32
			sy := float64(sp.Z) / 32
			nearestSq := math.MaxFloat64
			for _, m := range metals {
				dx := sx - m.x
				dy := sy - m.y
				d := dx*dx + dy*dy
				if d < nearestSq {
					nearestSq = d
				}
			}
			if nearestSq > limitSq {
				bad = append(bad, fmt.Sprintf("Schema %d / StartPos%d (%dt away)", si+1, sp.Number, int(math.Sqrt(nearestSq))))
			}
		}
	}
	if len(bad) == 0 {
		return ok(id, label, fmt.Sprintf("All starts have metal within %d tiles.", metalProximityTiles))
	}
	return qualityIssue{
		Check: id, Label: label, Severity: "warning",
		Message: fmt.Sprintf("%d short on metal: %s", len(bad), joinTop(bad, 3)),
	}
}

// checkVoidIslands flood-fills from every start position over the
// passable attribute grid and counts how many passable cells the
// fill never reached.  Those are land masses the player can build
// out onto but can't traverse to — typically unintentional.
func checkVoidIslands(m *tnt.Map, req saveRequest) qualityIssue {
	const id = "voidIslands"
	const label = "Connected Land"
	if req.OTA == nil || len(req.OTA.Schemas) == 0 {
		return ok(id, label, "No schemas to check.")
	}
	w, h := m.AttrW, m.AttrH
	passable := make([]bool, w*h)
	totalPassable := 0
	for i, a := range m.TileAttr {
		if a.Feature != voidFeatureLow && a.Feature != voidFeatureHigh {
			passable[i] = true
			totalPassable++
		}
	}
	visited := make([]bool, w*h)
	queue := make([]int, 0, 256)
	push := func(ax, ay int) {
		if ax < 0 || ay < 0 || ax >= w || ay >= h {
			return
		}
		idx := ay*w + ax
		if !passable[idx] || visited[idx] {
			return
		}
		visited[idx] = true
		queue = append(queue, idx)
	}
	for _, s := range req.OTA.Schemas {
		for _, sp := range s.StartPos {
			push(sp.X/16, sp.Z/16)
		}
	}
	for len(queue) > 0 {
		idx := queue[0]
		queue = queue[1:]
		ax := idx % w
		ay := idx / w
		push(ax+1, ay)
		push(ax-1, ay)
		push(ax, ay+1)
		push(ax, ay-1)
	}
	stranded := 0
	for i := range passable {
		if passable[i] && !visited[i] {
			stranded++
		}
	}
	if stranded == 0 {
		return ok(id, label, "All passable cells are reachable from a start.")
	}
	pct := 0.0
	if totalPassable > 0 {
		pct = float64(stranded) * 100 / float64(totalPassable)
	}
	return qualityIssue{
		Check: id, Label: label, Severity: "warning",
		Message: fmt.Sprintf("%d cells (%.1f%%) stranded behind voids — unreachable from any start.", stranded, pct),
	}
}

// checkHeightDiscontinuities counts adjacent attribute cell pairs
// whose height delta exceeds heightDiscontinuityThreshold.  These
// cliff-like transitions block ground pathing — usually a mistake
// from import-bmp / brush-edit artifacts rather than intentional
// terrain.
func checkHeightDiscontinuities(m *tnt.Map) qualityIssue {
	const id = "heightDiscontinuities"
	const label = "Heightmap Smoothness"
	w, h := m.AttrW, m.AttrH
	if w == 0 || h == 0 {
		return skip(id, label, "Empty heightmap.")
	}
	cliffs := 0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			cur := int(m.TileAttr[y*w+x].Height)
			if x+1 < w {
				d := cur - int(m.TileAttr[y*w+x+1].Height)
				if d < 0 {
					d = -d
				}
				if d > heightDiscontinuityThreshold {
					cliffs++
				}
			}
			if y+1 < h {
				d := cur - int(m.TileAttr[(y+1)*w+x].Height)
				if d < 0 {
					d = -d
				}
				if d > heightDiscontinuityThreshold {
					cliffs++
				}
			}
		}
	}
	if cliffs == 0 {
		return ok(id, label, fmt.Sprintf("No cliff edges over %d height units.", heightDiscontinuityThreshold))
	}
	return qualityIssue{
		Check: id, Label: label, Severity: "warning",
		Message: fmt.Sprintf("%d cliff edges over %d height units — may block ground pathing.", cliffs, heightDiscontinuityThreshold),
	}
}

// ── OTA / schema checks ────────────────────────────────────────────────────

// checkMissingOTAFields runs through the small set of OTA strings the
// in-game lobby will display and flags any that are blank.  These get
// silently defaulted at save time today, but a player browsing the
// lobby sees the defaulted name rather than the author's intent.
func checkMissingOTAFields(req saveRequest) qualityIssue {
	const id = "otaFields"
	const label = "Required Metadata"
	missing := []string{}
	if req.OTA == nil {
		return qualityIssue{
			Check: id, Label: label, Severity: "warning",
			Message: "No .ota metadata supplied.",
		}
	}
	push := func(name, val string) {
		if strings.TrimSpace(val) == "" {
			missing = append(missing, name)
		}
	}
	push("Mission name", req.OTA.MissionName)
	push("Description", req.OTA.MissionDescription)
	push("Planet", req.OTA.Planet)
	push("Players supported", req.OTA.NumPlayers)
	push("Size", req.OTA.Size)
	if len(req.OTA.Schemas) == 0 {
		missing = append(missing, "At least one schema")
	}
	if len(missing) == 0 {
		return ok(id, label, "Mission name, planet, size, and schemas all set.")
	}
	return qualityIssue{
		Check: id, Label: label, Severity: "warning",
		Message: "Missing: " + strings.Join(missing, ", "),
	}
}

// checkSchemaSlotsVsPlayers verifies each schema has enough start
// positions to satisfy the highest player count listed in
// OTA.NumPlayers.  e.g. a "2, 3, 4" lobby string with a schema that
// only carries 2 starts won't open a 4-player game cleanly.
func checkSchemaSlotsVsPlayers(req saveRequest) qualityIssue {
	const id = "schemaSlots"
	const label = "Schema Player Slots"
	if req.OTA == nil || len(req.OTA.Schemas) == 0 {
		return ok(id, label, "No schemas to check.")
	}
	maxPlayers := parseMaxPlayers(req.OTA.NumPlayers)
	if maxPlayers <= 0 {
		// numplayers blank — covered by checkMissingOTAFields; here
		// we still confirm every schema has at least one start.
		var thin []string
		for i, s := range req.OTA.Schemas {
			if len(s.StartPos) == 0 {
				thin = append(thin, fmt.Sprintf("Schema %d", i+1))
			}
		}
		if len(thin) == 0 {
			return ok(id, label, "Every schema has at least one start position.")
		}
		return qualityIssue{
			Check: id, Label: label, Severity: "warning",
			Message: "Schemas with zero starts: " + strings.Join(thin, ", "),
		}
	}
	var thin []string
	for i, s := range req.OTA.Schemas {
		if len(s.StartPos) < maxPlayers {
			thin = append(thin, fmt.Sprintf("Schema %d (%d/%d)", i+1, len(s.StartPos), maxPlayers))
		}
	}
	if len(thin) == 0 {
		return ok(id, label, fmt.Sprintf("Every schema supports up to %d players.", maxPlayers))
	}
	return qualityIssue{
		Check: id, Label: label, Severity: "warning",
		Message: fmt.Sprintf("Need %d starts per schema: %s", maxPlayers, strings.Join(thin, ", ")),
	}
}

// parseMaxPlayers pulls the largest integer out of a comma-list
// like "2, 3, 4" (TA's typical numplayers format).  Returns 0 when
// the string contains no numbers — callers treat that as "no limit
// declared, just sanity-check non-emptiness".
func parseMaxPlayers(s string) int {
	max := 0
	for _, tok := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == ';' }) {
		n, err := strconv.Atoi(strings.TrimSpace(tok))
		if err != nil {
			continue
		}
		if n > max {
			max = n
		}
	}
	return max
}

// ── Small shared helpers ───────────────────────────────────────────────────

func ok(id, label, msg string) qualityIssue {
	return qualityIssue{Check: id, Label: label, Severity: "ok", Message: msg}
}

func skip(id, label, msg string) qualityIssue {
	return qualityIssue{Check: id, Label: label, Severity: "ok", Message: msg}
}

// joinTop renders the first n entries of items into "A, B, C, +N more"
// so warning rows stay readable even when there are dozens of hits.
func joinTop(items []string, n int) string {
	if len(items) <= n {
		return strings.Join(items, ", ")
	}
	return strings.Join(items[:n], ", ") + fmt.Sprintf(", +%d more", len(items)-n)
}

// ── HTTP entry ─────────────────────────────────────────────────────────────

// handleQualityCheck runs every quality check against a build of the
// supplied saveRequest and returns the result list.  The client uses
// this to populate its Quality Checker dialog and to discover which
// fix ids it should add to req.Fixes before re-checking or saving.
func handleQualityCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	if !sameOrigin(r) {
		http.Error(w, "cross-origin POST refused", http.StatusForbidden)
		return
	}
	var req saveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.TileW <= 0 || req.TileH <= 0 {
		http.Error(w, "tileW and tileH must be positive", http.StatusBadRequest)
		return
	}
	m, _, err := buildMap(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("build failed: %v", err), http.StatusInternalServerError)
		return
	}
	issues := runQualityChecks(m, req, req.Fixes)
	allOK := true
	for _, i := range issues {
		if i.Severity != "ok" {
			allOK = false
			break
		}
	}
	writeJSON(w, map[string]any{"issues": issues, "allOk": allOK})
}
