package studio

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/maplint"
)

// qualityIssue is the JSON shape the studio Quality Checker dialog
// renders.  It mirrors maplint.Diagnostic but layers on the auto-fix
// metadata the dialog needs (CanAutoFix + Fix id).
type qualityIssue struct {
	Check      string `json:"check"`
	Label      string `json:"label"`
	Severity   string `json:"severity"`
	Message    string `json:"message"`
	CanAutoFix bool   `json:"canAutoFix"`
	Fix        string `json:"fix,omitempty"`
}

// runQualityChecks builds a maplint.Input from the studio's
// saveRequest, runs the shared rule set, and then decorates the
// dialog-bound results with auto-fix metadata.
func runQualityChecks(m *tnt.Map, req saveRequest, applied []string) []qualityIssue {
	in := buildMaplintInput(m, req, applied)
	diags := maplint.Run(in)
	out := make([]qualityIssue, 0, len(diags))
	for _, d := range diags {
		out = append(out, wrapDiagnostic(d))
	}
	return out
}

// buildMaplintInput converts the studio's saveRequest + parsed tnt.Map
// into the neutral structs maplint operates on.
func buildMaplintInput(m *tnt.Map, req saveRequest, applied []string) maplint.Input {
	in := maplint.Input{Map: m, AppliedFixes: append([]string(nil), applied...)}

	if req.OTA != nil {
		schemas := make([]maplint.SchemaInfo, 0, len(req.OTA.Schemas))
		for _, s := range req.OTA.Schemas {
			sps := make([]maplint.StartPos, 0, len(s.StartPos))
			for _, sp := range s.StartPos {
				sps = append(sps, maplint.StartPos{Number: sp.Number, X: sp.X, Z: sp.Z})
			}
			schemas = append(schemas, maplint.SchemaInfo{
				Name:         s.Name,
				Type:         s.Type,
				SurfaceMetal: s.SurfaceMetal,
				StartPos:     sps,
			})
		}
		in.OTA = &maplint.OTAInfo{
			MissionName:        req.OTA.MissionName,
			MissionDescription: req.OTA.MissionDescription,
			Planet:             req.OTA.Planet,
			NumPlayers:         req.OTA.NumPlayers,
			Size:               req.OTA.Size,
			SeaLevel:           req.OTA.SeaLevel,
			Schemas:            schemas,
		}
	}

	if len(req.Features) > 0 {
		fs := make([]maplint.FeaturePlacement, 0, len(req.Features))
		for _, f := range req.Features {
			fs = append(fs, maplint.FeaturePlacement{Name: f.Name, AX: f.AX, AY: f.AY})
		}
		in.Features = fs
	}

	// Feature → metal registry from the VFS feature catalog.  Only
	// names that actually have a non-zero `metal=` are interesting to
	// the metal-proximity check.
	_, byName := scanFeatures()
	if len(byName) > 0 {
		reg := make(map[string]int, len(byName))
		for k, v := range byName {
			if v.Metal > 0 {
				reg[strings.ToLower(k)] = v.Metal
			}
		}
		if len(reg) > 0 {
			in.FeatureRegistry = reg
		}
	}
	return in
}

// wrapDiagnostic turns a maplint.Diagnostic into the JSON shape the
// dialog speaks, adding auto-fix routing for rules the studio knows
// how to fix.
func wrapDiagnostic(d maplint.Diagnostic) qualityIssue {
	q := qualityIssue{
		Check:    d.ID,
		Label:    d.Label,
		Severity: string(d.Severity),
		Message:  d.Message,
	}
	if d.ID == "dedupTiles" && d.Severity == maplint.SeverityWarning {
		q.CanAutoFix = true
		q.Fix = "compressTiles"
	}
	return q
}

// ── HTTP entry ─────────────────────────────────────────────────────────────

// handleQualityCheck runs every quality check against a build of the
// supplied saveRequest and returns the result list.
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
