package studio

// pack_weapons.go — the weapons.json side of a pack (format v3).
//
// A replayer that sees a WeaponFire event only knows the firing unit and the
// weapon SLOT; unitdb.json's per-unit weapons array maps that slot to a weapon
// id, and weapons.json maps the id to the handful of fields a renderer needs
// to draw the shot (render type, beam colours, projectile model, velocity,
// beam duration).  The catalogue deliberately carries far less than the
// per-unit meta blocks — it is the global "how does this weapon look" table,
// not a stats database.

import (
	"strings"

	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/tdf"
)

// packWeaponJSON is one weapons.json entry.  Colour fields are resolved
// palette RGB triples (0-255), not raw indices, so a client never needs the
// palette to tint a beam.  Pointer-typed so "the TDF has no color=" and
// "palette index 0" stay distinguishable in the output.
type packWeaponJSON struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	RenderType int    `json:"renderType"`
	// Color / Color2 are the TDF color=/color2= palette indices resolved
	// against the install palette; absent when the TDF omits the field.
	Color  *[3]int `json:"color,omitempty"`
	Color2 *[3]int `json:"color2,omitempty"`
	// DurationSec is the beam/shot lifetime (TDF duration=); zero means the
	// weapon doesn't specify one and is omitted.
	DurationSec float64 `json:"durationSec,omitempty"`
	// VelocityWU / StartVelocityWU are world units per second, the same raw
	// weaponvelocity/startvelocity numbers the per-unit meta exposes.
	VelocityWU      float64 `json:"velocityWU"`
	StartVelocityWU float64 `json:"startVelocityWU,omitempty"`
	// Model is the projectile 3DO name (lower-case), when the weapon flies
	// a mesh rather than a beam/sprite.
	Model      string `json:"model,omitempty"`
	BeamWeapon bool   `json:"beamWeapon,omitempty"`
}

// packWeaponsFileJSON is the weapons.json document shape.  A JSON object
// keyed by lower-case weapon id — encoding/json emits map keys sorted, which
// keeps the file deterministic for the pack content hash.
type packWeaponsFileJSON struct {
	Weapons map[string]packWeaponJSON `json:"weapons"`
}

// packWeaponColorProbe re-reads a weapon section with pointer fields so we
// can tell "color= absent" apart from "color=0" — the typed ta.Weapon uses
// plain ints where both collapse to zero.
type packWeaponColorProbe struct {
	Key    string `tdf:",name"`
	Color  *int   `tdf:"color"`
	Color2 *int   `tdf:"color2"`
}

// buildPackWeaponCatalog enumerates every weapon section in every
// weapons/*.tdf in the VFS (the TDF section header IS the weapon id) and
// returns the id → render-fields catalogue.  Duplicate ids keep the first
// definition encountered, matching how loadWeaponSection resolves per-unit
// refs, so unitdb weapon slots and this catalogue always agree.
func (sess *Session) buildPackWeaponCatalog() map[string]packWeaponJSON {
	pal := sess.paletteRGB()
	out := map[string]packWeaponJSON{}
	for _, p := range sess.vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "weapons/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		data, err := sess.vfs.ReadFile(p)
		if err != nil {
			continue
		}
		var weapons []ta.Weapon
		if err := tdf.Unmarshal(data, &weapons); err != nil {
			continue
		}
		// Field-presence probe over the same sections, keyed by id so we
		// don't depend on the two decodes staying index-aligned.
		colorProbe := map[string]packWeaponColorProbe{}
		var probes []packWeaponColorProbe
		if err := tdf.Unmarshal(data, &probes); err == nil {
			for _, pr := range probes {
				id := strings.ToLower(strings.TrimSpace(pr.Key))
				if _, dup := colorProbe[id]; !dup {
					colorProbe[id] = pr
				}
			}
		}
		for i := range weapons {
			sec := &weapons[i]
			id := strings.ToLower(strings.TrimSpace(sec.Key))
			if id == "" {
				continue
			}
			if _, dup := out[id]; dup {
				continue // first definition wins, as in loadWeaponSection
			}
			w := packWeaponJSON{
				ID:              id,
				Name:            strings.TrimSpace(sec.Name),
				RenderType:      sec.RenderType,
				DurationSec:     sec.Duration,
				VelocityWU:      sec.WeaponVelocity,
				StartVelocityWU: sec.StartVelocity,
				Model:           strings.ToLower(strings.TrimSpace(sec.Model)),
				BeamWeapon:      sec.BeamWeapon != 0,
			}
			if pr, ok := colorProbe[id]; ok {
				if pr.Color != nil {
					w.Color = paletteTriple(pal, *pr.Color)
				}
				if pr.Color2 != nil {
					w.Color2 = paletteTriple(pal, *pr.Color2)
				}
			}
			out[id] = w
		}
	}
	return out
}

// paletteTriple resolves a palette index to its RGB triple, or nil for an
// out-of-range index (dirty mod data) so the JSON field is simply omitted.
func paletteTriple(pal [][3]int, idx int) *[3]int {
	if idx < 0 || idx >= len(pal) {
		return nil
	}
	c := pal[idx]
	return &c
}
