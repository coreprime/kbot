package studio

import (
	"bytes"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/gamedata/tak"
	"github.com/coreprime/kbot/formats/tdf"
)

// registerUnitAPI wires the per-unit metadata endpoint.  Returns the
// movement parameters + weapon refs the studio's Controls panel uses
// to drive the Move / Aim+Fire buttons.
func (sess *Session) registerUnitAPI(mux *http.ServeMux) {
	mux.HandleFunc("/api/studio/unit/", sess.handleUnitMeta)
	mux.HandleFunc("/api/studio/cursor/", sess.handleCursorImage)
	// Weapon catalogue endpoints — `/api/studio/weapons` returns the
	// full list of weapon TDF sections in the loaded VFS (used by the
	// "Change Weapon" picker in the Weapons panel).
	mux.HandleFunc("/api/studio/weapons", sess.handleWeaponsList)
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
	// Title is the unit's human-readable FBI name ("Fido"), with the FBI
	// description appended for tooltips ("Fido — Assault Kbot").
	Title string `json:"title,omitempty"`

	// Movement (from FBI [UNITINFO]).  CanMove is true when the unit
	// has a non-zero MaxVelocity AND its Category doesn't mark it as
	// static (NOTAIR / NOTSUB are LOAD restrictions, not motion).
	CanMove      bool    `json:"canMove"`
	MaxVelocity  float64 `json:"maxVelocity"`  // FBI units / frame (30 FPS).
	TurnRate     float64 `json:"turnRate"`     // TA-angle / frame.
	Acceleration float64 `json:"acceleration"` // FBI units / frame²
	BrakeRate    float64 `json:"brakeRate"`    // FBI units / frame²

	// MaxDamage — FBI `maxdamage`, the unit's absolute hit points. The
	// engine pairs it with each weapon's absolute [DAMAGE] value to scale
	// hits onto its percent health bar, so combat follows the game data.
	MaxDamage int `json:"maxDamage"`

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
	// ActivateWhenBuilt — run Activate automatically on build completion.
	ActivateWhenBuilt bool `json:"activateWhenBuilt,omitempty"`

	// Construction stats for the build cycle:
	//   BuildTime     — FBI buildtime, the unit's build-effort points (how
	//                   long IT takes to construct).
	//   WorkerTime    — FBI workertime, the builder's effort/sec output.
	//   BuildDistance — FBI builddistance, how close (wu) a mobile builder
	//                   must stand to its construction site.
	BuildTime     float64 `json:"buildTime,omitempty"`
	WorkerTime    int     `json:"workerTime,omitempty"`
	BuildDistance int     `json:"buildDistance,omitempty"`

	// Resource prices: TA pays metal + energy (buildcostmetal /
	// buildcostenergy); TA:K pays mana (buildcost). The game adapter
	// declares which of these the HUD shows.
	CostMetal  float64 `json:"costMetal,omitempty"`
	CostEnergy float64 `json:"costEnergy,omitempty"`
	CostMana   float64 `json:"costMana,omitempty"`

	// Default standing orders (FBI standingmoveorder / standingfireorder).
	// 0 in the FBI is indistinguishable from absent, so 0 here means "use
	// the game default" (Maneuver / Fire at Will) — the sim resolves it.
	StandingMoveOrder int `json:"standingMoveOrder,omitempty"`
	StandingFireOrder int `json:"standingFireOrder,omitempty"`

	// Resolved death-blast stats: the explodeas / selfdestructas weapon's
	// damage, blast diameter and edge falloff, so the sim deals splash on
	// death without chasing weapon TDFs itself.
	ExplodeWeapon     *explosionJSON `json:"explodeWeapon,omitempty"`
	SelfDestructWeapn *explosionJSON `json:"selfDestructWeapon,omitempty"`

	// Economy contributions, per second while the unit stands: generation
	// (TA energymake / metalmake+makesmetal+extractsmetal; TA:K
	// manarechargerate+mogriumincome) and storage capacity (TA
	// energystorage/metalstorage; TA:K maxmana).
	// TransportSlots — how many units this transport can carry (the FBI's
	// transmaxunits when set, else its size budget divided by the largest
	// unit it accepts). 0 = not a transport.
	TransportSlots int `json:"transportSlots,omitempty"`

	MakesMetal  float64 `json:"makesMetal,omitempty"`
	MakesEnergy float64 `json:"makesEnergy,omitempty"`
	MakesMana   float64 `json:"makesMana,omitempty"`
	// TA:K keeps two distinct mana pools: manarechargerate/maxmana feed a
	// unit's PRIVATE casting pool, while mogriumincome/mogriumstorage feed
	// the GLOBAL player economy (the visible Mana counter). MakesMana and
	// StoresMana above conflate them for compatibility; these two carry the
	// global-economy side alone.
	MogriumIncome  float64 `json:"mogriumIncome,omitempty"`
	MogriumStorage float64 `json:"mogriumStorage,omitempty"`
	// UsesEnergy is the standing energy drain (FBI energyuse when positive —
	// metal makers, radar, jammers). Negative energyuse is solar-style income
	// and folds into MakesEnergy instead. Surfaced so the hover tooltip can
	// show consumption alongside production.
	UsesEnergy float64 `json:"usesEnergy,omitempty"`
	StoresMetal float64 `json:"storesMetal,omitempty"`
	StoresEnergy float64 `json:"storesEnergy,omitempty"`
	StoresMana  float64 `json:"storesMana,omitempty"`

	// Terrain limits (FBI maxslope / maxwaterdepth / minwaterdepth, height
	// units) — the sim's movement and build-site legality on loaded maps.
	MaxSlope      int `json:"maxSlope,omitempty"`
	MaxWaterDepth int `json:"maxWaterDepth,omitempty"`
	MinWaterDepth int `json:"minWaterDepth,omitempty"`

	// Footprint — FBI footprintx/footprintz in map squares; the sim derives
	// its collision body from it.
	FootprintX int `json:"footprintX,omitempty"`
	FootprintZ int `json:"footprintZ,omitempty"`
	// YardMap — the FBI's per-square occupancy string (o = solid, c = open
	// with the yard, y = passable); the sim parses it into the footprint
	// grid that drives structure collision and factory walk-through.
	YardMap string `json:"yardMap,omitempty"`

	// Categories — the FBI Category token list, upper-cased. The selection
	// hotkeys reference these (TA:K's "SelectUnits BALLISTIC", TA's literal
	// CTRL_x membership tokens).
	Categories []string `json:"categories,omitempty"`

	// Sounds — flattened from sound.tdf's section for the unit's
	// SoundCategory field.  The map's keys are the canonical TA
	// event names (select1, ok1, arrived1, activate, deactivate,
	// cant1, underattack, ...) and the values are sound names — the
	// .wav stem that the client appends to /api/studio/sound/ to
	// fetch.  Empty when the unit has no SoundCategory or the
	// resolved section is missing from sound.tdf.
	Sounds map[string]string `json:"sounds,omitempty"`

	// BuildOptions lists the units this unit can construct, lower-cased and
	// in the game's menu order — resolved by the game adapter from sidedata
	// CANBUILD (TA), canbuild/ grants (TA:K), and download menu add-ons.
	BuildOptions []string `json:"buildOptions,omitempty"`

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

	// Corpse chain, resolved through the feature registry so the sandbox can
	// swap a destroyed unit for its wreck without a second lookup:
	// CorpseObject is the FBI corpse= feature's 3DO; CorpseHeapObject the
	// featuredead follow-up (the damaged wreck a heavier kill leaves).
	CorpseObject     string `json:"corpseObject,omitempty"`
	CorpseHeapObject string `json:"corpseHeapObject,omitempty"`
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
	WeaponID   int     `json:"weaponId"`
	Name       string  `json:"name"`       // FBI Weapon1/2/3 value (TDF section key), uppercased
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

	// EffectClass / TakType: the same per-weapon presentation class the
	// pack's weapons.json carries (see pack_weapons.go) so the studio
	// sandbox gates light/glow identically — a TA:K arrow stays a dark
	// physical object in the sandbox too.
	EffectClass string `json:"effectClass,omitempty"`
	TakType     string `json:"takType,omitempty"`

	// Trajectory / targeting category flags.
	Turret       bool `json:"turret"`       // 360° turret-mounted, free pitch
	LineOfSight  bool `json:"lineOfSight"`  // straight-line shot, gravity ignored
	Guidance     bool `json:"guidance"`     // guided, homes using TurnRate
	WaterWeapon  bool `json:"waterWeapon"`  // travels through water (torpedoes)
	TwoPhase     bool `json:"twoPhase"`     // converts to a second weapon mid-flight
	NoAutoRange  bool `json:"noAutoRange"`  // never auto-detonates at max range
	BurnBlow     bool `json:"burnBlow"`     // detonates at end of range
	Propeller    bool `json:"propeller"`    // projectile model has a spinning prop
	UnitsOnly    bool `json:"unitsOnly"`    // only detonates on units, not terrain
	Targetable   bool `json:"targetable"`   // can be shot down by interceptors
	Interceptor  bool `json:"interceptor"`  // shoots down other weapons
	Meteor       bool `json:"meteor"`       // meteor-shower style area weapon
	Paralyzer    bool `json:"paralyzer"`    // stuns rather than damages
	NoExplode    bool `json:"noExplode"`    // no explosion on impact
	NoRadar      bool `json:"noRadar"`      // invisible to radar
	GroundBounce bool `json:"groundBounce"` // bounces off the ground
	Stockpile    bool `json:"stockpile"`    // must be built/stockpiled before firing
	ToAirWeapon  bool `json:"toAirWeapon"`  // anti-air only
	StartFire    bool `json:"startFire"`    // ignites a fire at the firing point
	SoundTrigger bool `json:"soundTrigger"` // re-plays SoundStart on each burst shot
	StartSmoke   bool `json:"startSmoke"`   // puff of smoke at the muzzle on fire
	EndSmoke     bool `json:"endSmoke"`     // puff of smoke at the terminal point

	// Integer tuning fields (TA angle units = 65536 / circle where noted).
	Coverage       int `json:"coverage"`       // anti-missile protection radius
	Firestarter    int `json:"firestarter"`    // % chance to start a fire (0..100)
	EnergyPerShot  int `json:"energyPerShot"`  // energy drained per shot
	MetalPerShot   int `json:"metalPerShot"`   // metal drained per shot
	EnergyCost     int `json:"energyCost"`     // TDF `energy` (build/stockpile cost)
	MetalCost      int `json:"metalCost"`      // TDF `metal` (build/stockpile cost)
	ShakeMagnitude int `json:"shakeMagnitude"` // screen-shake strength on fire
	MinBarrelAngle int `json:"minBarrelAngle"` // min barrel pitch, degrees (may be negative)
	SprayAngle     int `json:"sprayAngle"`     // burst spread, TA angle units
	Accuracy       int `json:"accuracy"`       // inaccuracy, TA angle units (0 = perfect)
	AimRate        int `json:"aimRate"`        // aim speed, TA angle units / sec
	HoldTime       int `json:"holdTime"`       // TDF `holdtime`

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

func (sess *Session) handleUnitMeta(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/unit/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing unit name", http.StatusBadRequest)
		return
	}
	// Per-slot weapon overrides from the query string
	// (`?weapon1=NAME&weapon2=NAME&weapon3=NAME`) — the studio's "Change
	// Weapon" picker swaps one slot's data without touching the FBI on disk.
	var overrides [3]string
	for i, key := range []string{"weapon1", "weapon2", "weapon3"} {
		overrides[i] = strings.TrimSpace(r.URL.Query().Get(key))
	}
	out, err := sess.buildUnitMeta(name, overrides)
	if err != nil {
		// 404 for missing FBI — many 3DOs ship without a unit ref
		// (props / features).  Client treats absence as "no controls
		// available" and the buttons stay greyed out.
		http.Error(w, "unit fbi not found", http.StatusNotFound)
		return
	}
	writeJSON(w, out)
}

// buildUnitMeta resolves a unit's FBI (plus its weapon TDFs, movement class,
// sounds, build options and corpse chain) into the unitMetaJSON shape.
// Shared by the live /api/studio/unit endpoint and the pack extractor.
// overrides carries optional per-slot weapon-name substitutions; empty
// strings keep the FBI values.
func (sess *Session) buildUnitMeta(name string, overrides [3]string) (*unitMetaJSON, error) {
	name = strings.ToLower(strings.TrimSuffix(name, ".fbi"))
	unit, err := sess.loadUnitFBI(name)
	if err != nil {
		return nil, err
	}
	info := &unit.Info
	out := unitMetaJSON{
		Name:         name,
		MaxVelocity:  info.MaxVelocity,
		TurnRate:     float64(info.TurnRate),
		Acceleration: info.Acceleration,
		BrakeRate:    info.BrakeRate,
		MaxDamage:    info.MaxDamage,
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
	tedClass := strings.ToUpper(strings.TrimSpace(info.TEDClass))
	catTokens := categoryTokens(info.Category)
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
	if info.CanFly == 1 {
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
		if info.Floater == 1 || catTokens["SHIP"] {
			out.IsShip = true
		} else {
			out.IsSub = true
		}
	}
	// HoverAttack=1 → unit can stop and rotate in place (gunship-
	// style).  Without it, fixed-wing aircraft must keep moving
	// (the studio's flight scheduler arcs them around the target).
	out.IsHover = info.HoverAttack == 1
	// Hovercraft vehicles tag themselves with the HOVER Category token
	// (Construction Hovercraft, Anaconda, ...).  They drive on the ground
	// plane but ride an air cushion, so the studio gives them a procedural
	// hover sway.  Don't treat aircraft as hovercraft.
	out.IsHovercraft = catTokens["HOVER"] && !out.IsAircraft
	// BankScale / PitchScale — only meaningful for aircraft.  TA defaults both
	// to 1 when the FBI omits them, so surface 1 for any flier and 0 otherwise
	// (the renderer skips banking when the scale is 0).
	if out.IsAircraft {
		out.BankScale = info.BankScale
		if out.BankScale <= 0 {
			out.BankScale = 1
		}
		out.PitchScale = info.PitchScale
		if out.PitchScale <= 0 {
			out.PitchScale = 1
		}
	}
	// Builder=1 covers both factories (Builder + YardMap) and
	// construction units (Builder + WorkerTime > 0).  The studio
	// only needs the boolean for panel gating; per-class behaviour
	// (factory vs construction) isn't differentiated here.
	out.IsBuilder = info.Builder == 1
	out.ActivateWhenBuilt = info.ActivateWhenBuilt == 1
	out.BuildTime = float64(info.BuildTime)
	out.WorkerTime = info.WorkerTime
	out.BuildDistance = info.BuildDistance
	out.CostMetal = info.BuildCostMetal
	out.CostEnergy = float64(info.BuildCostEnergy)
	out.CostMana = float64(info.BuildCost)
	out.StandingMoveOrder = info.StandingMoveOrder
	out.StandingFireOrder = info.StandingFireOrder
	if info.TransportCapacity > 0 || info.TransMaxUnits > 0 {
		out.TransportSlots = info.TransMaxUnits
		if out.TransportSlots == 0 {
			size := info.TransportSize
			if size <= 0 {
				size = 1
			}
			out.TransportSlots = info.TransportCapacity / size
		}
		if out.TransportSlots < 1 {
			out.TransportSlots = 1
		}
	}
	out.MakesMetal = info.MetalMake + info.MakesMetal + info.ExtractsMetal
	// Solar-style generators express output as NEGATIVE EnergyUse (the sign
	// lets the engine stop the income when the structure is toggled off);
	// EnergyMake is the always-on form. Sum both shapes of income.
	out.MakesEnergy = info.EnergyMake
	if info.EnergyUse < 0 {
		out.MakesEnergy -= info.EnergyUse
	} else if info.EnergyUse > 0 {
		out.UsesEnergy = info.EnergyUse
	}
	out.MakesMana = info.ManaRechargeRate + info.MogriumIncome
	out.MogriumIncome = info.MogriumIncome
	out.MogriumStorage = float64(info.MogriumStorage)
	out.StoresMetal = float64(info.MetalStorage)
	out.StoresEnergy = float64(info.EnergyStorage)
	out.StoresMana = float64(info.MaxMana)
	out.FootprintX = info.FootprintX
	out.FootprintZ = info.FootprintZ
	out.YardMap = strings.Join(strings.Fields(info.YardMap), " ")
	out.MaxSlope = info.MaxSlope
	out.MaxWaterDepth = info.MaxWaterDepth
	out.MinWaterDepth = info.MinWaterDepth
	// A unit naming a MovementClass takes its traversal profile from
	// gamedata/moveinfo.tdf — the class is authoritative for pathing in
	// both games (the commander's own MaxSlope=20 is overridden by
	// TANKDS2's 32, which is why he climbs hills the bare FBI forbids).
	if mc := sess.moveClass(info.MovementClass); mc != nil {
		if mc.MaxSlope > 0 {
			out.MaxSlope = mc.MaxSlope
		}
		if mc.MaxWaterDepth > 0 {
			out.MaxWaterDepth = mc.MaxWaterDepth
		}
		if mc.MinWaterDepth > 0 {
			out.MinWaterDepth = mc.MinWaterDepth
		}
	}
	out.Title = strings.TrimSpace(info.Name)
	if d := strings.TrimSpace(info.Description); d != "" {
		if out.Title != "" {
			out.Title += " — " + d
		} else {
			out.Title = d
		}
	}
	for _, tok := range info.Category {
		if t := strings.ToUpper(strings.TrimSpace(tok)); t != "" {
			out.Categories = append(out.Categories, t)
		}
	}
	// onoffable=1 — unit can be manually toggled on/off by the
	// player (Radar, Solar, Adv Fusion).
	out.OnOffable = info.OnOffable == 1
	// CruiseAltitude: FBI `CruiseAlt` for aircraft, otherwise 0.
	// Defaults pick a sensible mid-air position when the FBI is
	// silent (some unit FBIs omit the field).
	if out.IsAircraft {
		out.CruiseAltitude = info.CruiseAlt
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
	// Per-slot overrides (the endpoint's ?weapon1=NAME&weapon2=NAME&
	// weapon3=NAME query parameters) let the studio's "Change Weapon"
	// picker swap one slot's data without touching the FBI on disk.
	// When set, the override beats the FBI value for that slot.  A value
	// of "NONE" / "-" clears the slot (useful to disable a weapon for
	// testing).
	out.Weapons = []unitWeaponJSON{
		{Slot: "primary", Index: 1},
		{Slot: "secondary", Index: 2},
		{Slot: "tertiary", Index: 3},
	}
	fbiWeapons := []string{info.Weapon1, info.Weapon2, info.Weapon3}
	for i := range fbiWeapons {
		w := strings.ToUpper(strings.TrimSpace(fbiWeapons[i]))
		// Per-slot override — wins over FBI.
		if overrides[i] != "" {
			w = strings.ToUpper(overrides[i])
		}
		if w == "" || w == "NONE" || w == "-" {
			continue
		}
		out.Weapons[i].Name = w
		if sec := sess.loadWeaponSection(w); sec != nil {
			populateWeaponJSON(&out.Weapons[i], sec)
		}
	}
	// TA: Kingdoms inlines each weapon as a top-level [WEAPONn] sibling of
	// [UNITINFO] instead of referencing weapons/*.tdf, so the ref loop above
	// finds nothing. Re-parse the FBI against the TA:K schema and fill any
	// slot that is still empty.
	if data, err := sess.loadUnitFBIBytes(name); err == nil {
		var ku tak.Unit
		if err := tdf.Unmarshal(data, &ku); err == nil {
			for i, sec := range []*tak.Weapon{ku.Weapon1, ku.Weapon2, ku.Weapon3} {
				if sec == nil || out.Weapons[i].Name != "" {
					continue
				}
				populateWeaponJSONFromTAK(&out.Weapons[i], sec)
			}
		}
	}
	// Death explosion FBI refs — surfaced for the client's death-FX
	// path.  Uppercased so the eventual /api/studio/weapon-fx/<name>
	// fetch matches the weapon-by-name resolver (which lowercases for
	// comparison anyway).  The resolved blast stats ride alongside so the
	// sim deals data-faithful splash damage on death.
	out.ExplodeWeapon = sess.resolveExplosion(info.ExplodeAs)
	out.SelfDestructWeapn = sess.resolveExplosion(info.SelfDestructAs)
	out.ExplodeAs = strings.ToUpper(strings.TrimSpace(info.ExplodeAs))
	out.SelfDestructAs = strings.ToUpper(strings.TrimSpace(info.SelfDestructAs))
	// Sounds — the game adapter resolves SoundCategory into an event map
	// (TA: gamedata/sound.tdf classes; TA:K: per-class soundclasses/ pools
	// mapped onto the same numbered keys).  The whitelist keeps a mod from
	// injecting events the client never plays.
	if cat := strings.ToUpper(strings.TrimSpace(info.SoundCategory)); cat != "" {
		if events := sess.palettes().UnitSounds(cat); len(events) > 0 {
			out.Sounds = make(map[string]string)
			for _, key := range soundEventKeys {
				if v := strings.TrimSpace(events[key]); v != "" {
					out.Sounds[key] = strings.ToLower(v)
				}
			}
		}
	}
	out.BuildOptions = sess.palettes().BuildOptions(name)
	// Corpse chain: FBI corpse= names a wreck feature whose object= is the
	// 3DO the sandbox renders when the unit dies; its featuredead chains to
	// the damaged wreck used for heavier kills (Killed corpsetype 2).
	if corpse := strings.ToLower(strings.TrimSpace(info.Corpse)); corpse != "" {
		_, byName := sess.scanFeatures()
		if f, ok := byName[corpse]; ok {
			out.CorpseObject = strings.ToLower(strings.TrimSpace(f.Object))
			if dead := strings.ToLower(strings.TrimSpace(f.FeatureDead)); dead != "" {
				if hf, ok := byName[dead]; ok {
					out.CorpseHeapObject = strings.ToLower(strings.TrimSpace(hf.Object))
				}
			}
		}
	}
	return &out, nil
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

// loadUnitFBI finds the units/<name>.fbi by walking the VFS for a
// case-insensitive match.  Unit names in the file system are
// frequently mixed-case (e.g. ARMCOM.FBI) so we don't trust a
// straight ReadFile.
// moveClass resolves a unit's MovementClass name against the game's
// gamedata/moveinfo.tdf (parsed once per session). Returns nil for an
// empty name, an unknown class, or a game without the file.
func (sess *Session) moveClass(name string) *ta.MovementClass {
	name = strings.ToUpper(strings.TrimSpace(name))
	if name == "" {
		return nil
	}
	sess.moveClassOnce.Do(func() {
		sess.moveClassMap = map[string]*ta.MovementClass{}
		for _, p := range []string{"gamedata/moveinfo.tdf", "gamedata/MOVEINFO.TDF", "GameData/moveinfo.tdf"} {
			data, err := sess.vfs.ReadFile(p)
			if err != nil {
				continue
			}
			var classes []ta.MovementClass
			if err := tdf.Unmarshal(data, &classes); err != nil {
				continue
			}
			for i := range classes {
				if n := strings.ToUpper(strings.TrimSpace(classes[i].Name)); n != "" {
					sess.moveClassMap[n] = &classes[i]
				}
			}
			break
		}
	})
	return sess.moveClassMap[name]
}

func (sess *Session) loadUnitFBI(name string) (*ta.Unit, error) {
	data, err := sess.loadUnitFBIBytes(name)
	if err != nil {
		return nil, err
	}
	var u ta.Unit
	if err := tdf.Unmarshal(data, &u); err != nil {
		return nil, err
	}
	return &u, nil
}

// loadUnitFBIBytes returns the raw units/<name>.fbi contents using the same
// case-insensitive resolution as loadUnitFBI, so callers can re-parse the
// file against a different schema (TA:K's inline [WEAPONn] sections).
func (sess *Session) loadUnitFBIBytes(name string) ([]byte, error) {
	candidates := []string{
		"units/" + name + ".fbi",
		"units/" + strings.ToUpper(name) + ".FBI",
		"Units/" + name + ".fbi",
	}
	for _, p := range candidates {
		if data, err := sess.vfs.ReadFile(p); err == nil {
			return data, nil
		}
	}
	// Last-ditch: walk the entire VFS for a case-insensitive name match.
	want := strings.ToLower(name + ".fbi")
	for _, p := range sess.vfs.List() {
		if strings.ToLower(basename(p)) == want {
			if data, err := sess.vfs.ReadFile(p); err == nil {
				return data, nil
			}
		}
	}
	return nil, errFBINotFound
}

// populateWeaponJSONFromTAK copies a TA:K inline [WEAPONn] section into the
// slot JSON. TA:K weapon blocks carry a subset of TA's fields (no burst, no
// beam flag, no projectile 3DO); the [DAMAGE] table's `default=` is the
// absolute hit damage and the remaining keys are per-category multipliers,
// so only the default feeds the engine's damage figure.
func populateWeaponJSONFromTAK(out *unitWeaponJSON, sec *tak.Weapon) {
	name := strings.ToUpper(strings.TrimSpace(sec.Name))
	if name == "" {
		name = "WEAPON" + strconv.Itoa(out.Index)
	}
	out.Name = name
	out.ReloadSec = sec.ReloadTime
	out.RangeWU = float64(sec.Range)
	out.VelocityWU = sec.WeaponVelocity
	typ := strings.ToLower(strings.TrimSpace(sec.Type))
	out.Ballistic = typ == "ballistic" && !strings.EqualFold(strings.TrimSpace(sec.SubType), "dropped")
	out.Dropped = strings.EqualFold(strings.TrimSpace(sec.SubType), "dropped")
	out.Guidance = typ == "guided"
	out.TurnRate = sec.TurnRate
	out.Model = strings.ToLower(strings.TrimSpace(sec.Model))
	out.EffectClass = takEffectClass(sec)
	out.TakType = typ
	out.Burst = 1
	out.AreaOfEffectWU = float64(sec.AreaOfEffect)
	out.EdgeEffectiveness = sec.EdgeEffectiveness
	out.Tolerance = sec.AimTolerance
	if d, ok := sec.Damage["default"]; ok {
		out.DamageDefault = int(d)
	}
}

// explosionJSON is a resolved death-blast stat block: the explodeas /
// selfdestructas weapon's per-shot damage, blast diameter (world units) and
// edge falloff fraction (damage multiplier at the blast rim, 0..1).
type explosionJSON struct {
	Damage            float64 `json:"damage"`
	AreaOfEffectWU    float64 `json:"areaOfEffectWU"`
	EdgeEffectiveness float64 `json:"edgeEffectiveness"`
}

// resolveExplosion loads a death-blast weapon ref into its stat block, or
// nil when the FBI names none / the ref doesn't resolve.
func (sess *Session) resolveExplosion(name string) *explosionJSON {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	sec := sess.loadWeaponSection(name)
	if sec == nil {
		return nil
	}
	var w unitWeaponJSON
	populateWeaponJSON(&w, sec)
	return &explosionJSON{
		Damage:            float64(w.DamageDefault),
		AreaOfEffectWU:    w.AreaOfEffectWU,
		EdgeEffectiveness: w.EdgeEffectiveness,
	}
}

// loadWeaponSection finds the weapons/*.tdf section whose key
// matches `name` (case-insensitive).  Returns nil when no weapons
// folder ships or the ref doesn't resolve — the client treats that
// as "use default reload" and the Fire button still works.
func (sess *Session) loadWeaponSection(name string) *ta.Weapon {
	want := strings.ToUpper(strings.TrimSpace(name))
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
		for i := range weapons {
			if strings.ToUpper(weapons[i].Key) == want {
				return &weapons[i]
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
func populateWeaponJSON(out *unitWeaponJSON, sec *ta.Weapon) {
	lc := func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
	out.WeaponID = sec.ID
	out.ReloadSec = sec.ReloadTime
	out.RangeWU = float64(sec.Range)
	out.VelocityWU = sec.WeaponVelocity
	out.Ballistic = sec.Ballistic != 0
	out.SoundStart = lc(sec.SoundStart)
	out.SoundHit = lc(sec.SoundHit)
	burst := sec.Burst
	if burst < 1 {
		burst = 1
	}
	out.Burst = burst
	out.BurstRateSec = sec.BurstRate
	out.BeamWeapon = sec.BeamWeapon != 0
	out.SmokeTrail = sec.SmokeTrail != 0
	out.SelfProp = sec.SelfProp != 0
	out.Tracks = sec.Tracks != 0
	out.StartVelocityWU = sec.StartVelocity
	out.AccelerationWU = sec.WeaponAcceleration
	out.ColorIdx = sec.Color
	out.Color2Idx = sec.Color2
	out.Model = lc(sec.Model)
	out.DurationSec = sec.Duration
	out.CommandFire = sec.CommandFire != 0
	out.Dropped = sec.Dropped != 0
	out.VLaunch = sec.VLaunch != 0
	out.Tolerance = sec.Tolerance
	out.PitchTolerance = sec.PitchTolerance
	out.TurnRate = sec.TurnRate
	out.FlightTimeSec = sec.WeaponTimer
	out.Cruise = sec.Cruise != 0
	out.AreaOfEffectWU = float64(sec.AreaOfEffect)

	// Render method + trajectory/targeting category flags.
	out.RenderType = sec.RenderType
	out.EffectClass = taEffectClass(sec)
	out.Turret = sec.Turret != 0
	out.LineOfSight = sec.LineOfSight != 0
	out.Guidance = sec.Guidance != 0
	out.WaterWeapon = sec.WaterWeapon != 0
	out.TwoPhase = sec.TwoPhase != 0
	out.NoAutoRange = sec.NoAutoRange != 0
	out.BurnBlow = sec.BurnBlow != 0
	out.Propeller = sec.Propeller != 0
	out.UnitsOnly = sec.UnitsOnly != 0
	out.Targetable = sec.Targetable != 0
	out.Interceptor = sec.Interceptor != 0
	out.Meteor = sec.Meteor != 0
	out.Paralyzer = sec.Paralyzer != 0
	out.NoExplode = sec.NoExplode != 0
	out.NoRadar = sec.NoRadar != 0
	out.GroundBounce = sec.GroundBounce != 0
	out.Stockpile = sec.Stockpile != 0
	out.ToAirWeapon = sec.ToAirWeapon != 0
	out.StartFire = sec.StartFire != 0
	out.SoundTrigger = sec.SoundTrigger != 0
	out.StartSmoke = sec.StartSmoke != 0
	out.EndSmoke = sec.EndSmoke != 0

	// Integer tuning fields.
	out.Coverage = sec.Coverage
	out.Firestarter = int(sec.FireStarter)
	out.EnergyPerShot = int(sec.EnergyPerShot)
	out.MetalPerShot = sec.MetalPerShot
	out.EnergyCost = sec.Energy
	out.MetalCost = sec.Metal
	out.ShakeMagnitude = sec.ShakeMagnitude
	out.MinBarrelAngle = int(sec.MinBarrelAngle)
	out.SprayAngle = sec.SprayAngle
	out.Accuracy = sec.Accuracy
	out.AimRate = sec.AimRate
	out.HoldTime = sec.HoldTime

	// Floating-point timing / falloff fields.
	out.EdgeEffectiveness = sec.EdgeEffectiveness
	out.SmokeDelaySec = sec.SmokeDelay
	out.ShakeDurationSec = sec.ShakeDuration
	out.RandomDecaySec = sec.RandomDecay
	out.FlightTime = sec.FlightTime

	// Explosion art references + water-impact sound.
	out.ExplosionGaf = lc(sec.ExplosionGAF)
	out.ExplosionArt = lc(sec.ExplosionArt)
	out.WaterExplosionGaf = lc(sec.WaterExplosionGAF)
	out.WaterExplosionArt = lc(sec.WaterExplosionArt)
	out.LavaExplosionGaf = lc(sec.LavaExplosionGAF)
	out.LavaExplosionArt = lc(sec.LavaExplosionArt)
	out.SoundWater = lc(sec.SoundWater)

	// Nested [DAMAGE] table — `default=` plus per-target-name overrides.
	// Keys are lowercased so a client lookup by unit name is case-stable.
	if len(sec.Damage) > 0 {
		dmg := make(map[string]int, len(sec.Damage))
		for k, v := range sec.Damage {
			dmg[strings.ToLower(strings.TrimSpace(k))] = v
		}
		out.Damage = dmg
		out.DamageDefault = dmg["default"]
	}
}

// weaponsListMu / weaponsListOnce / weaponsListCache cache the parsed
// catalogue for the server lifetime — walking every weapons/*.tdf and
// re-parsing on each picker open would be wasteful for a list that
// doesn't change after startup.
// buildWeaponsList walks every weapons/*.tdf in the VFS and emits one
// JSON entry per section.  Slot / Index are left zero — the catalogue
// is unit-agnostic; the client assigns those when the user picks one
// for a specific slot.  Sorted alphabetically by name so the picker's
// stable ordering doesn't depend on directory walk order.
func (sess *Session) buildWeaponsList() []unitWeaponJSON {
	seen := map[string]bool{}
	out := []unitWeaponJSON{}
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
		for i := range weapons {
			name := strings.ToUpper(strings.TrimSpace(weapons[i].Key))
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			w := unitWeaponJSON{Name: name}
			populateWeaponJSON(&w, &weapons[i])
			out = append(out, w)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// handleWeaponsList serves the cached weapon catalogue.
func (sess *Session) handleWeaponsList(w http.ResponseWriter, _ *http.Request) {
	sess.weaponsListOnce.Do(func() {
		sess.weaponsListCache = sess.buildWeaponsList()
	})
	sess.weaponsListMu.Lock()
	defer sess.weaponsListMu.Unlock()
	writeJSON(w, sess.weaponsListCache)
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
func (sess *Session) handleCursorImage(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimPrefix(r.URL.Path, "/api/studio/cursor/")
	name, err := url.PathUnescape(raw)
	if err != nil || name == "" {
		http.Error(w, "missing cursor name", http.StatusBadRequest)
		return
	}
	pngBytes, err := sess.renderCursorPNG(name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(pngBytes)
}

// loadCursorSequences opens the game's cursors GAF and returns its
// sequences.  The returned reader must be closed by the caller.
func (sess *Session) loadCursorSequences() (*gaf.Reader, []*gaf.Sequence, error) {
	// Anims/cursors.gaf is the standard location; some assets use
	// the lowercased path.  Walk a small candidate list.
	gafCandidates := []string{
		"anims/cursors.gaf",
		"Anims/cursors.gaf",
	}
	var data []byte
	for _, p := range gafCandidates {
		if b, e := sess.vfs.ReadFile(p); e == nil {
			data = b
			break
		}
	}
	if data == nil {
		return nil, nil, errCursorsNotFound
	}
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil, nil, fmt.Errorf("load gaf: %w", err)
	}
	seqs, err := reader.ReadSequences()
	if err != nil {
		_ = reader.Close()
		return nil, nil, fmt.Errorf("read sequences: %w", err)
	}
	return reader, seqs, nil
}

var errCursorsNotFound = fmt.Errorf("cursors.gaf not found")

// renderCursorPNG renders a named cursor sequence to PNG (APNG when the
// sequence animates).  Shared by the live cursor endpoint and the pack
// extractor.
func (sess *Session) renderCursorPNG(name string) ([]byte, error) {
	reader, seqs, err := sess.loadCursorSequences()
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()
	want := strings.ToLower(strings.TrimSpace(name))
	var target *gaf.Sequence
	for _, s := range seqs {
		if strings.ToLower(s.Name) == want {
			target = s
			break
		}
	}
	if target == nil || len(target.Frames) == 0 {
		return nil, fmt.Errorf("cursor sequence not found")
	}
	return sess.encodeCursorSequencePNG(target)
}

// encodeCursorSequencePNG encodes one cursor sequence as PNG/APNG with the
// game's cursor palette + transparency conventions.
func (sess *Session) encodeCursorSequencePNG(target *gaf.Sequence) ([]byte, error) {
	// The game adapter supplies a cursor palette when the game ships one
	// (TA:K's anims/cursors.pcx sidecar); nil means use the global palette,
	// which is TA's convention.
	pal := sess.palettes().CursorPalette()
	if pal == nil {
		p, err := gaf.LoadPaletteFromBytes(sess.loadPaletteBytes())
		if err != nil {
			return nil, fmt.Errorf("load palette: %w", err)
		}
		pal = p
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
			return nil, fmt.Errorf("encode apng: %w", err)
		}
	} else {
		if err := target.Frames[0].ToPNGWith(pal, opts, &buf); err != nil {
			return nil, fmt.Errorf("encode png: %w", err)
		}
	}
	return buf.Bytes(), nil
}
