package studio

import (
	"bytes"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/tdf"
)

// registerUnitAPI wires the per-unit metadata endpoint.  Returns the
// movement parameters + weapon refs the studio's Controls panel uses
// to drive the Move / Aim+Fire buttons.
func registerUnitAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/studio/unit/", handleUnitMeta)
	mux.HandleFunc("/api/studio/cursor/", handleCursorImage)
	// Weapon catalogue endpoints — `/api/studio/weapons` returns the
	// full list of weapon TDF sections in the loaded VFS (used by the
	// "Change Weapon" picker in the Weapons panel).
	mux.HandleFunc("/api/studio/weapons", handleWeaponsList)
	// /api/studio/sound/ is owned by sound.go (registered in api.go) —
	// it already serves the FBI SoundCategory sounds the Controls
	// overlay needs.  See sound.go for the case-insensitive resolver.
}

// unitMetaJSON is the response shape for /api/studio/unit/{name}.
// Fields are the subset the Controls panel needs — everything else
// the UI knows about the unit stays in the existing /models entry.
//
// Movement values are exposed at FBI face value (game frames at 30
// FPS for velocity, TA-angle / frame for turn rate); the client
// converts to per-second for live interpolation.
type unitMetaJSON struct {
	Name string `json:"name"`

	// Movement (from FBI [UNITINFO]).  CanMove is true when the unit
	// has a non-zero MaxVelocity AND its Category doesn't mark it as
	// static (NOTAIR / NOTSUB are LOAD restrictions, not motion).
	CanMove      bool    `json:"canMove"`
	MaxVelocity  float64 `json:"maxVelocity"`  // FBI units / frame (30 FPS).
	TurnRate     float64 `json:"turnRate"`     // TA-angle / frame.
	Acceleration float64 `json:"acceleration"` // FBI units / frame²
	BrakeRate    float64 `json:"brakeRate"`    // FBI units / frame²

	// Movement domain — controls how the studio's Move handler
	// animates the unit between targets.  Mutually exclusive in
	// practice (a unit is ground / sea / air); booleans are the
	// rawer FBI-driven facts and the client picks behaviour from
	// the combination.
	//   IsAircraft   — FBI's Category contains AIR / FIGHTER /
	//                  BOMBER / GUNSHIP / TRANSPORT, or TEDClass is
	//                  one of those tokens.  Rises off the ground on
	//                  Move-start and descends on Move-stop.
	//   IsHover      — HoverAttack=1.  Aircraft that can stop and
	//                  rotate in place (Brawler, Atlas).  When false
	//                  on an aircraft, the unit follows fly-by arcs
	//                  (Hawk, Thunder) — never stops mid-air, always
	//                  cycles back to the target.
	//   IsShip       — TEDClass=SHIP, or Category contains SHIP.
	//                  Surface watercraft; movement is on the water
	//                  plane, no Y change.
	//   IsSub        — TEDClass=SUB or Category contains SUB.  Same
	//                  as ship but rendered at the sub depth.
	IsAircraft bool `json:"isAircraft"`
	IsHover    bool `json:"isHover"`
	IsShip     bool `json:"isShip"`
	IsSub      bool `json:"isSub"`
	// IsHovercraft — Category contains HOVER.  A ground-domain vehicle that
	// rides an air cushion (Construction Hovercraft, Anaconda, ...); it drives
	// like a ground unit but gyrates / wobbles on its cushion, which the studio
	// renders as a procedural sway.  Distinct from IsHover (that's HoverAttack,
	// an aircraft trait).
	IsHovercraft bool `json:"isHovercraft"`
	// BankScale / PitchScale — aircraft roll-into-turn and nose-pitch
	// multipliers (FBI BankScale / PitchScale).  Default 1 for aircraft, 0 for
	// everything else, so the renderer only banks things that actually fly.
	BankScale  float64 `json:"bankScale"`
	PitchScale float64 `json:"pitchScale"`
	// CruiseAltitude — wu above ground the unit hovers at while in
	// motion (aircraft only).  FBI CruiseAlt when set; otherwise a
	// sensible default (60 for hover, 100 for fixed-wing).  Zero for
	// non-aircraft.
	CruiseAltitude float64 `json:"cruiseAltitude"`

	// Capability flags driving the Controls panel's per-port row
	// visibility.  Each maps to a small handful of FBI fields:
	//   IsBuilder  — Builder=1.  Construction units AND factories
	//                (factories carry Builder=1 + a non-empty YardMap;
	//                the studio just needs the boolean).  Used to
	//                show: move/fire orders (factories pass them to
	//                produced units), In build stance.
	//   OnOffable  — onoffable=1.  Units the player can manually
	//                toggle on/off (Radar, Solar, Adv Fusion).  Drives
	//                Active toggle visibility alongside Activate
	//                script presence.
	IsBuilder bool `json:"isBuilder"`
	OnOffable bool `json:"onoffable"`

	// Sounds — flattened from sound.tdf's section for the unit's
	// SoundCategory field.  The map's keys are the canonical TA
	// event names (select1, ok1, arrived1, activate, deactivate,
	// cant1, underattack, ...) and the values are sound names — the
	// .wav stem that the client appends to /api/studio/sound/ to
	// fetch.  Empty when the unit has no SoundCategory or the
	// resolved section is missing from sound.tdf.
	Sounds map[string]string `json:"sounds,omitempty"`

	// Weapons — each slot exposes the FBI ref string plus the
	// resolved TDF data so the client doesn't need to chase a
	// second request per weapon.  Empty slot ⇒ {Name:""}.
	Weapons []unitWeaponJSON `json:"weapons"` // always length 3 (primary/secondary/tertiary)

	// Death explosion references from the FBI:
	//   ExplodeAs       — TDF `ExplodeAs`: weapon name whose explosion art
	//                     plays when the unit is killed.
	//   SelfDestructAs  — TDF `SelfDestructAs`: weapon name whose explosion
	//                     art plays when the unit is manually self-destructed
	//                     (the bigger 5-second-timer blast).
	// Both are weapon-by-name references; the client passes the resolved
	// name to /api/studio/weapon-fx/{weapon}/{variant} to fetch the real
	// GAF animation.  Empty when the FBI omits the field.
	ExplodeAs      string `json:"explodeAs,omitempty"`
	SelfDestructAs string `json:"selfDestructAs,omitempty"`
}

type unitWeaponJSON struct {
	Slot string `json:"slot"` // "primary" / "secondary" / "tertiary"
	// Index: 1-based slot number (1=primary, 2=secondary, 3=tertiary).
	// Exposed so the UI can render "Weapon #N" headers without having
	// to translate the slot name back to a number.  Also useful for the
	// Change Weapon flow — the client passes this back so the binding
	// knows which Weapon{N} key to override.
	Index int `json:"index"`
	// WeaponID — the TDF `id=` field on the weapon section (e.g.
	// `[ARMCOMLASER] { id=84; ... }`).  TA's weapon table uses this
	// integer as the canonical engine-internal identifier; we surface
	// it so the Weapons panel can label each card with the real
	// weapon ID rather than just the slot ordinal.  Zero when the
	// TDF doesn't ship the field (some mod weapons omit it).
	WeaponID int `json:"weaponId"`
	Name     string  `json:"name"`       // FBI Weapon1/2/3 value (TDF section key), uppercased
	ReloadSec  float64 `json:"reloadSec"`  // seconds between shots
	RangeWU    float64 `json:"rangeWU"`    // engagement range in world units
	VelocityWU float64 `json:"velocityWU"` // projectile velocity, world units / sec
	Ballistic  bool    `json:"ballistic"`  // ballistic arc (mortar / cannon)
	// Burst-fire support — the EMG fires 3 shots 100 ms apart, then
	// waits the full reload between bursts; battleship cannons fire
	// one shot per reload.  `Burst` defaults to 1 (single-shot) when
	// the TDF doesn't specify; `BurstRateSec` is the inter-shot delay
	// inside a burst (0 → fire all at once).
	Burst        int     `json:"burst"`
	BurstRateSec float64 `json:"burstRateSec"`
	// Audio + visual identity pulled from the weapon TDF.  Studio
	// plays SoundStart on each Fire, SoundHit on impact-detonation
	// (when the projectile reaches its target or max range).  Empty
	// strings when the TDF didn't ship a sound for that event.
	SoundStart string `json:"soundStart"`
	SoundHit   string `json:"soundHit"`
	// Visual-class hints from the weapon TDF.  The renderer picks a
	// projectile kind (laser beam / smoke-trailing missile / generic
	// bullet) from these flags so weapon visuals match the in-game
	// behaviour without name-pattern guessing.
	//
	//   BeamWeapon: TDF `beamweapon=1`.  Instant-hit beam (lasers, the
	//     d-gun).  Rendered as a quick line of pulse particles from
	//     muzzle to target instead of a slow-travelling sprite.
	//   SmokeTrail: TDF `smoketrail=1`.  Spawns smoke puffs in the
	//     projectile's wake (missiles, rockets).
	//   SelfProp / Tracks: TDF `selfprop=1`, `tracks=1`.  Guided
	//     missile flag — the trail starts to curve toward the target
	//     when both are set.  Studio doesn't simulate tracking yet but
	//     the bit is exposed for future use.
	//   StartVelocityWU / AccelerationWU: TDF `startvelocity`,
	//     `weaponacceleration`.  Missile launch profile — the
	//     projectile leaves the rail at startvelocity and accelerates
	//     up to weaponvelocity at this rate.  Lasers / bullets ignore
	//     both (instant top speed).
	//   ColorIdx / Color2Idx: TDF `color` / `color2`, palette indices
	//     into TA's PALETTE.PAL.  Used to tint laser beams (the green
	//     ARMCOMLASER is color=232, the red CORE laser is color=247).
	//     The client maps these via a small palette LUT.
	//   Model: TDF `model=`, name of the 3DO used as the projectile
	//     mesh in the original game (e.g. `missile`, `dgun`).  We
	//     don't ship those meshes; the name is exposed so the visual
	//     classifier can pick a particle kind matching the family.
	BeamWeapon      bool    `json:"beamWeapon"`
	SmokeTrail      bool    `json:"smokeTrail"`
	SelfProp        bool    `json:"selfProp"`
	Tracks          bool    `json:"tracks"`
	StartVelocityWU float64 `json:"startVelocityWU"`
	AccelerationWU  float64 `json:"accelerationWU"`
	ColorIdx        int     `json:"colorIdx"`
	Color2Idx       int     `json:"color2Idx"`
	Model           string  `json:"model"`
	DurationSec     float64 `json:"durationSec"`
	// CommandFire: TDF `commandfire=1`.  Weapon discharges ONLY in
	// response to an explicit user command (the d-gun is the canonical
	// case — D-key in TA fires once, not the auto-attack cadence the
	// normal weapons use).  The studio's Controls treat this as a
	// one-shot: after the first fire, the slot's target is cleared so
	// the burst loop exits instead of re-firing on every reload.
	CommandFire bool `json:"commandFire"`
	// Dropped: TDF `dropped=1`.  A gravity bomb — the projectile has no
	// propulsion; it's released at the carrier's velocity and falls under
	// gravity.  Bombers release these over the target rather than firing
	// straight at it; the targeting cursor switches to the airstrike glyph.
	Dropped bool `json:"dropped"`
	// VLaunch: TDF `vlaunch=1`.  Vertical-launch missile — leaves the rail
	// straight up along the weapon mount, climbs for an ascent phase, then
	// pitches over toward the target and homes the rest of the way.
	VLaunch bool `json:"vlaunch"`
	// Tolerance / PitchTolerance: TDF `tolerance` / `pitchtolerance`, in TA
	// angle units (65536 = full circle).  The weapon may only OPEN FIRE once
	// the firing unit / turret faces the target within Tolerance on the yaw
	// axis (and PitchTolerance on pitch).  Out of tolerance, the unit must
	// rotate (or the turret aim) to face before the shot is allowed.  Zero
	// when the TDF omits it — treated as "no constraint" by the client.
	Tolerance      int `json:"tolerance"`
	PitchTolerance int `json:"pitchTolerance"`
	// TurnRate: TDF `turnrate`, in TA angle units / frame — the missile's
	// own homing turn rate (distinct from the unit FBI TurnRate).  Guided
	// projectiles curve toward the target at this rate; 0 = unguided.
	TurnRate int `json:"turnRate"`
	// FlightTimeSec: TDF `weapontimer`, seconds the projectile self-destructs
	// after if it hasn't hit — caps a guided missile's pursuit.  0 = use the
	// range/velocity time-of-flight fallback.
	FlightTimeSec float64 `json:"flightTimeSec"`
	// Cruise: TDF `cruise=1`.  Cruise missile — flies low/level toward the
	// target rather than arcing.  Surfaced for the projectile guidance mode.
	Cruise bool `json:"cruise"`
	// AreaOfEffectWU: TDF `areaofeffect`, the blast diameter in world units.
	// The projectile simulation uses half of it as the proximity radius for
	// "reached the target" detonation, so a bomb's wide blast detonates
	// sooner than a pinpoint missile.
	AreaOfEffectWU float64 `json:"areaOfEffectWU"`

	// --- Remaining weapon TDF fields ---
	// Everything below is surfaced verbatim from the weapon section so the
	// renderer / sim can drive visuals + behaviour from real game data rather
	// than name-pattern heuristics.  Field names mirror the TDF keys; zero /
	// false / "" mean the key was absent (TA treats those as the default).

	// RenderType: TDF `rendertype`, the engine's projectile draw method
	// (0=laser, 1=2D bitmap, 4=3D model, 5=flame/particle, etc.).  Lets the
	// renderer pick a projectile family without inspecting the weapon name.
	RenderType int `json:"renderType"`

	// Trajectory / targeting category flags.
	Turret      bool `json:"turret"`      // 360° turret-mounted, free pitch
	LineOfSight bool `json:"lineOfSight"` // straight-line shot, gravity ignored
	Guidance    bool `json:"guidance"`    // guided, homes using TurnRate
	WaterWeapon bool `json:"waterWeapon"` // travels through water (torpedoes)
	TwoPhase    bool `json:"twoPhase"`    // converts to a second weapon mid-flight
	NoAutoRange bool `json:"noAutoRange"` // never auto-detonates at max range
	BurnBlow    bool `json:"burnBlow"`    // detonates at end of range
	Propeller   bool `json:"propeller"`   // projectile model has a spinning prop
	UnitsOnly   bool `json:"unitsOnly"`   // only detonates on units, not terrain
	Targetable  bool `json:"targetable"`  // can be shot down by interceptors
	Interceptor bool `json:"interceptor"` // shoots down other weapons
	Meteor      bool `json:"meteor"`      // meteor-shower style area weapon
	Paralyzer   bool `json:"paralyzer"`   // stuns rather than damages
	NoExplode   bool `json:"noExplode"`   // no explosion on impact
	NoRadar     bool `json:"noRadar"`     // invisible to radar
	GroundBounce bool `json:"groundBounce"` // bounces off the ground
	Stockpile   bool `json:"stockpile"`   // must be built/stockpiled before firing
	ToAirWeapon bool `json:"toAirWeapon"` // anti-air only
	StartFire   bool `json:"startFire"`   // ignites a fire at the firing point
	SoundTrigger bool `json:"soundTrigger"` // re-plays SoundStart on each burst shot
	StartSmoke  bool `json:"startSmoke"`  // puff of smoke at the muzzle on fire
	EndSmoke    bool `json:"endSmoke"`    // puff of smoke at the terminal point

	// Integer tuning fields (TA angle units = 65536 / circle where noted).
	Coverage       int `json:"coverage"`       // anti-missile protection radius
	Firestarter    int `json:"firestarter"`    // % chance to start a fire (0..100)
	EnergyPerShot  int `json:"energyPerShot"`   // energy drained per shot
	MetalPerShot   int `json:"metalPerShot"`    // metal drained per shot
	EnergyCost     int `json:"energyCost"`      // TDF `energy` (build/stockpile cost)
	MetalCost      int `json:"metalCost"`       // TDF `metal` (build/stockpile cost)
	ShakeMagnitude int `json:"shakeMagnitude"`  // screen-shake strength on fire
	MinBarrelAngle int `json:"minBarrelAngle"`  // min barrel pitch, degrees (may be negative)
	SprayAngle     int `json:"sprayAngle"`      // burst spread, TA angle units
	Accuracy       int `json:"accuracy"`        // inaccuracy, TA angle units (0 = perfect)
	AimRate        int `json:"aimRate"`          // aim speed, TA angle units / sec
	HoldTime       int `json:"holdTime"`         // TDF `holdtime`

	// Floating-point timing / falloff fields (seconds unless noted).
	EdgeEffectiveness float64 `json:"edgeEffectiveness"` // damage fraction at AoE edge (0..1)
	SmokeDelaySec     float64 `json:"smokeDelaySec"`     // interval between trail puffs
	ShakeDurationSec  float64 `json:"shakeDurationSec"`  // screen-shake duration
	RandomDecaySec    float64 `json:"randomDecaySec"`    // random burst decay time
	// FlightTime: TDF `flighttime`, the self-propelled burn time of a
	// starburst / two-phase missile.  Distinct from FlightTimeSec above,
	// which is TDF `weapontimer` (the projectile's overall self-destruct
	// timer).  Both are kept because TA ships them as separate keys.
	FlightTime float64 `json:"flightTime"`

	// Explosion art references — the GAF file + animation sequence TA plays
	// at impact for ground, water and lava hits respectively.  Surfaced so a
	// future FX pass can render the real sprite instead of a synthetic burst.
	ExplosionGaf      string `json:"explosionGaf"`
	ExplosionArt      string `json:"explosionArt"`
	WaterExplosionGaf string `json:"waterExplosionGaf"`
	WaterExplosionArt string `json:"waterExplosionArt"`
	LavaExplosionGaf  string `json:"lavaExplosionGaf"`
	LavaExplosionArt  string `json:"lavaExplosionArt"`

	// SoundWater: TDF `soundwater`, played when the projectile strikes water.
	SoundWater string `json:"soundWater"`

	// Damage table from the weapon's nested [DAMAGE] subsection.
	// DamageDefault is the `default=` value applied to any target without a
	// specific override; Damage holds every entry (including per-unit-name
	// overrides, keyed lowercase) so the client can look up the exact damage
	// dealt to a given target.
	DamageDefault int            `json:"damageDefault"`
	Damage        map[string]int `json:"damage,omitempty"`
}

func handleUnitMeta(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/unit/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing unit name", http.StatusBadRequest)
		return
	}
	name = strings.ToLower(strings.TrimSuffix(name, ".fbi"))
	fbiDoc, err := loadUnitFBI(name)
	if err != nil {
		// 404 for missing FBI — many 3DOs ship without a unit ref
		// (props / features).  Client treats absence as "no controls
		// available" and the buttons stay greyed out.
		http.Error(w, "unit fbi not found", http.StatusNotFound)
		return
	}
	// FBI files key their single section by the unit's name (e.g.
	// [ARMCOM], [CORKBOT]), not by a fixed [UNITINFO] tag.  Grab the
	// first section that carries an Objectname — that's the unit
	// definition.  Skips comment-only blocks if any.
	var info *tdf.Section
	for _, s := range fbiDoc.Sections() {
		if strings.TrimSpace(s.String("Objectname")) != "" || strings.TrimSpace(s.String("UnitName")) != "" {
			info = s
			break
		}
	}
	if info == nil && len(fbiDoc.Sections()) > 0 {
		info = fbiDoc.Sections()[0]
	}
	if info == nil {
		http.Error(w, "fbi has no sections", http.StatusInternalServerError)
		return
	}
	out := unitMetaJSON{
		Name:         name,
		MaxVelocity:  info.Float("MaxVelocity"),
		TurnRate:     info.Float("TurnRate"),
		Acceleration: info.Float("Acceleration"),
		BrakeRate:    info.Float("BrakeRate"),
	}
	// CanMove: non-zero MaxVelocity is the cheapest signal that the
	// unit isn't a structure / wreckage.  Static category flags
	// (NOTAIR, NOTSUB) are LOAD-side restrictions, not motion.
	out.CanMove = out.MaxVelocity > 0
	// Movement-domain classification.  FBI's `Category` is a
	// space-separated token list; TEDClass is a single canonical
	// keyword.  Check both so we catch units that flag their domain
	// in one but not the other (Commander uses Category to convey
	// "wades but doesn't swim", for example).
	tedClass := strings.ToUpper(strings.TrimSpace(info.String("TEDClass")))
	catTokens := map[string]bool{}
	for _, t := range strings.Fields(strings.ToUpper(info.String("Category"))) {
		catTokens[t] = true
	}
	switch tedClass {
	case "SHIP":
		out.IsShip = true
	case "SUB", "UWMINE", "UWBLDG":
		out.IsSub = true
	case "VTOL", "FIGHTER", "BOMBER", "GUNSHIP", "TRANSPORT", "AIR":
		// TA ships ALL aircraft as TEDClass=VTOL — fighter / bomber /
		// gunship / transport variants live under the same class,
		// distinguished only by HoverAttack and Category tokens.  The
		// other names are accepted for fan-mod compatibility but TA's
		// stock units only use VTOL.
		out.IsAircraft = true
	}
	for _, k := range []string{"VTOL", "AIR", "FIGHTER", "BOMBER", "GUNSHIP"} {
		if catTokens[k] {
			out.IsAircraft = true
		}
	}
	// Canfly=1 is the canonical "this unit is airborne" flag — every
	// stock TA aircraft sets it.  Picking it up here means modded
	// units that omit the VTOL TEDClass / Category still get the
	// aircraft flight model.
	if info.Int("Canfly") == 1 {
		out.IsAircraft = true
	}
	if catTokens["SHIP"] && !out.IsSub {
		out.IsShip = true
	}
	if catTokens["SUB"] || catTokens["UNDERWATER"] {
		out.IsSub = true
	}
	// TEDClass=WATER is TA's catch-all for "lives on / in the water"
	// — covers some subs and a few floating buildings (TLs,
	// torpedo launchers).  Treat as sub unless Floater=1 is set,
	// in which case it's a surface unit.
	if tedClass == "WATER" {
		if info.Int("Floater") == 1 || catTokens["SHIP"] {
			out.IsShip = true
		} else {
			out.IsSub = true
		}
	}
	// HoverAttack=1 → unit can stop and rotate in place (gunship-
	// style).  Without it, fixed-wing aircraft must keep moving
	// (the studio's flight scheduler arcs them around the target).
	out.IsHover = info.Int("HoverAttack") == 1
	// Hovercraft vehicles tag themselves with the HOVER Category token
	// (Construction Hovercraft, Anaconda, ...).  They drive on the ground
	// plane but ride an air cushion, so the studio gives them a procedural
	// hover sway.  Don't treat aircraft as hovercraft.
	out.IsHovercraft = catTokens["HOVER"] && !out.IsAircraft
	// BankScale / PitchScale — only meaningful for aircraft.  TA defaults both
	// to 1 when the FBI omits them, so surface 1 for any flier and 0 otherwise
	// (the renderer skips banking when the scale is 0).
	if out.IsAircraft {
		out.BankScale = info.Float("BankScale")
		if out.BankScale <= 0 {
			out.BankScale = 1
		}
		out.PitchScale = info.Float("PitchScale")
		if out.PitchScale <= 0 {
			out.PitchScale = 1
		}
	}
	// Builder=1 covers both factories (Builder + YardMap) and
	// construction units (Builder + WorkerTime > 0).  The studio
	// only needs the boolean for panel gating; per-class behaviour
	// (factory vs construction) isn't differentiated here.
	out.IsBuilder = info.Int("Builder") == 1
	// onoffable=1 — unit can be manually toggled on/off by the
	// player (Radar, Solar, Adv Fusion).  TA uses the lowercase
	// spelling consistently in the original FBIs.
	out.OnOffable = info.Int("onoffable") == 1
	// CruiseAltitude: FBI `CruiseAlt` for aircraft, otherwise 0.
	// Defaults pick a sensible mid-air position when the FBI is
	// silent (some unit FBIs omit the field).
	if out.IsAircraft {
		out.CruiseAltitude = info.Float("CruiseAlt")
		if out.CruiseAltitude <= 0 {
			if out.IsHover {
				out.CruiseAltitude = 60
			} else {
				out.CruiseAltitude = 100
			}
		}
	}
	// Weapons — three slots.  Each name is the section key in some
	// weapons/*.tdf file.  loadWeaponTDF walks the weapons folder for
	// a case-insensitive match.
	//
	// Query-parameter overrides (`?weapon1=NAME&weapon2=NAME&weapon3=NAME`)
	// let the studio's "Change Weapon" picker swap one slot's data
	// without touching the FBI on disk.  When set, the override beats
	// the FBI value for that slot.  Empty / "NONE" / "-" clears the
	// slot (useful to disable a weapon for testing).
	out.Weapons = []unitWeaponJSON{
		{Slot: "primary", Index: 1},
		{Slot: "secondary", Index: 2},
		{Slot: "tertiary", Index: 3},
	}
	overrideKeys := []string{"weapon1", "weapon2", "weapon3"}
	for i, key := range []string{"Weapon1", "Weapon2", "Weapon3"} {
		w := strings.ToUpper(strings.TrimSpace(info.String(key)))
		// Per-slot override from the query string — wins over FBI.
		if ov := strings.TrimSpace(r.URL.Query().Get(overrideKeys[i])); ov != "" {
			w = strings.ToUpper(ov)
		}
		if w == "" || w == "NONE" || w == "-" {
			continue
		}
		out.Weapons[i].Name = w
		if sec := loadWeaponSection(w); sec != nil {
			populateWeaponJSON(&out.Weapons[i], sec)
		}
	}
	// Death explosion FBI refs — surfaced for the client's death-FX
	// path.  Uppercased so the eventual /api/studio/weapon-fx/<name>
	// fetch matches the weapon-by-name resolver (which lowercases for
	// comparison anyway).
	out.ExplodeAs = strings.ToUpper(strings.TrimSpace(info.String("ExplodeAs")))
	out.SelfDestructAs = strings.ToUpper(strings.TrimSpace(info.String("SelfDestructAs")))
	// Sounds — SoundCategory keys into gamedata/sound.tdf.  Each
	// section there maps named events (select1, ok1, arrived1, ...)
	// to .wav stems in sounds/.  Studio plays the matching .wav
	// when the user performs the corresponding action.
	if cat := strings.ToUpper(strings.TrimSpace(info.String("SoundCategory"))); cat != "" {
		if sec := loadSoundSection(cat); sec != nil {
			out.Sounds = make(map[string]string)
			for _, key := range soundEventKeys {
				if v := strings.TrimSpace(sec.String(key)); v != "" {
					out.Sounds[key] = strings.ToLower(v)
				}
			}
		}
	}
	writeJSON(w, out)
}

// soundEventKeys is the set of TA sound-event names the studio
// surfaces.  Selected from sound.tdf's known fields — narrower than
// "every key in the section" so a mod can't accidentally inject a
// weird sound for an event we don't expect.  Ordered by frequency
// of use so the most common entries land first in the JSON output.
var soundEventKeys = []string{
	"select1", "select2", "select3",
	"ok1", "ok2", "ok3", "ok4", "ok5",
	"arrived1", "arrived2", "arrived3", "arrived4", "arrived5",
	"cant1", "cant2",
	"underattack",
	"activate", "deactivate",
	"build", "repair", "working",
	"count0", "count1", "count2", "count3", "count4", "count5",
	"canceldestruct",
}

// loadSoundSection reads gamedata/sound.tdf and returns the named
// section (case-insensitive).  Cached for the server lifetime so
// repeated unit-meta requests don't re-parse the (large) TDF.
var (
	soundTDFMu   sync.Mutex
	soundTDFOnce sync.Once
	soundTDFDoc  *tdf.Document
)

func loadSoundSection(name string) *tdf.Section {
	soundTDFOnce.Do(func() {
		// gamedata/sound.tdf is the canonical location in TA.  Try
		// the lowercase + casing variants so mods that ship the
		// file with a different name still resolve.
		for _, p := range []string{"gamedata/sound.tdf", "gamedata/SOUND.tdf", "GameData/sound.tdf"} {
			if data, err := vfs.ReadFile(p); err == nil {
				if doc, derr := tdf.ParseString(string(data)); derr == nil {
					soundTDFDoc = doc
					return
				}
			}
		}
	})
	soundTDFMu.Lock()
	defer soundTDFMu.Unlock()
	if soundTDFDoc == nil {
		return nil
	}
	for _, s := range soundTDFDoc.Sections() {
		if strings.EqualFold(s.Name(), name) {
			return s
		}
	}
	return nil
}

// loadUnitFBI finds the units/<name>.fbi by walking the VFS for a
// case-insensitive match.  Unit names in the file system are
// frequently mixed-case (e.g. ARMCOM.FBI) so we don't trust a
// straight ReadFile.
func loadUnitFBI(name string) (*tdf.Document, error) {
	candidates := []string{
		"units/" + name + ".fbi",
		"units/" + strings.ToUpper(name) + ".FBI",
		"Units/" + name + ".fbi",
	}
	for _, p := range candidates {
		if data, err := vfs.ReadFile(p); err == nil {
			return tdf.ParseString(string(data))
		}
	}
	// Last-ditch: walk the entire VFS for a case-insensitive name match.
	want := strings.ToLower(name + ".fbi")
	for _, p := range vfs.List() {
		if strings.ToLower(basename(p)) == want {
			if data, err := vfs.ReadFile(p); err == nil {
				return tdf.ParseString(string(data))
			}
		}
	}
	return nil, errFBINotFound
}

// loadWeaponSection finds the weapons/*.tdf section whose key
// matches `name` (case-insensitive).  Returns nil when no weapons
// folder ships or the ref doesn't resolve — the client treats that
// as "use default reload" and the Fire button still works.
func loadWeaponSection(name string) *tdf.Section {
	want := strings.ToUpper(strings.TrimSpace(name))
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "weapons/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		data, err := vfs.ReadFile(p)
		if err != nil {
			continue
		}
		doc, err := tdf.ParseString(string(data))
		if err != nil {
			continue
		}
		for _, sec := range doc.Sections() {
			if strings.ToUpper(sec.Name()) == want {
				return sec
			}
		}
	}
	return nil
}

// populateWeaponJSON copies the parsed weapon TDF section into the
// JSON struct.  Shared by the per-unit /api/studio/unit endpoint and
// the catalogue /api/studio/weapons endpoint so both expose the same
// fields with the same defaults (and the Change Weapon picker can
// show the same stats the active panel will display after swap).
func populateWeaponJSON(out *unitWeaponJSON, sec *tdf.Section) {
	// `id=` — engine-internal weapon table index.  intFieldClean
	// handles trailing /* comment */ and semicolon junk that some
	// stock weapon TDFs ship with their integer values.
	out.WeaponID = intFieldClean(sec, "id")
	out.ReloadSec = sec.Float("reloadtime")
	out.RangeWU = sec.Float("range")
	out.VelocityWU = sec.Float("weaponvelocity")
	out.Ballistic = boolish(sec.String("ballistic"))
	out.SoundStart = strings.ToLower(strings.TrimSpace(sec.String("soundstart")))
	out.SoundHit = strings.ToLower(strings.TrimSpace(sec.String("soundhit")))
	burst := sec.Int("burst")
	if burst < 1 {
		burst = 1
	}
	out.Burst = burst
	out.BurstRateSec = sec.Float("burstrate")
	out.BeamWeapon = boolish(sec.String("beamweapon"))
	out.SmokeTrail = boolish(sec.String("smoketrail"))
	out.SelfProp = boolish(sec.String("selfprop"))
	out.Tracks = boolish(sec.String("tracks"))
	out.StartVelocityWU = sec.Float("startvelocity")
	out.AccelerationWU = sec.Float("weaponacceleration")
	out.ColorIdx = intFieldClean(sec, "color")
	out.Color2Idx = intFieldClean(sec, "color2")
	out.Model = strings.ToLower(strings.TrimSpace(sec.String("model")))
	out.DurationSec = sec.Float("duration")
	out.CommandFire = boolish(sec.String("commandfire"))
	out.Dropped = boolish(sec.String("dropped"))
	out.VLaunch = boolish(sec.String("vlaunch"))
	out.Tolerance = intFieldClean(sec, "tolerance")
	out.PitchTolerance = intFieldClean(sec, "pitchtolerance")
	out.TurnRate = intFieldClean(sec, "turnrate")
	out.FlightTimeSec = sec.Float("weapontimer")
	out.Cruise = boolish(sec.String("cruise"))
	out.AreaOfEffectWU = sec.Float("areaofeffect")

	// Render method + trajectory/targeting category flags.
	out.RenderType = intFieldClean(sec, "rendertype")
	out.Turret = boolish(sec.String("turret"))
	out.LineOfSight = boolish(sec.String("lineofsight"))
	out.Guidance = boolish(sec.String("guidance"))
	out.WaterWeapon = boolish(sec.String("waterweapon"))
	out.TwoPhase = boolish(sec.String("twophase"))
	out.NoAutoRange = boolish(sec.String("noautorange"))
	out.BurnBlow = boolish(sec.String("burnblow"))
	out.Propeller = boolish(sec.String("propeller"))
	out.UnitsOnly = boolish(sec.String("unitsonly"))
	out.Targetable = boolish(sec.String("targetable"))
	out.Interceptor = boolish(sec.String("interceptor"))
	out.Meteor = boolish(sec.String("meteor"))
	out.Paralyzer = boolish(sec.String("paralyzer"))
	out.NoExplode = boolish(sec.String("noexplode"))
	out.NoRadar = boolish(sec.String("noradar"))
	out.GroundBounce = boolish(sec.String("groundbounce"))
	out.Stockpile = boolish(sec.String("stockpile"))
	out.ToAirWeapon = boolish(sec.String("toairweapon"))
	out.StartFire = boolish(sec.String("startfire"))
	out.SoundTrigger = boolish(sec.String("soundtrigger"))
	out.StartSmoke = boolish(sec.String("startsmoke"))
	out.EndSmoke = boolish(sec.String("endsmoke"))

	// Integer tuning fields.
	out.Coverage = intFieldClean(sec, "coverage")
	out.Firestarter = intFieldClean(sec, "firestarter")
	out.EnergyPerShot = intFieldClean(sec, "energypershot")
	out.MetalPerShot = intFieldClean(sec, "metalpershot")
	out.EnergyCost = intFieldClean(sec, "energy")
	out.MetalCost = intFieldClean(sec, "metal")
	out.ShakeMagnitude = intFieldClean(sec, "shakemagnitude")
	out.MinBarrelAngle = intFieldClean(sec, "minbarrelangle")
	out.SprayAngle = intFieldClean(sec, "sprayangle")
	out.Accuracy = intFieldClean(sec, "accuracy")
	out.AimRate = intFieldClean(sec, "aimrate")
	out.HoldTime = intFieldClean(sec, "holdtime")

	// Floating-point timing / falloff fields.
	out.EdgeEffectiveness = floatFieldClean(sec, "edgeeffectiveness")
	out.SmokeDelaySec = floatFieldClean(sec, "smokedelay")
	out.ShakeDurationSec = floatFieldClean(sec, "shakeduration")
	out.RandomDecaySec = floatFieldClean(sec, "randomdecay")
	out.FlightTime = floatFieldClean(sec, "flighttime")

	// Explosion art references + water-impact sound.
	out.ExplosionGaf = strings.ToLower(strings.TrimSpace(sec.String("explosiongaf")))
	out.ExplosionArt = strings.ToLower(strings.TrimSpace(sec.String("explosionart")))
	out.WaterExplosionGaf = strings.ToLower(strings.TrimSpace(sec.String("waterexplosiongaf")))
	out.WaterExplosionArt = strings.ToLower(strings.TrimSpace(sec.String("waterexplosionart")))
	out.LavaExplosionGaf = strings.ToLower(strings.TrimSpace(sec.String("lavaexplosiongaf")))
	out.LavaExplosionArt = strings.ToLower(strings.TrimSpace(sec.String("lavaexplosionart")))
	out.SoundWater = strings.ToLower(strings.TrimSpace(sec.String("soundwater")))

	// Nested [DAMAGE] table — `default=` plus per-target-name overrides.
	// Keys are lowercased so a client lookup by unit name is case-stable.
	for _, sub := range sec.Sections() {
		if !strings.EqualFold(sub.Name(), "DAMAGE") {
			continue
		}
		dmg := map[string]int{}
		for _, f := range sub.Fields() {
			key := strings.ToLower(strings.TrimSpace(f.Key()))
			if key == "" {
				continue
			}
			val := cleanNumeric(f.Value())
			if val == "" {
				continue
			}
			if n, err := strconv.Atoi(val); err == nil {
				dmg[key] = n
			}
		}
		if len(dmg) > 0 {
			out.Damage = dmg
			out.DamageDefault = dmg["default"]
		}
		break
	}
}

// weaponsListMu / weaponsListOnce / weaponsListCache cache the parsed
// catalogue for the server lifetime — walking every weapons/*.tdf and
// re-parsing on each picker open would be wasteful for a list that
// doesn't change after startup.
var (
	weaponsListMu    sync.Mutex
	weaponsListOnce  sync.Once
	weaponsListCache []unitWeaponJSON
)

// buildWeaponsList walks every weapons/*.tdf in the VFS and emits one
// JSON entry per section.  Slot / Index are left zero — the catalogue
// is unit-agnostic; the client assigns those when the user picks one
// for a specific slot.  Sorted alphabetically by name so the picker's
// stable ordering doesn't depend on directory walk order.
func buildWeaponsList() []unitWeaponJSON {
	seen := map[string]bool{}
	out := []unitWeaponJSON{}
	for _, p := range vfs.List() {
		lower := strings.ToLower(p)
		if !strings.HasPrefix(lower, "weapons/") || !strings.HasSuffix(lower, ".tdf") {
			continue
		}
		data, err := vfs.ReadFile(p)
		if err != nil {
			continue
		}
		doc, err := tdf.ParseString(string(data))
		if err != nil {
			continue
		}
		for _, sec := range doc.Sections() {
			name := strings.ToUpper(strings.TrimSpace(sec.Name()))
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			w := unitWeaponJSON{Name: name}
			populateWeaponJSON(&w, sec)
			out = append(out, w)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// handleWeaponsList serves the cached weapon catalogue.
func handleWeaponsList(w http.ResponseWriter, _ *http.Request) {
	weaponsListOnce.Do(func() {
		weaponsListCache = buildWeaponsList()
	})
	weaponsListMu.Lock()
	defer weaponsListMu.Unlock()
	writeJSON(w, weaponsListCache)
}

func boolish(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// cleanNumeric strips trailing inline /* … */ or // comments and the
// line-terminator semicolon from a raw TDF value, returning the bare
// number text.  Shared by the int/float field readers and the [DAMAGE]
// table parse so every numeric read tolerates the comment junk stock
// weapon TDFs ship with (e.g. `color=232; /* GREEN */`).
func cleanNumeric(raw string) string {
	if idx := strings.Index(raw, "/*"); idx >= 0 {
		raw = raw[:idx]
	}
	if idx := strings.Index(raw, "//"); idx >= 0 {
		raw = raw[:idx]
	}
	raw = strings.TrimRight(strings.TrimSpace(raw), ";")
	return strings.TrimSpace(raw)
}

// intFieldClean reads sec.String(key), strips trailing inline /* … */
// comments and the line-terminator semicolon, and Atoi-parses what's
// left.  Workaround for weapon-TDF entries like `color=232; /* GREEN */`
// where the generic TDF parser keeps the whole tail in the raw value
// and Atoi rejects it.  Returns 0 on missing / unparseable values.
func intFieldClean(sec *tdf.Section, key string) int {
	raw := cleanNumeric(sec.String(key))
	if raw == "" {
		return 0
	}
	if i, err := strconv.Atoi(raw); err == nil {
		return i
	}
	return 0
}

// floatFieldClean mirrors intFieldClean for fractional values
// (edgeeffectiveness, smokedelay, …) — leading-dot forms like `.3` parse
// fine through strconv.ParseFloat.  Returns 0 on missing / unparseable.
func floatFieldClean(sec *tdf.Section, key string) float64 {
	raw := cleanNumeric(sec.String(key))
	if raw == "" {
		return 0
	}
	if f, err := strconv.ParseFloat(raw, 64); err == nil {
		return f
	}
	return 0
}

// errFBINotFound is the sentinel for the 404 path so the handler can
// switch on it cleanly.
var errFBINotFound = &fbiNotFoundError{}

type fbiNotFoundError struct{}

func (*fbiNotFoundError) Error() string { return "fbi not found" }

// basename avoids dragging path/filepath into this file just for
// a basename helper.
func basename(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// handleCursorImage serves a single TA GAF cursor frame as PNG.
// URL: /api/studio/cursor/{seqName}.  seqName is the GAF sequence
// (e.g. "cursormove", "cursorattack", "cursormovat").  The
// transparency index is honoured so the browser sees a proper
// alpha channel and the SVG cursor scales correctly.  Falls back
// to 404 when the named sequence isn't in any cursors GAF.
func handleCursorImage(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/cursor/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing cursor name", http.StatusBadRequest)
		return
	}
	// Anims/cursors.gaf is the standard location; some assets use
	// the lowercased path.  Walk a small candidate list.
	gafCandidates := []string{
		"anims/cursors.gaf",
		"Anims/cursors.gaf",
	}
	var data []byte
	for _, p := range gafCandidates {
		if b, e := vfs.ReadFile(p); e == nil {
			data = b
			break
		}
	}
	if data == nil {
		http.Error(w, "cursors.gaf not found", http.StatusNotFound)
		return
	}
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		http.Error(w, "load gaf: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer func() { _ = reader.Close() }()
	seqs, err := reader.ReadSequences()
	if err != nil {
		http.Error(w, "read sequences: "+err.Error(), http.StatusInternalServerError)
		return
	}
	want := strings.ToLower(strings.TrimSpace(name))
	var target *gaf.Sequence
	for _, s := range seqs {
		if strings.ToLower(s.Name) == want {
			target = s
			break
		}
	}
	if target == nil || len(target.Frames) == 0 {
		http.Error(w, "cursor sequence not found", http.StatusNotFound)
		return
	}
	pal, err := gaf.LoadPaletteFromBytes(loadPaletteBytes())
	if err != nil {
		http.Error(w, "load palette: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// TA cursors use the GAF's transparency index for the "outside
	// the cursor shape" pixels.  TransparencyModeAuto runs the
	// corner-detect heuristic, which is the right default for sprite
	// GAFs like cursors — the corner pixel is almost always the
	// transparency colour, and the heuristic falls back to the
	// frame's stored TransparencyIndex when corners disagree.
	opts := gaf.RenderOptions{Mode: gaf.TransparencyModeAuto}
	var buf bytes.Buffer
	// Multi-frame cursor → animated PNG so the browser cycles
	// through the frames at the GAF-declared durations.  Single
	// frame → plain PNG.  APNG is widely supported as a CSS cursor
	// in modern Chromium/Firefox; browsers that don't honour the
	// animation just show the first frame.
	if len(target.Frames) > 1 {
		if err := target.ToAPNGWith(pal, opts, &buf); err != nil {
			http.Error(w, "encode apng: "+err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		if err := target.Frames[0].ToPNGWith(pal, opts, &buf); err != nil {
			http.Error(w, "encode png: "+err.Error(), http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(buf.Bytes())
}


