package studio

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/coreprime/kbot/formats/tnt"
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
func runQualityChecks(m *tnt.Map, applied []string) []qualityIssue {
	return []qualityIssue{
		checkDuplicateTiles(m, applied),
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
	issues := runQualityChecks(m, req.Fixes)
	allOK := true
	for _, i := range issues {
		if i.Severity != "ok" {
			allOK = false
			break
		}
	}
	writeJSON(w, map[string]any{"issues": issues, "allOk": allOK})
}
