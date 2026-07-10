package sim

import "github.com/coreprime/kbot/engine/fixed"

// UnitMeta is the FBI-derived stat block a unit type carries into the
// simulation. Floats from the parsed FBI are converted to fixed-point exactly
// once, here at the asset boundary, so the tick loop only ever sees integers.
type UnitMeta struct {
	Name string

	CanMove     bool
	MaxVelocity fixed.Fixed // world-units per frame (30 Hz)
	TurnRate    fixed.Fixed // TA-angle per frame
	Accel       fixed.Fixed // world-units per frame^2
	BrakeRate   fixed.Fixed // world-units per frame^2

	IsAircraft     bool
	IsHover        bool
	IsShip         bool
	IsSub          bool
	IsHovercraft   bool
	CruiseAltitude fixed.Fixed

	// Locomotion capability flags straight off the FBI. CanHover|Floater is
	// the engines' exemption mask for the underwater half-speed cap; Upright
	// units terrain-snap Y only (they stand vertical), so their pitch stays 0
	// and the slope-speed table never bites them.
	CanHover bool
	Floater  bool
	Upright  bool

	// WaterLine (FBI waterline, height units) is how high above the sea-level
	// byte a floater's hull rides; it pins a ship's Y.
	WaterLine fixed.Fixed

	// MoveRate1/2 are the walk-animation tier thresholds (wu/frame, 16.16).
	// Zero means the FBI omitted them; the engines default both to
	// 2×maxvelocity at load, so stock units never leave tier 1.
	MoveRate1 fixed.Fixed
	MoveRate2 fixed.Fixed

	// TA:K per-unit stat multipliers (16.16): watermultiplier scales the
	// kinematic stats while the unit stands in water (default 1.0),
	// roadmultiplier while on a road (default 1.2). Zero = FBI omitted.
	WaterMult fixed.Fixed
	RoadMult  fixed.Fixed

	// MovementClass names the moveinfo.tdf traversal profile; when it
	// resolves, the class's footprint/water-depth/slope fields replace the
	// FBI's own values entirely (games.ApplyMovementClass).
	MovementClass string

	// Terrain limits (FBI maxslope / maxwaterdepth / minwaterdepth, in
	// height units): the steepest cell delta the unit climbs, the deepest
	// water a surface unit wades, the shallowest water a ship needs.
	MaxSlope      int
	MaxWaterDepth int
	MinWaterDepth int

	IsBuilder bool
	OnOffable bool
	// IsAirBase marks an air repair pad (FBI isairbase): a landed aircraft
	// attaches to it to rearm and repair, and the pad holds the aircraft until
	// servicing finishes.
	IsAirBase bool
	// ActivateWhenBuilt — the unit's Activate script runs the moment its
	// construction completes (FBI activatewhenbuilt; ARM Solar's panels).
	ActivateWhenBuilt bool

	// Construction stats. BuildTime is the unit's own build-effort points
	// (FBI buildtime — how long IT takes to construct); WorkerTime is the
	// builder's effort output per second (FBI workertime); BuildDistance is
	// how close (wu) a mobile builder must stand to its construction site.
	BuildTime     fixed.Fixed
	WorkerTime    int
	BuildDistance fixed.Fixed

	// FootprintX/Z are the FBI footprint in map squares; collisionRadius
	// derives the body circle the collision/avoidance passes use.
	FootprintX int
	FootprintZ int

	// TransportSlots — how many units this transport carries (0 = not a
	// transport).
	TransportSlots int

	// Yard is the parsed YardMap occupancy grid (row-major FootprintZ rows ×
	// FootprintX cols). Nil means the whole footprint is solid. Only standing
	// structures collide by yard; mobile units stay on the circle model.
	Yard []yardCell

	// Resource prices (TA metal+energy, TA:K mana), kept in fixed point for
	// the HUD/usage stats. The authoritative economy math reads the
	// float32 Econ block below instead — both engines run their economies
	// in IEEE single precision, which Q16.16 cannot represent exactly
	// (e.g. extractsmetal=0.001).
	CostMetal  fixed.Fixed
	CostEnergy fixed.Fixed
	CostMana   fixed.Fixed

	// Econ is the exact float32 economy stat block (see EconMeta).
	Econ EconMeta

	// Default standing orders the unit spawns with (FBI standingmoveorder /
	// standingfireorder, already resolved to the game defaults — Maneuver /
	// Fire at Will — when the FBI is silent).
	StandMove uint8
	StandFire uint8

	// Death blasts: the resolved explodeas weapon (ordinary death) and
	// selfdestructas weapon (Ctrl+D). Damage is absolute per-shot, AoE the
	// blast diameter in world units, Edge the damage fraction left at the
	// rim. A zero-damage blast deals no splash (visual only).
	Explode Blast
	SelfD   Blast

	// Economy contributions per second while the unit stands (generation)
	// and the storage capacity it adds to its side's pools. The sandbox
	// never gates on stock — these feed the economy bar's accounting only.
	MakeMetal   fixed.Fixed
	MakeEnergy  fixed.Fixed
	MakeMana    fixed.Fixed
	StoreMetal  fixed.Fixed
	StoreEnergy fixed.Fixed
	StoreMana   fixed.Fixed

	// MaxHealth is the unit's absolute hit points (FBI maxdamage). The sim's
	// health bar stays on a 0..100 scale; ApplyDamage divides each weapon's
	// absolute damage by this to land TDF-faithful percentage hits. Zero
	// means unknown — damage then applies at face value, the legacy scale.
	MaxHealth fixed.Fixed

	// Combat identity keys, filled by games.EnrichCombatMeta. ObjectName is
	// the TA FBI objectname (falling back to unitname), lower-cased — the key
	// a TA weapon's per-target [DAMAGE] table matches when THIS unit is the
	// victim. DamageCategory is the TA:K category string (lower-cased) that
	// selects a fractional multiplier row from a TA:K weapon's table.
	ObjectName     string
	DamageCategory string

	// CombatBoxHalfX/Z are the splash bounding-box stand-in's half-extents
	// (wu), derived by the asset bridge from the unit's OWN FBI footprint
	// (8 wu of box per square) before any movement-class replacement — the
	// movement class re-sizes the locomotion footprint, not the body splash
	// distance is measured against. CombatBoxSet distinguishes an explicit
	// zero (point body) from an unenriched meta.
	CombatBoxSet   bool
	CombatBoxHalfX fixed.Fixed
	CombatBoxHalfZ fixed.Fixed

	// ExperiencePoints is the TA:K per-type experience figure: the XP a
	// killer earns for destroying this unit AND the divisor this unit levels
	// against (level = xp/experiencepoints, capped at 10). Zero for TA units
	// (whose veterancy runs on raw kill counts instead).
	ExperiencePoints int

	// --- Special-mechanic flags & figures (Block 6; specials.md) ---

	// CanCapture / CanReclaim / CanResurrect are the FBI capability bits.
	// CanCapture also serves as the immunity gate: a target that itself
	// cancapture cannot be captured OR reclaimed (why Commanders are immune to
	// both). Commander marks the TA:K monarch / cantbecaptured mind-control
	// immunity.
	CanCapture   bool
	CanReclaim   bool
	CanResurrect bool
	Commander    bool
	// CantBeCaptured is the TA:K per-unit conversion immunity (FBI
	// cantbecaptured); TA has no such per-unit flag (cancapture doubles as it).
	CantBeCaptured bool

	// Cloak drain (TA cloakcost / cloakcostmoving, energy per settle;
	// MinCloakDistance the proximity decloak radius in wu). TA:K reads
	// CloakCost/CloakCostMoving as PER-TICK mana off the unit-private pool.
	CanCloak         bool
	CloakCost        float32
	CloakCostMoving  float32
	MinCloakDistance int

	// TA:K unit-private mana pool: MaxMana is the cap, ManaRechargeTick the
	// per-tick free recharge (FBI manarechargerate ÷ 30). The pool spawns
	// EMPTY and recharges for free; spells and TA:K cloak drain it.
	MaxMana          float32
	ManaRechargeTick float32

	// SelfDestructCountdown is the FBI selfdestructcountdown step count (the
	// 3-bit field, TA default 5 / TA:K default 2); the fuse runs 30 ticks per
	// step then a rand(15) final jitter tick.
	SelfDestructCountdown int

	// Kamikaze marks an order-driven kamikaze unit; KamikazeDistance is the
	// standoff radius (wu) the move-to-detonate order approaches to, floored at
	// 16 wu.
	Kamikaze         bool
	KamikazeDistance int

	// HealAura carries a TA:K AdjustJoy healing-aura block when the unit
	// declares one (nil = no aura). Applied every 30 ticks with the inverted
	// falloff polarity (full at the edge).
	HealAura *AuraMeta

	// SacredProducer marks a TA:K unit whose yardmap declares an 'S' (sacred)
	// cell (unitdef+0x264 bit 31): its mogriumincome is credited only when its
	// footprint fully covers a sacred-site feature, multiplied by that
	// feature's sacredsite value (world.md §2.5 / economy.md §4.3).
	SacredProducer bool

	// Geothermal marks a TA geothermal power plant: its FBI yardmap is laid
	// out entirely in 'G' (geothermal) cells, so the plant may be founded only
	// where its footprint overlaps a geothermal vent — the buried heat source
	// it taps. The vent is a geothermal-flagged map feature; canBuildAt refuses
	// the plant on any site the footprint misses one.
	Geothermal bool

	// Wreck is the corpse featuredef the unit leaves on an ordinary death
	// (FBI corpse=, resolved through the feature registry): its reclaim
	// metal/energy yield, hit points and successor-chain name. Nil means the
	// unit blows apart cleanly (no wreck). The asset bridge fills it; the
	// death path (blast.go) spawns a FeatureWreck from it.
	Wreck *FeatureMeta

	Weapons [3]WeaponMeta
}

// AuraMeta is a resolved TA:K AdjustJoy/AdjustArmor/AdjustAttack aura block.
// The sandbox models the AdjustJoy healing aura (§7.4); the armor/attack
// accumulator auras remain a combat-tick seam.
type AuraMeta struct {
	// Adjustment is the aura strength (FBI Adjustment, default 1.0);
	// RadiusWU the effect radius in world units (FBI Radius << … resolves to
	// wu directly here); Edge the EdgeEffectiveness weighting (§7.4 —
	// polarity inverted, so Edge weights the CENTER, full effect at the rim).
	Adjustment   float64
	RadiusWU     int
	Edge         float64
	AffectsEnemy bool
}

// EconMeta carries the FBI economy fields at the width the engines compute
// with: IEEE float32 (both economies are single-precision x87 end to end),
// plus the integer build-effort figures TA divides without rounding. The
// asset bridge fills the TA and TA:K groups from whichever keys the FBI
// declares; the world's economy model decides which group it reads.
type EconMeta struct {
	// TA income & storage, per settle (= per second).
	EnergyMake     float32
	MetalMake      float32
	EnergyUse      float32 // >0 demand, <0 production (solar); ACTIVE-gated
	ExtractsMetal  float32
	MakesMetal     float32 // metal-maker output; energy-satisfied gate
	WindGenerator  float32
	TidalGenerator float32
	EnergyStorage  float32
	MetalStorage   float32

	// TA construction: buildtime is an int32 the engine fild-s, workertime a
	// u16 the callers divide by 30 with unsigned INTEGER division (fractional
	// build power is discarded; workertime 29 cannot build at all).
	BuildTime       int32
	WorkerTime      uint32
	BuildCostEnergy float32
	BuildCostMetal  float32

	// TA:K mana economy. BuildCost/BuildTimeF carry the parse defaults
	// (buildtime <= 0 -> 100; buildcost <= 0 -> buildtime); BuildTimeRecip
	// is the f32 reciprocal computed once at parse and reused (the engine
	// never re-divides).
	ManaIncome     float32
	ManaStorage    float32
	BuildCost      float32
	BuildTimeF     float32
	BuildTimeRecip float32
	WorkerTimeF    float32
	HealTime       float32
}

// aabbHalf is the sandbox's stand-in for the engines' per-model bounding box,
// which splash falloff measures distance to (per-axis clamp, then Euclidean
// length). The sim carries no model geometry, so the box is derived from the
// FBI footprint at half the plot-cell pitch per square — 8 wu of box width per
// footprint square, so a 2x2 vehicle presents an 8 wu half-extent. The
// vertical half-extent mirrors the wider horizontal one; ground detonations
// against ground targets land at dy=0 either way. Footprint-less units (TA:K
// infantry) present a point. Deliberate approximation: the real boxes are
// model data the asset bridge does not surface — revisit if per-model bounds
// ever reach UnitMeta.
func (m *UnitMeta) aabbHalf() (hx, hy, hz fixed.Fixed) {
	if m.CombatBoxSet {
		hx, hz = m.CombatBoxHalfX, m.CombatBoxHalfZ
	} else {
		hx = fixed.FromInt(m.FootprintX * 4)
		hz = fixed.FromInt(m.FootprintZ * 4)
	}
	hy = fixed.Max(hx, hz)
	return hx, hy, hz
}

// Blast is one resolved death-explosion weapon's stat block.
type Blast struct {
	Damage fixed.Fixed
	AoE    fixed.Fixed
	Edge   fixed.Fixed
}

// WeaponMeta holds the per-slot weapon stats the engine acts on.
type WeaponMeta struct {
	Name     string
	Range    fixed.Fixed // world units
	ReloadMs int         // milliseconds between shots
	Burst    int         // shots per burst (>=1)
	Damage   fixed.Fixed // per shot
	Present  bool
	// CommandFire weapons (the D-gun) discharge only on an explicit fire
	// order — one shot per order, never as part of a standing attack.
	CommandFire bool
	// Per-shot economy drain (TDF energypershot / metalpershot).
	EnergyShot fixed.Fixed
	MetalShot  fixed.Fixed

	// Tolerance is the weapon's firing arc in TA-angle units (65536 = full
	// turn); 0 = no arc constraint. Aircraft aim by pointing the whole airframe
	// (no rotating turret), so the body heading must be within tolerance of the
	// target bearing before the weapon may open fire.
	Tolerance int32

	// Ballistic / projectile fields. Every weapon except an instant-hit beam
	// flies a tracked projectile through the subsystem and applies its damage on
	// detonation — a missile/rocket/bomb carries a 3DO mesh, while a cannon shell
	// or EMG bolt flies the same flight path with no model. Tracking the
	// model-less shots is what lets a late joiner restore in-flight cannon/EMG
	// fire, not just missiles. All rates derive from the weapon TDF.
	Model           string      // 3DO projectile model; empty = model-less shot
	BeamWeapon      bool        // instant-hit beam (lasers): never flies
	VelocityWU      fixed.Fixed // top speed, world units/sec
	StartVelocityWU fixed.Fixed // launch speed; 0 = top speed (no ramp)
	AccelerationWU  fixed.Fixed // ramp to top speed, wu/s^2; 0 = instant
	TurnRateAng     int32       // homing turn rate, TA-angle/sec; 0 = unguided
	FlightTimeSec   fixed.Fixed // self-destruct timer; 0 = derive from range/vel
	AreaOfEffectWU  fixed.Fixed // blast diameter for detonation damage
	Dropped         bool        // gravity bomb: released with no thrust
	VLaunch         bool        // vertical launch: climbs then homes
	Tracks          bool        // guided: homes on the target
	SelfProp        bool        // self-propelled (with Tracks + turn rate, homes)
	Ballistic       bool        // unpowered arc under gravity
	// NoExplode marks the disintegrator (D-gun) class: the shot applies its
	// detonation on contact but keeps flying, sweeping units along its whole
	// path. Each detonation's splash catches allies and enemies alike, so the
	// D-gun disintegrates chains of units — friendlies included — and a shot
	// fired near the floor keeps travelling instead of fizzling into terrain.
	NoExplode bool

	// --- Exact firing-cycle / damage fields (games.EnrichCombatMeta) ---

	// ReloadTicks is the reload interval on the 30 Hz tick axis, converted
	// the way the engines parse it: reloadtime read as a single-precision
	// float, multiplied by 30, truncated toward zero. The per-slot counter
	// starts at zero, so the FIRST shot is ready as soon as the aim latch
	// holds — a fresh weapon never waits out a full reload.
	ReloadTicks int
	// BurstRateTicks spaces a burst parent's pellet emissions; Burst (above)
	// is the pellet count. RandomDecayTicks is the ± half-range jitter on a
	// pellet's lifetime.
	BurstRateTicks   int
	RandomDecayTicks int
	// SprayAngle scatters each burst pellet's bearing ±spray/2 (TA-angle
	// units); Accuracy feeds the turret-shot spread formula
	// spread = accuracy + 0x800 − (hp<<11)/maxhp (then /(kills/12) when that
	// quotient reaches 2), applied ±spread/2 to bearing and pitch — two sim
	// RNG draws per turret shot whenever spread ≥ 2.
	SprayAngle int32
	Accuracy   int32
	// Turret marks the TA turret fire handler — the only class the accuracy
	// spread applies to.
	Turret bool

	// DamageDefault is the [DAMAGE] default entry in absolute points,
	// case-folded at parse (retail files mix Default=/default=). DamageTable
	// holds the TA per-target overrides keyed by lower-cased victim
	// objectname: a hit REPLACES the default outright. DamageMult holds the
	// TA:K rows keyed by lower-cased victim damagecategory as fractional
	// MULTIPLIERS of the default (the fractional retail values — 0.5, 0.75 —
	// only make sense as scale factors; absolute-value semantics would leave
	// swords dealing sub-point damage).
	DamageDefault int
	DamageTable   map[string]int
	DamageMult    map[string]float64

	// EdgeEffectiveness is the splash rim fraction e in the shared quadratic
	// falloff e + (1−e)(1 − d/r)²; default 0.
	EdgeEffectiveness float64

	// SelfSplash: TA:K applies a shooter's own splash to the shooter; TA
	// excludes the firing unit from its own blast entirely. Set per weapon by
	// the asset bridge (TA:K inline weapons true, TA referenced weapons
	// false) so mixed-convention games resolve per weapon, not per session.
	SelfSplash bool

	// Instant marks the TA:K no-projectile behaviors (Melee, the Line of
	// Sight effect emitters, Remote Effect rings): nothing flies, damage
	// resolves through the detonation path at the aim point. Melee
	// additionally routes through the swing-gate pacing and the
	// WEAPON_LAUNCH_NOW contact handshake.
	Instant bool
	Melee   bool

	// MinBarrelSin is sin(minbarrelangle) for the ballistic solver's arc
	// acceptance (low arc must clear the barrel's depression floor). The
	// engines default the angle to −11.25° when the TDF omits it.
	MinBarrelSin float64

	// --- Stockpile / anti-nuke (Block 6; specials.md §6.1) ---

	// Stockpile marks a weapon that must be built up before firing (nukes):
	// firing decrements the per-slot stock (cap 200), no E/M charge at fire.
	// Targetable marks a projectile an interceptor can shoot down.
	// Interceptor marks the anti-nuke launcher; CoverageWU is its square
	// coverage box half-extent (|Δx|≤cov AND |Δz|≤cov, 2D, not circular).
	Stockpile   bool
	Targetable  bool
	Interceptor bool
	CoverageWU  int

	// --- TA:K spell layer (Block 6; specials.md §2.2, §7.1) ---

	// ManaPerShot is the unit-private mana a TA:K spell weapon consumes per
	// shot (veteran-discounted ÷(1+0.1L) at consume time).
	ManaPerShot float64
	// MindControl marks the conversion behavior (mindcontrol/turntostone/
	// turntofrozen share the stick-chance roll shape).
	MindControl bool
	// Paralyzer marks a stun weapon: its damage accumulates on a Paralyze
	// order (cap 1800 ticks) rather than subtracting HP.
	Paralyzer bool
}

// collisionRadius derives the unit's body circle from its FBI footprint
// (squares of 16 world units; the radius is half the wider side). Units with
// no footprint get a small vehicle-sized default.
func (m *UnitMeta) collisionRadius() fixed.Fixed {
	f := m.FootprintX
	if m.FootprintZ > f {
		f = m.FootprintZ
	}
	if f <= 0 {
		return fixed.FromInt(12)
	}
	return fixed.Clamp(fixed.FromInt(f*8), fixed.FromInt(10), fixed.FromInt(96))
}

// Ground kinematics use the FBI fields raw: MaxVelocity/Accel/BrakeRate are
// wu-per-frame 16.16 quantities and TurnRate an angle-units-per-frame integer,
// exactly as both engines load them — no defaults, no clamps (the previous
// sandbox-invented accel/brake clamps and per-second conversion round trip are
// gone). Aircraft keep a behavioural stand-in with its own defaults in
// aircraft.go until the real flight law lands.

// moveRate1 / moveRate2 are the walk-anim tier thresholds with the engines'
// load-time default of 2×maxvelocity when the FBI omits them.
func (m *UnitMeta) moveRate1() fixed.Fixed {
	if m.MoveRate1 > 0 {
		return m.MoveRate1
	}
	return fixed.Wrap32(m.MaxVelocity << 1)
}

func (m *UnitMeta) moveRate2() fixed.Fixed {
	if m.MoveRate2 > 0 {
		return m.MoveRate2
	}
	return fixed.Wrap32(m.MaxVelocity << 1)
}

// waterMult is the TA:K in-water stat multiplier with its engine default
// (1.0) when the FBI omits it.
func (m *UnitMeta) waterMult() fixed.Fixed {
	if m.WaterMult > 0 {
		return m.WaterMult
	}
	return fixed.One
}

// takRoadMultDefault is the engine's roadmultiplier default (+0x172, 0x13333 =
// 1.2) applied when the FBI omits the field.
const takRoadMultDefault = fixed.Fixed(0x13333)

// roadMult is the TA:K on-road stat multiplier with its engine default (1.2)
// when the FBI omits it — read by a unit standing on a road cell and by the
// pathfinder's road-cost discount.
func (m *UnitMeta) roadMult() fixed.Fixed {
	if m.RoadMult > 0 {
		return m.RoadMult
	}
	return takRoadMultDefault
}
