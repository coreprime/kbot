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
	"sort"
	"strings"

	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/gamedata/tak"
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
	// ColorIdx / Color2Idx are the RAW color=/color2= values (format v4).
	// A renderer needs the raw index for two things the resolved triple
	// can't do: palette-driven beam tints through its own palette, and the
	// rendertype=4 sprite SLOT (where color= selects an fx.gaf sequence,
	// not a tint).  Pointer-typed for the same absence/zero distinction.
	ColorIdx  *int `json:"colorIdx,omitempty"`
	Color2Idx *int `json:"color2Idx,omitempty"`
	// DurationSec is the beam/shot lifetime (TDF duration=); zero means the
	// weapon doesn't specify one and is omitted.
	DurationSec float64 `json:"durationSec,omitempty"`
	// VelocityWU / StartVelocityWU are world units per second, the same raw
	// weaponvelocity/startvelocity numbers the per-unit meta exposes.
	VelocityWU      float64 `json:"velocityWU"`
	StartVelocityWU float64 `json:"startVelocityWU,omitempty"`
	// Model is the projectile 3DO name (lower-case), when the weapon flies
	// a mesh rather than a beam/sprite.  Format v4 packs the named mesh at
	// models/<model>.json so replay drivers can fly the real projectile.
	Model      string `json:"model,omitempty"`
	BeamWeapon bool   `json:"beamWeapon,omitempty"`

	// Trajectory + muzzle/impact presentation fields (format v4) — the rest
	// of what a renderer needs to reproduce the weapon's look from the id
	// alone: ballistic arcs, missile smoke trails and their cadence, the
	// muzzle startsmoke puff, the D-Gun's commandfire identity, blast
	// diameter for impact sizing, and range for time-of-flight.
	Ballistic      bool    `json:"ballistic,omitempty"`
	Dropped        bool    `json:"dropped,omitempty"`
	Guidance       bool    `json:"guidance,omitempty"`
	SmokeTrail     bool    `json:"smokeTrail,omitempty"`
	SmokeDelaySec  float64 `json:"smokeDelaySec,omitempty"`
	StartSmoke     bool    `json:"startSmoke,omitempty"`
	CommandFire    bool    `json:"commandFire,omitempty"`
	AreaOfEffectWU float64 `json:"areaOfEffectWU,omitempty"`
	RangeWU        float64 `json:"rangeWU,omitempty"`
	// Guided-flight + water fields (format v5).  TurnRate is the raw TDF
	// turnrate= in TA angle units per second (65536 = a full circle) — a
	// renderer steering a guided missile converts to rad/s.  WaterWeapon
	// marks torpedoes (run at/below the waterline; impacts splash).
	// AccelerationWU (wu/s²) and FlightTimeSec bound a self-propelled
	// shot's spin-up and powered flight.
	TurnRate       int     `json:"turnRate,omitempty"`
	WaterWeapon    bool    `json:"waterWeapon,omitempty"`
	AccelerationWU float64 `json:"accelerationWU,omitempty"`
	FlightTimeSec  float64 `json:"flightTimeSec,omitempty"`
	// VLaunch marks a vertical-launch missile (TDF vlaunch=1): the shot
	// leaves the tube pointing straight up, climbs on its start velocity /
	// acceleration, and only then turns onto the target under guidance.
	// A renderer needs it to reproduce the launch silhouette (the Wombat's
	// rocket rises before curving over); without it the missile draws a flat
	// diagonal from launcher to target. WeaponTimerSec bounds the climb-then-
	// turn handover (TDF weapontimer=, seconds).
	VLaunch        bool    `json:"vlaunch,omitempty"`
	WeaponTimerSec float64 `json:"weaponTimerSec,omitempty"`
	// SoundStart / SoundHit are the fire/impact wav stems (sounds/<stem>.wav
	// in the pack — format v4 packs the whole catalogue's sounds).
	SoundStart string `json:"soundStart,omitempty"`
	SoundHit   string `json:"soundHit,omitempty"`
	// EffectClass (format v8) is the per-weapon presentation class a renderer
	// gates light/glow decisions on, derived from each game's own weapon
	// data — TA's rendertype (+ ballistic flag), TA:K's type=/nimbus=/
	// lightmap=/hweffect=/damagetype= fields.  Values: "beam", "lightning",
	// "plasma", "flame", "missile", "ballistic", "fire", "magic", "physical",
	// "melee".  Physical shots (arrows / stones / bolts) must never emit
	// light; fire/magic glow warm; beams/plasma keep their energy look.
	EffectClass string `json:"effectClass,omitempty"`
	// TakType is the raw TA:K weapon type= ("ballistic", "guided", "line of
	// sight", "remote effect", "melee", "wandering"), lower-case; absent for
	// TA packs.  Its presence also tells a renderer the TurnRate field is on
	// TA:K's scale (stock data 180..360 per guided weapon) rather than TA's
	// 65536-per-circle angle units (stock data 10000..32768).
	TakType string `json:"takType,omitempty"`
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
				Ballistic:       sec.Ballistic != 0,
				Dropped:         sec.Dropped != 0,
				Guidance:        sec.Guidance != 0,
				SmokeTrail:      sec.SmokeTrail != 0,
				SmokeDelaySec:   sec.SmokeDelay,
				StartSmoke:      sec.StartSmoke != 0,
				CommandFire:     sec.CommandFire != 0,
				AreaOfEffectWU:  float64(sec.AreaOfEffect),
				RangeWU:         float64(sec.Range),
				TurnRate:        sec.TurnRate,
				WaterWeapon:     sec.WaterWeapon != 0,
				AccelerationWU:  sec.WeaponAcceleration,
				FlightTimeSec:   sec.FlightTime,
				VLaunch:         sec.VLaunch != 0,
				WeaponTimerSec:  sec.WeaponTimer,
				SoundStart:      strings.ToLower(strings.TrimSpace(sec.SoundStart)),
				SoundHit:        strings.ToLower(strings.TrimSpace(sec.SoundHit)),
			}
			if pr, ok := colorProbe[id]; ok {
				if pr.Color != nil {
					w.Color = paletteTriple(pal, *pr.Color)
					w.ColorIdx = pr.Color
				}
				if pr.Color2 != nil {
					w.Color2 = paletteTriple(pal, *pr.Color2)
					w.Color2Idx = pr.Color2
				}
			}
			w.EffectClass = taEffectClass(sec)
			out[id] = w
		}
	}
	// TA:Kingdoms defines its weapons as inline [WEAPONn] sections inside
	// each unit FBI instead of weapons/*.tdf, so the scan above finds
	// nothing for a TA:K install.  Sweep the FBIs too — a TA install's
	// FBIs carry no [WEAPONn] sections, so this is a no-op there.
	sess.appendFBIWeaponCatalog(out)
	return out
}

// taEffectClass derives the presentation class for a TA weapon from its
// rendertype — the same field the engine's projectile draw dispatches on —
// plus the ballistic flag for the bitmap-sprite class.  Weapons that ship no
// usable rendertype (rendertype 0 without beamweapon=1 reads as "field
// omitted") return "" so a renderer keeps its own fallback classification.
func taEffectClass(sec *ta.Weapon) string {
	switch sec.RenderType {
	case 0:
		// 0 draws the instant twin-line beam; every stock rendertype=0
		// weapon also ships beamweapon=1, which is how "0" is told apart
		// from "field omitted" (feature pseudo-weapons like TREEBURN).
		if sec.BeamWeapon == 0 {
			return ""
		}
		return "beam"
	case 2:
		// MINDGUN: the engine draws only a radar blip for it — classed
		// with the beams, matching how the catalogue's one specimen is
		// presented today.
		return "beam"
	case 1:
		return "missile" // 3DO projectile with the smoke-trail flight
	case 3:
		return "plasma" // D-gun energy ball
	case 4:
		// Artist-drawn fx.gaf sprite bolt: an arcing round reads as a
		// shell, a straight one as an energy bolt.
		if sec.Ballistic != 0 {
			return "ballistic"
		}
		return "plasma"
	case 5:
		return "flame"
	case 6:
		return "ballistic" // gravity bomb
	case 7:
		return "lightning"
	}
	return ""
}

// takEffectClass derives the presentation class for a TA:K inline weapon
// from the fields the engine itself dispatches on: type= picks the handler
// (melee / ballistic / guided / line of sight / remote effect / wandering)
// and the fire/lightning emitter fields (hweffect=, subtype=, damagetype=,
// firestarter=) plus the glow markers (nimbus=, lightmap=) split the magic
// from the mundane.  Anything with none of those markers is a plain physical
// object — arrow, bolt, stone — and must render unlit.
func takEffectClass(sec *tak.Weapon) string {
	typ := strings.ToLower(strings.TrimSpace(sec.Type))
	sub := strings.ToLower(strings.TrimSpace(sec.SubType))
	hw := strings.ToLower(strings.TrimSpace(sec.HwEffect))
	if typ == "melee" {
		return "melee"
	}
	if strings.Contains(hw, "lightning") || strings.Contains(hw, "lightbeam") || sub == "lightning" {
		return "lightning"
	}
	if hw == "fire" || sub == "fire" || sub == "bluefire" || sub == "dieselflame" ||
		strings.EqualFold(strings.TrimSpace(sec.DamageType), "fire") || sec.FireStarter > 0 {
		return "fire"
	}
	if sec.Nimbus != 0 || strings.TrimSpace(sec.LightMap) != "" || hw != "" ||
		typ == "remote effect" || typ == "wandering" {
		return "magic"
	}
	return "physical"
}

// appendFBIWeaponCatalog adds every inline [WEAPONn] section found in
// units/*.fbi to the catalogue, keyed by lower-case weapon name= — the same
// key the unitdb per-unit weapons array carries for TA:K (see the slot loop
// in buildPack).  First definition wins, matching the TDF scan above; the
// VFS walk is sorted so the winner is deterministic.
func (sess *Session) appendFBIWeaponCatalog(out map[string]packWeaponJSON) {
	paths := make([]string, 0)
	for _, p := range sess.vfs.List() {
		lower := strings.ToLower(p)
		if strings.HasPrefix(lower, "units/") && strings.HasSuffix(lower, ".fbi") {
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	for _, p := range paths {
		data, err := sess.vfs.ReadFile(p)
		if err != nil {
			continue
		}
		var ku tak.Unit
		if err := tdf.Unmarshal(data, &ku); err != nil {
			continue
		}
		for _, sec := range []*tak.Weapon{ku.Weapon1, ku.Weapon2, ku.Weapon3} {
			if sec == nil {
				continue
			}
			id := strings.ToLower(strings.TrimSpace(sec.Name))
			if id == "" {
				continue
			}
			if _, dup := out[id]; dup {
				continue
			}
			typ := strings.ToLower(strings.TrimSpace(sec.Type))
			w := packWeaponJSON{
				ID:             id,
				Name:           strings.TrimSpace(sec.Name),
				VelocityWU:     sec.WeaponVelocity,
				Model:          strings.ToLower(strings.TrimSpace(sec.Model)),
				Ballistic:      typ == "ballistic" && !strings.EqualFold(strings.TrimSpace(sec.SubType), "dropped"),
				Dropped:        strings.EqualFold(strings.TrimSpace(sec.SubType), "dropped"),
				Guidance:       typ == "guided",
				AreaOfEffectWU: float64(sec.AreaOfEffect),
				RangeWU:        float64(sec.Range),
				TurnRate:       sec.TurnRate,
				SoundHit:       strings.ToLower(strings.TrimSpace(sec.SoundHit)),
				EffectClass:    takEffectClass(sec),
				TakType:        typ,
			}
			// TA:K colours are literal "R G B" triples (the lightning
			// beam's inner/outer bands), not palette indices — resolved
			// RGB only, no ColorIdx.
			if c := sec.InnerColor; c != nil {
				w.Color = &[3]int{c.R, c.G, c.B}
			}
			if c := sec.OuterColor; c != nil {
				w.Color2 = &[3]int{c.R, c.G, c.B}
			}
			out[id] = w
		}
	}
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
