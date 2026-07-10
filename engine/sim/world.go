// Package sim is the headless, deterministic Total Annihilation simulation
// core. It runs identically on the authoritative server (native build) and in
// the browser (wasm build); given the same seed and the same ordered stream of
// orders it produces bit-identical state, which is what lets a client predict
// ahead of the server and reconcile cleanly.
//
// Nothing here touches the filesystem, the clock, the network, goroutines or
// floats: assets arrive pre-parsed via UnitMeta, time advances in fixed ticks,
// and all math goes through engine/fixed. Unit iteration uses an insertion
// ordered slice rather than a Go map range so traversal order is stable.
package sim

import (
	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/rng"
)

// Binding is the COB script hook surface the world drives. The script VM
// implements it; until a unit has a script it is nil and the world degrades to
// pure movement/combat. Defining it here (rather than importing the script
// package) keeps the dependency arrow pointing into sim.
type Binding interface {
	HasScript(name string) bool
	Start(name string, args ...int)
	// Restart spawns the named script after cancelling any live instance of it,
	// so a per-tick re-driven thread (a weapon aim loop) supersedes rather than
	// stacks. It mirrors the COB START opcode's same-name supersede.
	Restart(name string, args ...int)
	// Pieces returns the current piece transforms for the render snapshot.
	Pieces() []frame.PieceState
}

// aimBinding is the optional surface a script binding exposes so the weapon SM
// can drive an aim thread and await its completion before firing. The script
// VM's *Unit satisfies it; bindings without it (test fakes) make the weapon SM
// fall back to firing as soon as it is in range. StartAim supersedes any live
// instance and returns the new thread's id; AimStatus reports whether that
// thread has finished and the value it returned (TRUE/1 == aim complete).
type aimBinding interface {
	StartAim(name string, args ...int) int32
	AimStatus(id int32) (done bool, ret int32)
}

// queryBinding is the optional surface the weapon SM uses to resolve which
// model piece a shot exits from. RunQuery executes a Query<slot> script
// synchronously within the tick and returns the piece index it reports (the TA
// convention is the script's first local). ok is false when the script does not
// exist or would yield, so the SM can fall back to the unit anchor. Running it
// also advances any per-barrel cycle the script maintains, so a multi-barrel
// weapon alternates its muzzle from shot to shot. The script VM's *Unit
// satisfies it; test fakes without it simply report no firing piece.
type queryBinding interface {
	RunQuery(name string, args ...int) (int32, bool)
}

// weaponSlot is one of a unit's three weapon state machines.
type weaponSlot struct {
	hasTarget  bool
	targetUnit uint32 // 0 = aim at point
	targetPt   fixed.Vec3
	source     string // "attack" or "manual"
	lastFireMs int64

	// reloadTicks is the slot's live reload countdown on the tick axis. It
	// starts at zero (the first shot is ready as soon as the aim latch
	// holds), reloads to the veterancy/damage-scaled figure on each shot,
	// and decrements once per tick ONLY while the slot holds a target — a
	// cleared slot keeps its remaining count frozen (a commandfire weapon's
	// second order still waits out the first shot's reload).
	reloadTicks int

	// launchPending marks a TA:K shot between its fire commitment (reload
	// restarted, FireWeapon started) and the script's WEAPON_LAUNCH_NOW
	// port write at the animation's contact/release frame, which is what
	// actually spawns the projectile or lands the melee contact. The aim
	// snapshot taken at fire time rides along.
	launchPending  bool
	launchTarget   fixed.Vec3
	launchTargetID uint32

	// aim* track the last COB aim thread the world drove for this slot so the
	// turret is only re-aimed when its bearing has drifted enough to matter,
	// letting a settled aim thread run to completion instead of restarting it
	// every tick. aimIssued is false until the first aim is driven.
	aimIssued  bool
	aimHeading int32
	aimPitch   int32
	// aimThread is the id of the live AimWeapon thread driving this slot, and
	// aimReady latches true once that thread reports a completed aim (or the
	// stuck-timeout elapses), gating fire until the turret has actually turned to
	// bear. aimStartMs stamps when the current aim was issued, for that timeout.
	aimThread  int32
	aimReady   bool
	aimStartMs int64
	// aimLastIssueMs stamps the last time the aim thread was (re)issued, so the
	// world can refresh it on a steady cadence even when the bearing has not
	// drifted. Without that refresh the unit's COB restore-after-delay thread
	// eventually returns the turret to its home pose while a target is still
	// being tracked.
	aimLastIssueMs int64
}

// Unit is one live simulated unit.
type Unit struct {
	ID   uint32
	Name string
	Side int
	Meta *UnitMeta

	loco   locoState
	PosY   fixed.Fixed
	Health fixed.Fixed // 0..100

	// pitch is the unit's terrain pitch (s16 TA-angle) measured by the
	// footprint ground-follow after each move; the slope-speed band reads it
	// next frame. Upright units, floaters and subs keep 0. Derived from
	// hashed state each terrain snap, so never serialised.
	pitch int32
	// motionTier caches the last announced walk-animation tier (§7) and
	// lastTurnSign the last TurnDirection edge state (TA:K), both
	// transition-edge detectors. motionDialect caches the COB-resolved
	// movement dialect (motion_convention.go).
	motionTier    uint8
	lastTurnSign  int8
	motionDialect motionDialect
	// commandedSpeed is the TA:K squad speed-match clamp (wu/frame, 0 =
	// none). No squad/formation layer feeds it yet — the velocity law
	// already honours it so the order-layer block only has to set it.
	commandedSpeed fixed.Fixed

	Dead         bool
	BuildPercent fixed.Fixed

	IsMoving   bool
	hasMove    bool
	moveTarget fixed.Vec2
	// motionPin is the replay driver's authoritative motion flag (see
	// UnitStateOverride.Moving). While non-none, stepMovement's order-driven
	// locomotion yields to stepPinnedMovement: the flag owns IsMoving and a
	// pinned-moving unit coasts along its heading at the injected speed.
	motionPin uint8
	// Global pathfinding (pathfind.go): path is the smoothed waypoint chain
	// from a Move/Patrol/Build order to its destination, walked in order.
	// pathTried gates the lazy compute (so a no-path unit doesn't retry
	// every tick); pathFails counts stall-driven recomputes before the order
	// is abandoned as unreachable. Derived from deterministic state — not
	// serialised; a late joiner recomputes from its restored position.
	path      []fixed.Vec2
	pathIdx   int
	pathTried bool
	pathFails uint8

	hasAttack    bool
	attackTarget uint32

	// queue holds the shift-queued follow-up orders. The head runs when the
	// current order completes — a move on arrival, an attack when its target
	// dies. Any non-queued Move/Attack (and Stop) clears it.
	queue []queuedCommand

	// Build-cycle state, shared by mobile builders and factories. buildState
	// tracks the job phase (approach the site, then raise the buildee);
	// buildName/buildSite are the active job's parameters and buildeeID the
	// under-construction unit once it exists. A unit whose own BuildPercent
	// is below 100 is inert — not commandable, not stepping movement or
	// weapons — until complete.
	buildState buildPhase
	buildName  string
	buildSite  fixed.Vec2
	// buildHeading is the TA-angle the buildee should face, from the order's
	// drag-to-rotate gesture. buildHeadingSet distinguishes "face this way"
	// from the default (buildee inherits the builder's heading) so the factory
	// path is unaffected.
	buildHeading    int32
	buildHeadingSet bool
	// Wedge recovery: stallTicks counts consecutive ticks a moving unit
	// made no real progress (commanded speed, no displacement — pinned on
	// a structure corner); past the threshold avoidFlip toggles, sending
	// the next avoidance detour around the OTHER side of the blocker.
	stallTicks uint16
	avoidFlip  bool
	// progressPos is the unit's position at the previous movement tick
	// (post-collision), so the stall check measures NET displacement —
	// a locomotion step that a structure pushback cancels counts as no
	// progress.
	progressPos fixed.Vec2
	// buildResumeID points at an EXISTING under-construction frame this
	// builder was ordered to continue (the repair gesture); startRaising
	// adopts it instead of spawning a fresh buildee. Transient command
	// state — reset whenever a job starts or is cancelled.
	buildResumeID uint32
	buildeeID  uint32

	// prodQueue is a factory's pending production run, in click order —
	// mixed types queue freely. stepBuilder pops the head into the active
	// job whenever the pad is idle.
	prodQueue []string

	// buildGateMs is the deadline for the current build-readiness gate: a
	// factory waiting on its Activate doors (YARD_OPEN), or a mobile
	// builder waiting on its nano arm (INBUILDSTANCE). Progress resumes
	// when the script reports ready or the deadline passes. 0 = no gate.
	buildGateMs int64

	// Standing orders + their working state. moveMode/fireMode follow the
	// order.Move*/Fire* values (seeded from FBI defaults at spawn). homePos
	// anchors Maneuver's leash and post-combat return; autoEngaged marks an
	// attack the unit acquired itself (so completion returns it home rather
	// than leaving it wherever the chase ended); provokedMs is the last time
	// the unit took damage (Return Fire's trigger); wanderAtMs schedules a
	// Roamer's next idle wander; curIsPatrol marks the active move as a
	// patrol leg that re-queues itself on arrival.
	moveMode    uint8
	fireMode    uint8
	homePos     fixed.Vec2
	autoEngaged bool
	provokedMs  int64
	wanderAtMs  int64
	curIsPatrol bool

	// selfDAtMs is the armed self-destruct detonation time (0 = no fuse).
	// Ctrl+D toggles it; the countdown surfaces on the render snapshot.
	selfDAtMs int64

	// Transport state. carriedBy pins this unit to a carrier (it is inert,
	// uncollidable and untargetable while aboard); a transport's own
	// carrying list, active pickup target and pending drop site drive
	// stepTransport.
	carriedBy  uint32
	carrying   []uint32
	loadTarget uint32
	hasUnload  bool
	unloadAt   fixed.Vec2

	// yardOpen marks a structure's yard as passable this tick (factory
	// producing, or a unit standing inside it). Derived in stepYards from
	// hashed state each tick, so it is not itself hashed or exported.
	yardOpen bool

	weapons [3]weaponSlot

	// Veterancy counters. kills increments when a unit this one last damaged
	// dies (fully built, enemy) and drives the TA consumers: +6 %/level
	// damage dealt, −4 %/level damage taken, −6 %/level reload, the
	// accuracy divisor, and target leading from 6 kills. xp accumulates the
	// victims' experiencepoints and drives the TA:K ×vet/÷vet multipliers.
	kills int
	xp    int

	// Aircraft attack-maneuver state, mirroring the JS engine's u._atk. atkActive
	// is the analogue of u._atk being non-null: false until the unit first flies
	// a maneuver, so the first tick initialises flybySide. flybySide is the side
	// the next egress arc bends toward (+/-1); it is seeded from the unit id so a
	// flight scatters to both sides without consuming the world rng (which would
	// desync a late joiner's prediction).
	atkActive   bool
	atkPhase    atkPhase
	sweepPhase  fixed.Fixed
	sweepCenter fixed.Fixed
	egX, egZ    fixed.Fixed
	flybySide   int

	// Bomb-run bookkeeping for an aircraft's dropped weapon, mirroring the JS
	// engine's u._bombRun. Snapshotted on the first bomb so the run lays its
	// whole string at the cached aim point and persists even if the player
	// issues Move (the bomb-and-bail tactic). bombRunActive is the analogue of
	// u._bombRun being non-null.
	bombRunActive bool
	bombRunSlot   int
	bombRunPoint  fixed.Vec3
	bombRunLeft   int
	bombRunSource string

	// Corpse bookkeeping: killedThread tracks the Killed script started on
	// death so stepCorpse can read the corpsetype it wrote (its second
	// local) once the death sequence finishes; corpsePending holds the poll
	// open until then. dyingPending marks a TA:K-style death — the corpse
	// swap additionally waits for the Dying script's FINISHED_DYING signal
	// (the fall animation landing), with diedAtMs bounding the wait so a
	// script that never signals can't strand the corpse.
	killedThread  int32
	corpsePending bool
	dyingPending  bool
	diedAtMs      int64

	binding Binding
}

// queuedCommand is one deferred order on a unit's shift-queue. Only Move and
// Attack queue; everything else applies immediately.
type queuedCommand struct {
	// name carries a queued Build's unit type (empty otherwise).
	name string
	kind       order.Kind
	target     fixed.Vec2 // Move destination
	targetUnit uint32     // Attack subject
	// heading is the queued Build's buildee facing (TA-angle); headingSet
	// flags whether it was supplied.
	heading    int32
	headingSet bool
}

// maxOrderQueue bounds a unit's shift-queue so a runaway client can't grow
// unbounded authoritative state.
const maxOrderQueue = 32

// buildPhase is the mobile builder's job state.
type buildPhase uint8

const (
	buildIdle     buildPhase = iota
	buildApproach            // walking into builddistance of the site
	buildRaising             // standing at the site, raising the buildee
	buildOpening             // factory doors opening (Activate) before the pad raises
)

// underConstruction reports whether the unit is a buildee that has not yet
// reached 100% — inert: it takes no orders and steps no movement or weapons.
func (u *Unit) underConstruction() bool {
	return !u.Dead && u.BuildPercent < fixed.FromInt(100)
}

// Pos returns the unit's world position.
func (u *Unit) Pos() fixed.Vec3 {
	return fixed.Vec3{X: u.loco.Pos.X, Y: u.PosY, Z: u.loco.Pos.Z}
}

// Heading returns the unit's current heading as a TA-angle.
func (u *Unit) Heading() int32 { return int32(u.loco.Heading.Int()) }

// World holds all simulation state for one match/session.
type World struct {
	units   map[uint32]*Unit
	order   []uint32 // insertion order for deterministic iteration
	nextID  uint32
	rng     *rng.MinStd
	tick    uint64
	simMs   int64
	gravity fixed.Fixed
	events  []frame.Event

	// projectiles are the in-flight model weapons (missiles/rockets/bombs) the
	// world steps each tick. They are render state derived deterministically
	// from fire events, so they back the snapshot but stay out of the hash.
	projectiles []*projectile
	nextProjID  uint32

	// metaProvider resolves a unit type name to its stat block + binding when
	// a Spawn order arrives. Injected so the core stays asset-agnostic.
	spawn SpawnFunc

	// Resource accounting, per side (0..7). Builds drain each unit's FBI
	// price linearly over its construction; the sandbox pools are infinite,
	// so this only feeds the usage HUD — nothing gates on it. resRate is
	// rebuilt every tick (drain per second right now); resSpent accumulates.
	// resStock integrates generation minus drain (clamped into the side's
	// live storage capacity); resCap and resGen are recomputed each tick
	// from the standing units' FBI economy fields.
	resSpent [maxSides]resourceTally
	resRate  [maxSides]resourceTally
	resStock [maxSides]resourceTally
	resCap   [maxSides]resourceTally
	resGen   [maxSides]resourceTally
	// resSeeded marks sides whose economy has been initialised: the first
	// time a side fields a unit it receives the base storage pre-filled
	// (the classic 1000/1000 start).
	resSeeded [maxSides]bool
	// resProduced accumulates gross generation over the session, the
	// economy bar's lifetime-production figure.
	resProduced [maxSides]resourceTally

	// terrain is the installed map height field (nil = flat sandbox grid).
	// Configuration like meta, identical on every peer, never hashed.
	terrain *Terrain

	// pathScratch is the reusable A* working set (pathfind.go); pathBudget
	// caps how many units may compute a fresh path per tick so a big group
	// move spreads its searches over a few ticks instead of one hitch.
	pathScratch *pathScratch
	pathBudget  int
}

// maxSides is the per-side resource-tally array bound (TA's 8 team slots).
const maxSides = 8

// resourceTally is one side's resource figures: TA metal+energy, TA:K mana.
type resourceTally struct {
	Metal  fixed.Fixed
	Energy fixed.Fixed
	Mana   fixed.Fixed
}

// SpawnFunc builds the meta and (optional) script binding for a unit type.
// Returning a nil binding yields a script-less unit (movement/combat only).
type SpawnFunc func(name string) (*UnitMeta, Binding)

// Config configures a new World.
type Config struct {
	Seed    uint32
	Gravity fixed.Fixed
	Spawn   SpawnFunc
	// Rand optionally supplies the MINSTD sim stream to draw from — pass the
	// script runtime's stream (script.Runtime.Rand) so COB RAND and world
	// draws consume one generator in call order, the engines' single-stream
	// discipline. Nil seeds a private stream from Seed.
	Rand *rng.MinStd
}

// defaultGravity is the engine default projectile gravity on the sandbox's
// per-second axis: the sim word 8155 (16.16 wu per tick²) × 900 tick²/s² —
// the 112 wu/s² classic default, expressed exactly as the engine's stored
// integer scales rather than the rounded figure.
var defaultGravity = fixed.Fixed(8155 * 900)

// New creates an empty world.
func New(cfg Config) *World {
	g := cfg.Gravity
	if g == 0 {
		g = defaultGravity
	}
	r := cfg.Rand
	if r == nil {
		r = rng.NewMinStd(cfg.Seed)
	}
	return &World{
		units:      make(map[uint32]*Unit),
		nextID:     1,
		nextProjID: 1,
		rng:        r,
		gravity:    g,
		spawn:      cfg.Spawn,
	}
}

// Tick returns the current simulation tick number.
func (w *World) Tick() uint64 { return w.tick }

// RngState exposes the sim RNG's raw state word for replay checkpointing and
// divergence checks; gameplay code must keep drawing through w.rng.
func (w *World) RngState() uint32 { return w.rng.Snapshot() }

// RngDraws reports how many MINSTD draws the sim stream has made — the
// measurement harness samples it before and after a window to count
// consumption. When the stream is shared with the script runtime the count
// includes COB RAND draws, matching the engines' single-stream accounting.
func (w *World) RngDraws() uint64 { return w.rng.Draws() }

// UnitByID returns a unit or nil.
func (w *World) UnitByID(id uint32) *Unit { return w.units[id] }

// Kills reports the unit's veterancy kill counter.
func (u *Unit) Kills() int { return u.kills }

// SetUnitKills pins a unit's veterancy counters directly — a measurement /
// scenario hook so the harness can grade the veterancy consumers at an exact
// level without staging a five-kill warm-up. xp is pinned to the equivalent
// TA:K figure (kills × own experiencepoints) so both games' consumers read
// the same level.
func (w *World) SetUnitKills(id uint32, kills int) {
	u := w.units[id]
	if u == nil || kills < 0 {
		return
	}
	u.kills = kills
	if u.Meta != nil && u.Meta.ExperiencePoints > 0 {
		u.xp = kills * u.Meta.ExperiencePoints
	}
}

// killedBinding is the optional surface stepCorpse uses to read the
// corpsetype a tracked Killed thread wrote before it died. The script VM's
// *Unit satisfies it; without it the world defaults to an intact corpse.
type killedBinding interface {
	KilledStatus(id int32) (done bool, corpsetype int32)
}

// emitCorpse publishes the unit's corpse decision to the render stream.
// corpsetype follows TA's Killed convention: 1 = intact corpse feature,
// 2 = damaged (the corpse's featuredead), 3 = nothing left. Slot carries the
// type and SfxType the body heading; the client resolves the actual wreck
// feature names from unit meta.
func (w *World) emitCorpse(u *Unit, corpsetype int32) {
	if corpsetype < 1 || corpsetype > 3 {
		corpsetype = 1
	}
	w.emit(frame.Event{
		Kind:    frame.EvCorpseSpawn,
		UnitID:  u.ID,
		Slot:    int(corpsetype),
		SfxType: int(u.Heading()),
		Anchor:  u.Pos(),
	})
	u.corpsePending = false
	u.dyingPending = false
}

// dyingBinding is the optional surface a binding exposes so the corpse poll
// can wait for TA:K's FINISHED_DYING signal — the Dying fall animation
// landing. The script VM's *Unit satisfies it.
type dyingBinding interface {
	FinishedDying() bool
}

// dyingTimeoutMs bounds how long the corpse swap waits on FINISHED_DYING. A
// retail Dying fall lasts a couple of seconds; a script that never signals
// (or dies mid-fall) shouldn't strand the unit in its death pose forever.
const dyingTimeoutMs int64 = 10000

// stepCorpse polls a dead unit's tracked Killed thread and publishes the
// corpse once the script settles its choice. A TA:K death additionally waits
// for the Dying script's FINISHED_DYING — the corpse model must not replace
// the unit while the fall animation is still playing.
func (w *World) stepCorpse(u *Unit) {
	if !u.corpsePending {
		return
	}
	kb, ok := u.binding.(killedBinding)
	if !ok {
		w.emitCorpse(u, 1)
		return
	}
	done, ct := kb.KilledStatus(u.killedThread)
	if !done {
		return
	}
	if u.dyingPending && w.simMs-u.diedAtMs < dyingTimeoutMs {
		if db, ok := u.binding.(dyingBinding); ok && !db.FinishedDying() {
			return
		}
	}
	// A binding that ships Dying follows the TA:K convention, where
	// Killed's corpsetype out-param is a yes/no: 0 = blown apart (no
	// corpse), anything else leaves the single corpse stage (TA:K corpse
	// features chain no featuredead). Map it onto the renderer's TA-style
	// slots: 1 = intact corpse, 3 = nothing.
	if u.dyingPending || (u.binding != nil && u.binding.HasScript("Dying")) {
		if ct <= 0 {
			ct = 3
		} else {
			ct = 1
		}
	}
	w.emitCorpse(u, ct)
}

// CobInspector is the optional inspection surface a binding may expose. The
// script.Unit binding implements it; script-less bindings do not, so the world
// reports no COB state for them.
type CobInspector interface {
	CobState() frame.CobUnitState
}

// UnitCob returns a unit's inspectable script state (static vars + live
// threads), or ok=false when the unit is missing or has no script binding. It
// is debug-only — the studio's Runtime / Script Variables panels read it — and
// never participates in the world hash.
func (w *World) UnitCob(id uint32) (frame.CobUnitState, bool) {
	u := w.units[id]
	if u == nil || u.binding == nil {
		return frame.CobUnitState{}, false
	}
	if ci, ok := u.binding.(CobInspector); ok {
		return ci.CobState(), true
	}
	return frame.CobUnitState{}, false
}

// CobController is the optional control surface a binding exposes for the
// studio's developer commands (Terminate All Scripts, per-unit Stop / Reset).
// The script.Unit binding implements it; script-less bindings do not. These are
// debug-only sandbox tools and carry no determinism contract.
type CobController interface {
	KillAllThreads()
	KillThread(id int32)
	ResetState()
}

// KillAllThreads terminates every COB thread on every unit (the "Terminate All
// Scripts" developer command). Bindings without scripts are skipped.
func (w *World) KillAllThreads() {
	for _, id := range w.order {
		if u := w.units[id]; u != nil {
			if c, ok := u.binding.(CobController); ok {
				c.KillAllThreads()
			}
		}
	}
}

// UnitKillThreads stops every thread on one unit; UnitKillThread stops a single
// thread by id; UnitReset returns a unit to a clean script state. Each is a
// no-op for a missing unit or a script-less binding.
func (w *World) UnitKillThreads(id uint32) {
	if u := w.units[id]; u != nil {
		if c, ok := u.binding.(CobController); ok {
			c.KillAllThreads()
		}
	}
}

func (w *World) UnitKillThread(id uint32, threadID int32) {
	if u := w.units[id]; u != nil {
		if c, ok := u.binding.(CobController); ok {
			c.KillThread(threadID)
		}
	}
}

func (w *World) UnitReset(id uint32) {
	if u := w.units[id]; u != nil {
		if c, ok := u.binding.(CobController); ok {
			c.ResetState()
		}
	}
}

// CobDebugger is the optional debug-control surface a binding exposes for the
// studio's COB debugger (single-stepping, breakpoints, variable edits, coverage)
// in the offline unit editor. The script.Unit binding implements it; script-less
// bindings do not. Like the other developer commands these mutate VM state
// outside the hashed contract and carry no determinism guarantee.
type CobDebugger interface {
	StepThread(id int32)
	SetThreadPC(id int32, pc int)
	SetThreadLocal(id int32, idx int, v int32)
	SetStatic(idx int, v int32)
	AddBreakpoint(scriptIdx int, offset uint32)
	RemoveBreakpoint(scriptIdx int, offset uint32)
	ClearBreakpoints()
	ClearBreakpointHits()
	Coverage() map[int][]uint32
}

// dbg returns a unit's debug-control binding, or nil for a missing unit or a
// script-less binding. Each debug command below funnels through it so a unit
// without a script is a silent no-op.
func (w *World) dbg(id uint32) CobDebugger {
	if u := w.units[id]; u != nil {
		if d, ok := u.binding.(CobDebugger); ok {
			return d
		}
	}
	return nil
}

// UnitStepThread advances one thread of a unit by a single instruction.
func (w *World) UnitStepThread(id uint32, threadID int32) {
	if d := w.dbg(id); d != nil {
		d.StepThread(threadID)
	}
}

// UnitSetThreadPC moves a thread's program counter to an instruction index.
func (w *World) UnitSetThreadPC(id uint32, threadID int32, pc int) {
	if d := w.dbg(id); d != nil {
		d.SetThreadPC(threadID, pc)
	}
}

// UnitSetThreadLocal writes one of a thread's local variables.
func (w *World) UnitSetThreadLocal(id uint32, threadID int32, idx int, v int32) {
	if d := w.dbg(id); d != nil {
		d.SetThreadLocal(threadID, idx, v)
	}
}

// UnitSetStatic writes one of a unit's static variables.
func (w *World) UnitSetStatic(id uint32, idx int, v int32) {
	if d := w.dbg(id); d != nil {
		d.SetStatic(idx, v)
	}
}

// UnitAddBreakpoint / UnitRemoveBreakpoint / UnitClearBreakpoints manage a
// unit's breakpoints by script index + byte offset.
func (w *World) UnitAddBreakpoint(id uint32, scriptIdx int, offset uint32) {
	if d := w.dbg(id); d != nil {
		d.AddBreakpoint(scriptIdx, offset)
	}
}

func (w *World) UnitRemoveBreakpoint(id uint32, scriptIdx int, offset uint32) {
	if d := w.dbg(id); d != nil {
		d.RemoveBreakpoint(scriptIdx, offset)
	}
}

func (w *World) UnitClearBreakpoints(id uint32) {
	if d := w.dbg(id); d != nil {
		d.ClearBreakpoints()
	}
}

// UnitClearBreakpointHits releases every thread of a unit parked on a breakpoint
// (the debugger's "Continue").
func (w *World) UnitClearBreakpointHits(id uint32) {
	if d := w.dbg(id); d != nil {
		d.ClearBreakpointHits()
	}
}

// UnitCoverage returns a unit's executed-offset coverage, keyed by script index,
// or nil for a missing / script-less unit.
func (w *World) UnitCoverage(id uint32) map[int][]uint32 {
	if d := w.dbg(id); d != nil {
		return d.Coverage()
	}
	return nil
}

// CobPorts is the optional unit-value port surface a binding exposes so the
// offline unit editor can drive COB GET_UNIT_VALUE reads (HEALTH, build percent,
// activation, standing orders) from its inspector sliders. The script.Unit
// binding implements it; script-less bindings do not. Port writes never feed the
// world hash — combat-authoritative state lives on the sim unit — so they carry
// no determinism contract.
type CobPorts interface {
	SetUnitValuePort(port int, v int32)
	UnitValuePort(port int) int32
}

// UnitSetValuePort writes a COB unit-value port on a unit's script binding. A
// missing or script-less unit is a silent no-op.
func (w *World) UnitSetValuePort(id uint32, port int, v int32) {
	if u := w.units[id]; u != nil {
		if p, ok := u.binding.(CobPorts); ok {
			p.SetUnitValuePort(port, v)
		}
	}
}

// UnitValuePort reads a COB unit-value port off a unit's script binding (the
// value GET_UNIT_VALUE would yield). Returns 0 for a missing / script-less unit.
func (w *World) UnitValuePort(id uint32, port int) int32 {
	if u := w.units[id]; u != nil {
		if p, ok := u.binding.(CobPorts); ok {
			return p.UnitValuePort(port)
		}
	}
	return 0
}

// CobScripts is the optional script-invocation surface a binding exposes so the
// offline unit editor's Actions panel can run a named entry point (Create,
// Activate, AimPrimary, …), list the available ones, and retract a transient
// pose handler. The script.Unit binding implements it; script-less bindings do
// not. Editor-driven invocations are offline / single-unit and carry no
// determinism contract.
type CobScripts interface {
	HasScript(name string) bool
	Start(name string, args ...int)
	Restart(name string, args ...int)
	KillThreadsByName(name string)
	ScriptNames() []string
}

// scripts returns a unit's script-invocation binding, or nil for a missing unit
// or a script-less binding.
func (w *World) scripts(id uint32) CobScripts {
	if u := w.units[id]; u != nil {
		if s, ok := u.binding.(CobScripts); ok {
			return s
		}
	}
	return nil
}

// UnitStartScript spawns a thread on the named entry point. UnitRestartScript
// does the same but first cancels any live instance of that script (the COB
// START supersede). Both are no-ops for a missing / script-less unit or an
// unknown script name.
func (w *World) UnitStartScript(id uint32, name string, args ...int) {
	if s := w.scripts(id); s != nil && s.HasScript(name) {
		s.Start(name, args...)
	}
}

func (w *World) UnitRestartScript(id uint32, name string, args ...int) {
	if s := w.scripts(id); s != nil && s.HasScript(name) {
		s.Restart(name, args...)
	}
}

// UnitPlayWeaponFire plays the aim + fire entry points for a wire-reported
// shot: it re-drives the slot's aim script pointed at the target (the turret
// and barrel swing onto the bearing) and starts the fire script (recoil,
// muzzle flash, barrel cycling). Presentation only — no projectile spawns and
// no damage applies; a replay driver conveys the shot's outcome through its
// own state corrections. The weapon-script convention (TA per-slot triples vs
// TA:K's shared parameterized set) is resolved from the COB exactly as live
// combat does, and the aim geometry mirrors aimWeapon's, so the animation a
// replay plays is the one the game would have. Deterministic: pure integer
// math into the script VM. Returns false for a missing, script-less or
// aim/fire-less unit so drivers can fall back to a renderer-side tracer only.
func (w *World) UnitPlayWeaponFire(id uint32, slot int, target fixed.Vec3) bool {
	u := w.units[id]
	if u == nil || u.binding == nil {
		return false
	}
	if slot < 0 || slot >= len(u.weapons) {
		slot = 0
	}
	conv := conventionFor(u.binding)
	played := false
	if name := conv.aimScript(slot); name != "" && u.binding.HasScript(name) {
		d := fixed.Vec2{X: target.X, Z: target.Z}.Sub(u.loco.Pos)
		heading := aimBearing(u, fixed.Vec2{X: target.X, Z: target.Z})
		pitch := fixed.ShortestArc(fixed.Atan2(target.Y-(u.PosY+muzzleAimHeight), d.Len()))
		u.binding.Restart(name, conv.aimArgs(heading, pitch, slot)...)
		played = true
	}
	if name := conv.fireScript(slot); name != "" && u.binding.HasScript(name) {
		u.binding.Start(name, conv.fireArgs(slot)...)
		played = true
	}
	return played
}

// UnitQueryScriptPiece runs one of a unit's COB Query* entry points
// (QueryPrimary / QuerySecondary / QueryTertiary, QueryNanoPiece,
// QueryBuildInfo, …) synchronously and returns the piece the script reported
// through its out-parameter — an index into the unit's COB piece table
// (UnitPieceNames), which is how a renderer maps it onto a model piece BY
// NAME. Returns -1 for a missing unit, a script-less binding, an unknown
// entry point, or a query that would yield (the synchronous contract of
// RunQuery). With no explicit args the TA convention applies: one out-local
// the script writes the piece into; extra args ride after it (TA:K's shared
// QueryWeapon takes the weapon index second). Running a query advances any
// per-barrel cycle the script keeps, exactly as live fire does — successive
// calls on a multi-barrel weapon report alternating muzzles.
func (w *World) UnitQueryScriptPiece(id uint32, name string, args ...int) int32 {
	u := w.units[id]
	if u == nil || u.binding == nil || !u.binding.HasScript(name) {
		return -1
	}
	qb, ok := u.binding.(queryBinding)
	if !ok {
		return -1
	}
	if len(args) == 0 {
		args = []int{0}
	}
	if piece, ok := qb.RunQuery(name, args...); ok {
		return piece
	}
	return -1
}

// UnitKillThreadsByName marks dead every live thread running the named script.
func (w *World) UnitKillThreadsByName(id uint32, name string) {
	if s := w.scripts(id); s != nil {
		s.KillThreadsByName(name)
	}
}

// UnitScriptNames lists a unit type's script entry-point names, or nil for a
// missing / script-less unit.
// pieceNamesBinding is the optional surface a binding exposes to report its
// COB piece table. The script VM's *Unit satisfies it.
type pieceNamesBinding interface {
	PieceNames() []string
}

// UnitPieceNames returns a unit's COB piece-name table in piece-index order —
// the key a renderer uses to apply Pieces() state by NAME rather than by
// model hierarchy index. Nil for script-less units.
func (w *World) UnitPieceNames(id uint32) []string {
	if u := w.units[id]; u != nil {
		if pb, ok := u.binding.(pieceNamesBinding); ok {
			return pb.PieceNames()
		}
	}
	return nil
}

func (w *World) UnitScriptNames(id uint32) []string {
	if s := w.scripts(id); s != nil {
		return s.ScriptNames()
	}
	return nil
}

// UnitCount returns the number of units currently in the world (live or dead
// until reaped). It is a cheap map length read used for session listings.
func (w *World) UnitCount() int { return len(w.units) }

// ForEachUnit visits every live unit in stable insertion order. Used to build
// authoritative wire snapshots without disturbing the render event buffer.
func (w *World) ForEachUnit(fn func(*Unit)) {
	for _, id := range w.order {
		if u := w.units[id]; u != nil {
			fn(u)
		}
	}
}

// emit records a discrete event for this tick's render snapshot.
func (w *World) emit(e frame.Event) { w.events = append(w.events, e) }

// AddUnit registers a new unit and returns its id.
func (w *World) AddUnit(name string, meta *UnitMeta, binding Binding, at fixed.Vec2, heading int32, side int) uint32 {
	id := w.nextID
	w.nextID++
	u := &Unit{
		ID:           id,
		Name:         name,
		Side:         side,
		Meta:         meta,
		Health:       fixed.FromInt(100),
		BuildPercent: fixed.FromInt(100),
		binding:      binding,
	}
	// Standing-order defaults: the FBI's standingmoveorder/standingfireorder
	// when set, else the game defaults (Maneuver / Fire at Will). An FBI 0 is
	// indistinguishable from absent through the meta pipeline, so explicit
	// Hold ships via a Stance order instead.
	u.moveMode = MoveManeuver
	u.fireMode = FireAtWill
	if meta != nil {
		if meta.StandMove >= 1 && meta.StandMove <= 2 {
			u.moveMode = meta.StandMove
		}
		if meta.StandFire >= 1 && meta.StandFire <= 2 {
			u.fireMode = meta.StandFire
		}
	}
	u.homePos = at
	u.loco.Pos = fixed.Vec2{X: fixed.Wrap32(at.X), Z: fixed.Wrap32(at.Z)}
	u.loco.Heading = fixed.FromInt(int(fixed.WrapAngle(heading)))
	// Unit initialisation consumes two sim-stream draws (the engine
	// randomises a fresh unit's facing). The sandbox spawns with explicit
	// headings, so the values are discarded — the draws exist purely to keep
	// the shared MINSTD stream's consumption aligned with the engines'
	// accounting, which downstream draw-order fidelity is measured against.
	w.rng.Bounded(int32(fixed.FullCircle))
	w.rng.Bounded(int32(fixed.FullCircle))
	w.units[id] = u
	w.order = append(w.order, id)
	if binding != nil && binding.HasScript("Create") {
		startCreate(binding)
	}
	startSetMaxReloadTime(meta, binding)
	w.emit(frame.Event{Kind: frame.EvSpawn, UnitID: id})
	return id
}

// setActivation drives a unit's on/off state authoritatively: it runs the
// Activate / Deactivate COB entry (so the structure visibly opens or folds) and
// writes the ACTIVATION unit-value port so GET_UNIT_VALUE — and the studio's
// "Active" pill, which reads it — reflect the real state. The two must move
// together: the COB tracks open/closed in its own static vars, while
// GET_UNIT_VALUE(ACTIVATION) otherwise rests at TA's default of 1 and would
// report a folded solar as on. A unit with no Activate/Deactivate script or no
// port surface is left untouched.
func (w *World) setActivation(u *Unit, on bool) {
	if u == nil || u.binding == nil {
		return
	}
	name := "Deactivate"
	if on {
		name = "Activate"
	}
	if s, ok := u.binding.(CobScripts); ok && s.HasScript(name) {
		s.Start(name)
	}
	if p, ok := u.binding.(CobPorts); ok {
		p.SetUnitValuePort(1, boolPort(on))
	}
}

// boolPort maps an on/off flag to the COB unit-value convention (1 = on).
func boolPort(on bool) int32 {
	if on {
		return 1
	}
	return 0
}

// SetUnitActivation drives a unit's Activate/Deactivate presentation
// externally — the replay driver's hook for building activity (a metal
// extractor's rotor spinning up, a solar collector opening) reported by the
// wire stream. Runs the COB entry point and pins the ACTIVATION port
// together, exactly like the internal factory path. Returns false for a
// missing or binding-less unit.
func (w *World) SetUnitActivation(id uint32, on bool) bool {
	u := w.units[id]
	if u == nil || u.binding == nil {
		return false
	}
	w.setActivation(u, on)
	return true
}

// InitOnOff settles a freshly-placed on/off-able unit's activation so the
// studio's Active pill matches what's drawn: an ActivateWhenBuilt structure (a
// solar collector) opens at once and reads on, while any other toggleable unit
// pins the ACTIVATION port to off so the pill doesn't inherit GET_UNIT_VALUE's
// resting default of 1 and lie about a closed unit. No-op for units that can't
// be toggled, and only meaningful for a completed unit — buildees raise through
// the construction path, which activates them on completion instead. Called
// from the direct-placement entry point; networked buildees never pass here.
func (w *World) InitOnOff(id uint32) {
	u := w.units[id]
	if u == nil || u.Meta == nil || !u.Meta.OnOffable || u.binding == nil {
		return
	}
	on := u.Meta.ActivateWhenBuilt
	if on {
		w.setActivation(u, true)
		return
	}
	// Rest closed but make the port explicit so the pill reads off.
	if p, ok := u.binding.(CobPorts); ok {
		p.SetUnitValuePort(1, 0)
	}
}

// syncStartBinding is the optional surface a binding exposes to run an entry
// point synchronously to its first yield within the current call, rather than
// queuing it for the next script tick. The script VM's *Unit satisfies it.
type syncStartBinding interface {
	StartNow(name string, args ...int)
}

// startCreate runs a freshly spawned unit's Create entry point. When the
// binding supports it, Create executes synchronously to its first yield — the
// engine contract: a unit's initial pose (hidden build flares, turn-now rest
// angles) is applied during spawn, before its first frame ever renders. A
// binding without the surface (test fakes) degrades to a next-tick start.
func startCreate(binding Binding) {
	if sb, ok := binding.(syncStartBinding); ok {
		sb.StartNow("Create")
		return
	}
	binding.Start("Create")
}

// startSetMaxReloadTime tells a TA:K script its slowest weapon's reload time
// in milliseconds. TA:K units size their restore-after-delay timers from it
// (typically sleeping a multiple of the value); TA scripts have no such entry
// point, so this is a no-op for them.
func startSetMaxReloadTime(meta *UnitMeta, binding Binding) {
	if meta == nil || binding == nil || !binding.HasScript("SetMaxReloadTime") {
		return
	}
	maxMs := 0
	for _, wm := range meta.Weapons {
		if wm.ReloadMs > maxMs {
			maxMs = wm.ReloadMs
		}
	}
	if maxMs <= 0 {
		maxMs = 1500
	}
	binding.Start("SetMaxReloadTime", maxMs)
}

// RestoredUnit carries the full per-unit motion state needed to resume the
// simulation elsewhere — a late-joining client rebuilding its local world from
// an authoritative snapshot. Heading and Speed are the raw fixed-point locostate
// (not the truncated render values), and the move target is included so a unit
// caught mid-move keeps driving identically rather than freezing. Weapon
// cooldowns are not carried, so combat state remains approximate.
type RestoredUnit struct {
	ID         uint32
	Name       string
	Side       int
	Pos        fixed.Vec3
	Heading    fixed.Fixed // raw fractional TA-angle
	Speed      fixed.Fixed
	HasMove    bool
	MoveTarget fixed.Vec2
	Health     fixed.Fixed
	Dead       bool
	// Combat state so a late joiner's prediction re-engages weapons that were
	// firing / aiming on the authority. Without it a restored unit re-runs only
	// its Create script and renders at its base pose, so a weapon caught
	// mid-recoil snaps back to rest on the joining client.
	HasAttack    bool
	AttackTarget uint32
	// Queue carries the unit's shift-queued follow-up orders so a joiner's
	// world advances through the same waypoint chain as the authority.
	Queue   []RestoredQueued
	Weapons [3]RestoredWeapon
	// BuildPercent carries construction progress (a buildee below 100% stays
	// inert on the joiner too); the Build* fields carry a builder's live job
	// so the joiner keeps raising the same buildee; ProdQueue a factory's
	// pending production run.
	BuildPercent  fixed.Fixed
	BuildState    uint8
	BuildName     string
	BuildSite     fixed.Vec2
	BuildTargetID uint32
	BuildGateMs   int64
	ProdQueue     []string
	// Standing orders + their working state, so a joiner's units keep the
	// same stances, posts and patrol/auto-engage status.
	MoveMode    uint8
	FireMode    uint8
	HomePos     fixed.Vec2
	AutoEngaged bool
	CurIsPatrol bool
	SelfDAtMs   int64
	// Transport links: who carries this unit, who it carries, and any
	// in-flight pickup / drop job.
	CarriedBy  uint32
	Carrying   []uint32
	LoadTarget uint32
	StallTicks uint16
	AvoidFlip  bool
	ProgressX  fixed.Fixed
	ProgressZ  fixed.Fixed
	HasUnload  bool
	UnloadAt   fixed.Vec2
	// MotionPin carries a replay driver's authoritative motion flag (see
	// UnitStateOverride.Moving) so a seek keyframe restore resumes the same
	// walk/idle animation state the pin was holding.
	MotionPin uint8
	// Veterancy counters — a joiner must reproduce the authority's damage,
	// reload and accuracy scaling, all of which key off these.
	Kills int
	XP    int
	// Cob carries the unit's full live script VM state (piece animators, threads,
	// statics, visibility) when the binding can export it. With it the joiner
	// resumes the exact piece poses the authority holds — a turret's aim angle, a
	// half-played recoil — instead of re-deriving them by replaying Create and
	// StartMoving, which only ever reproduces a rest pose. Nil when the binding
	// has no script or cannot export, in which case Restore falls back to replay.
	Cob *frame.CobSnapshot
}

// cobExporter is the optional surface a binding exposes to hand the world its
// full live VM state for a resync snapshot. The script VM's *Unit satisfies it;
// test fakes without it simply omit COB state and the joiner falls back to
// replaying Create/StartMoving.
type cobExporter interface {
	ExportCob() frame.CobSnapshot
}

// cobImporter is the inverse of cobExporter: a binding that can adopt a
// previously exported VM state in place of running its Create script.
type cobImporter interface {
	ImportCob(frame.CobSnapshot)
}

// RestoredQueued is one deferred order on a unit's shift-queue, carried across
// a join. Kind mirrors order.Kind numerically (1 = move, 2 = attack).
type RestoredQueued struct {
	Kind       uint8
	Target     fixed.Vec2
	TargetUnit uint32
	Name       string
}

// RestoredWeapon is one weapon slot's standing aim/fire order, carried across a
// join so the joiner re-aims and re-fires it. LastFireMs carries the slot's last
// shot time so the joiner inherits the authority's reload cadence: with it the
// next shot lands on the same tick on every window instead of the joiner kicking
// off a fresh reload cycle (the "firing on two separate cycles" desync). The aim
// thread itself re-runs from scratch, replaying the turret turn and muzzle
// animation; only the fire clock is inherited.
type RestoredWeapon struct {
	HasTarget  bool
	TargetUnit uint32
	TargetPt   fixed.Vec3
	Source     string
	LastFireMs int64
	// ReloadTicks carries the live reload countdown so the joiner's next
	// shot lands on the same tick as the authority's.
	ReloadTicks int
}

// RestoredProjectile is one in-flight model weapon (missile/rocket/bomb) carried
// across a join. The projectile struct is self-contained — every field
// stepProjectile reads is stored on it — so resuming flight on a late joiner only
// needs these values copied back verbatim. Carrying them keeps the joiner's
// in-flight shots from vanishing AND keeps hashed state in lockstep: a missile
// the authority still has in the air will detonate and apply damage, so a joiner
// that dropped it would otherwise diverge on the target's health the moment it
// lands.
type RestoredProjectile struct {
	ID        uint32
	OwnerID   uint32
	TargetID  uint32
	Slot      int
	Mode      uint8
	Phase     uint8
	Model     string
	Weapon    string
	Pos       fixed.Vec3
	Vel       fixed.Vec3
	Origin    fixed.Vec3
	Target    fixed.Vec3
	LaunchY   fixed.Fixed
	Speed     fixed.Fixed
	VMax      fixed.Fixed
	Accel     fixed.Fixed
	TurnAng   int32
	HomingR   fixed.Fixed
	Gravity   fixed.Fixed
	AoE       fixed.Fixed
	Damage    fixed.Fixed
	AgeSec    fixed.Fixed
	LifeSec   fixed.Fixed
	LastDist  fixed.Fixed
	Closing   bool
	Heading   int32
	Pitch     int32
	FromPiece int
	// Burst-parent state: pellets left to emit and the tick spacing. The
	// parent's weapon stats re-resolve from the owner's meta on restore.
	BurstLeft  int
	BurstGap   int
	BurstSince int
}

// ExportUnits captures every live unit's full motion state in insertion order,
// for assembling an authoritative snapshot a client can resync from.
func (w *World) ExportUnits() []RestoredUnit {
	out := make([]RestoredUnit, 0, len(w.order))
	for _, id := range w.order {
		u := w.units[id]
		if u == nil {
			continue
		}
		ru := RestoredUnit{
			ID:            u.ID,
			Name:          u.Name,
			Side:          u.Side,
			Pos:           u.Pos(),
			Heading:       u.loco.Heading,
			Speed:         u.loco.Speed,
			HasMove:       u.hasMove,
			MoveTarget:    u.moveTarget,
			Health:        u.Health,
			Dead:          u.Dead,
			HasAttack:     u.hasAttack,
			AttackTarget:  u.attackTarget,
			BuildPercent:  u.BuildPercent,
			BuildState:    uint8(u.buildState),
			BuildName:     u.buildName,
			BuildSite:     u.buildSite,
			BuildTargetID: u.buildeeID,
			BuildGateMs:   u.buildGateMs,
			ProdQueue:     append([]string(nil), u.prodQueue...),
			MoveMode:      u.moveMode,
			FireMode:      u.fireMode,
			HomePos:       u.homePos,
			AutoEngaged:   u.autoEngaged,
			CurIsPatrol:   u.curIsPatrol,
			SelfDAtMs:     u.selfDAtMs,
			CarriedBy:     u.carriedBy,
			Carrying:      append([]uint32(nil), u.carrying...),
			LoadTarget:    u.loadTarget,
			StallTicks:    u.stallTicks,
			AvoidFlip:     u.avoidFlip,
			ProgressX:     u.progressPos.X,
			ProgressZ:     u.progressPos.Z,
			HasUnload:     u.hasUnload,
			UnloadAt:      u.unloadAt,
			MotionPin:     u.motionPin,
			Kills:         u.kills,
			XP:            u.xp,
		}
		for _, c := range u.queue {
			ru.Queue = append(ru.Queue, RestoredQueued{Kind: uint8(c.kind), Target: c.target, TargetUnit: c.targetUnit, Name: c.name})
		}
		for i := range u.weapons {
			s := &u.weapons[i]
			ru.Weapons[i] = RestoredWeapon{
				HasTarget:   s.hasTarget,
				TargetUnit:  s.targetUnit,
				TargetPt:    s.targetPt,
				Source:      s.source,
				LastFireMs:  s.lastFireMs,
				ReloadTicks: s.reloadTicks,
			}
		}
		if ce, ok := u.binding.(cobExporter); ok {
			cob := ce.ExportCob()
			ru.Cob = &cob
		}
		out = append(out, ru)
	}
	return out
}

// ExportProjectiles captures every in-flight model weapon's full flight state so
// a late joiner resumes the authority's live shots rather than starting with an
// empty sky. The projectile struct is self-contained, so each export is a flat
// copy of its fields.
func (w *World) ExportProjectiles() []RestoredProjectile {
	out := make([]RestoredProjectile, 0, len(w.projectiles))
	for _, p := range w.projectiles {
		if p == nil || p.dead {
			continue
		}
		out = append(out, RestoredProjectile{
			ID:        p.id,
			OwnerID:   p.ownerID,
			TargetID:  p.targetID,
			Slot:      p.slot,
			Mode:      uint8(p.mode),
			Phase:     uint8(p.phase),
			Model:     p.model,
			Weapon:    p.weapon,
			Pos:       p.pos,
			Vel:       p.vel,
			Origin:    p.origin,
			Target:    p.target,
			LaunchY:   p.launchY,
			Speed:     p.speed,
			VMax:      p.vmax,
			Accel:     p.accel,
			TurnAng:   p.turnAng,
			HomingR:   p.homingR,
			Gravity:   p.gravity,
			AoE:       p.aoe,
			Damage:    p.damage,
			AgeSec:    p.ageSec,
			LifeSec:   p.lifeSec,
			LastDist:  p.lastDistT,
			Closing:    p.closing,
			Heading:    p.heading,
			Pitch:      p.pitch,
			FromPiece:  p.fromPiece,
			BurstLeft:  p.burstLeft,
			BurstGap:   p.burstGap,
			BurstSince: p.burstSince,
		})
	}
	return out
}

// Restore replaces the world's unit set and resets the tick so a client can
// initialize its local prediction engine to the authority's current state.
// Meta and binding are re-resolved by name through the spawn provider; the
// nextID counter is advanced past every restored id so later spawns stay in
// lockstep with the authority. In-flight projectiles are rebuilt verbatim so the
// joiner's sky matches the authority's and any shot still en route lands (and
// applies its damage) on the same tick everywhere.
func (w *World) Restore(tick uint64, units []RestoredUnit, projectiles []RestoredProjectile) {
	w.units = make(map[uint32]*Unit, len(units))
	w.order = w.order[:0]
	w.tick = tick
	w.simMs = TickToMs(tick) // simMs is derived purely from the tick count
	w.events = nil
	w.restoreProjectiles(projectiles)
	var maxID uint32
	for _, ru := range units {
		var meta *UnitMeta
		var binding Binding
		if w.spawn != nil {
			meta, binding = w.spawn(ru.Name)
		}
		buildPct := ru.BuildPercent
		if buildPct == 0 && ru.BuildState == 0 && ru.BuildName == "" {
			// Snapshots predating build-cycle state carry no percent; a live
			// unit there is always complete.
			buildPct = fixed.FromInt(100)
		}
		u := &Unit{
			ID:           ru.ID,
			Name:         ru.Name,
			Side:         ru.Side,
			Meta:         meta,
			Health:       ru.Health,
			Dead:         ru.Dead,
			BuildPercent: buildPct,
			buildState:   buildPhase(ru.BuildState),
			buildName:    ru.BuildName,
			buildSite:    ru.BuildSite,
			buildeeID:    ru.BuildTargetID,
			buildGateMs:  ru.BuildGateMs,
			prodQueue:    append([]string(nil), ru.ProdQueue...),
			moveMode:     ru.MoveMode,
			fireMode:     ru.FireMode,
			homePos:      ru.HomePos,
			autoEngaged:  ru.AutoEngaged,
			curIsPatrol:  ru.CurIsPatrol,
			selfDAtMs:    ru.SelfDAtMs,
			carriedBy:    ru.CarriedBy,
			carrying:     append([]uint32(nil), ru.Carrying...),
			loadTarget:   ru.LoadTarget,
			stallTicks:   ru.StallTicks,
			avoidFlip:    ru.AvoidFlip,
			progressPos:  fixed.Vec2{X: ru.ProgressX, Z: ru.ProgressZ},
			hasUnload:    ru.HasUnload,
			unloadAt:     ru.UnloadAt,
			hasMove:      ru.HasMove,
			moveTarget:   ru.MoveTarget,
			IsMoving:     ru.HasMove || ru.MotionPin == motionPinMoving,
			motionPin:    ru.MotionPin,
			hasAttack:    ru.HasAttack,
			attackTarget: ru.AttackTarget,
			kills:        ru.Kills,
			xp:           ru.XP,
			binding:      binding,
		}
		for _, c := range ru.Queue {
			u.queue = append(u.queue, queuedCommand{kind: order.Kind(c.Kind), target: c.Target, targetUnit: c.TargetUnit, name: c.Name})
		}
		// Re-arm any standing weapon orders so the joiner's prediction re-aims and
		// fires them (replaying the firing animation) instead of leaving the unit
		// at its Create-time rest pose. Only the order intent is restored; the aim
		// thread re-runs from scratch on the next step.
		for i := range ru.Weapons {
			rw := ru.Weapons[i]
			if !rw.HasTarget {
				continue
			}
			u.weapons[i] = weaponSlot{
				hasTarget:  true,
				targetUnit: rw.TargetUnit,
				targetPt:   rw.TargetPt,
				source:     rw.Source,
				// Inherit the authority's reload clock so the joiner's next shot
				// lands on the same tick instead of restarting the reload cycle.
				lastFireMs:  rw.LastFireMs,
				reloadTicks: rw.ReloadTicks,
			}
		}
		u.loco.Pos = fixed.Vec2{X: ru.Pos.X, Z: ru.Pos.Z}
		u.loco.Heading = ru.Heading
		u.loco.Speed = ru.Speed
		u.PosY = ru.Pos.Y
		if ci, ok := binding.(cobImporter); ok && ru.Cob != nil {
			// Adopt the authority's exact live VM state — every piece animator,
			// thread and static — so the joiner's poses match to the angle instead
			// of being approximated by a fresh Create/StartMoving replay. This is the
			// pixel-perfect path; the replay below is the fallback for bindings or
			// snapshots that carry no COB state.
			ci.ImportCob(*ru.Cob)
		} else {
			// Run the Create script just as AddUnit does, so a unit restored on a
			// late-joining client lays out its initial pose and starts its idle
			// animation threads instead of standing inert (its body pieces never
			// positioned, radar/idle loops never spun up). Piece animation is not
			// hashed, so re-running Create on the client cannot perturb lockstep.
			if binding != nil && binding.HasScript("Create") {
				startCreate(binding)
			}
			startSetMaxReloadTime(u.Meta, binding)
			// A unit caught mid-move was animating its walk/drive cycle on the
			// authority; the move-start transition that kicks StartMoving already
			// fired before the snapshot, so re-arm it here or the restored unit glides
			// to its destination frozen in its Create-time rest pose (legs/tracks not
			// moving). A replay motion pin caught in the moving state re-arms the
			// same way.
			if (u.hasMove || u.motionPin == motionPinMoving) &&
				binding != nil && binding.HasScript("StartMoving") {
				binding.Start("StartMoving")
			}
		}
		w.units[ru.ID] = u
		w.order = append(w.order, ru.ID)
		if ru.ID > maxID {
			maxID = ru.ID
		}
	}
	w.nextID = maxID + 1
}

// weaponMetaFor re-resolves a restored projectile's weapon stat block from
// its owner's meta so detonation keeps its damage table and splash rules
// across a join. When the owner (or the slot's weapon) is gone, the flight
// record's own aoe/damage figures stand in.
func (w *World) weaponMetaFor(ownerID uint32, slot int, name string, aoe, damage fixed.Fixed) WeaponMeta {
	if u := w.units[ownerID]; u != nil && u.Meta != nil && slot >= 0 && slot < len(u.Meta.Weapons) {
		wm := u.Meta.Weapons[slot]
		if wm.Present && (name == "" || wm.Name == name) {
			return wm
		}
	}
	return WeaponMeta{
		Name:           name,
		Present:        true,
		AreaOfEffectWU: aoe,
		Damage:         damage,
		DamageDefault:  damage.Int(),
	}
}

// restoreProjectiles rebuilds the in-flight model weapons from a snapshot,
// copying each flight record back verbatim, and advances nextProjID past every
// restored id so later shots keep unique render identities. Caller holds the
// world's single-goroutine invariant (Restore runs on the sim goroutine).
func (w *World) restoreProjectiles(projectiles []RestoredProjectile) {
	w.projectiles = make([]*projectile, 0, len(projectiles))
	maxID := w.nextProjID
	if maxID > 0 {
		maxID--
	}
	for _, rp := range projectiles {
		w.projectiles = append(w.projectiles, &projectile{
			id:        rp.ID,
			ownerID:   rp.OwnerID,
			targetID:  rp.TargetID,
			slot:      rp.Slot,
			mode:      projMode(rp.Mode),
			phase:     projPhase(rp.Phase),
			model:     rp.Model,
			weapon:    rp.Weapon,
			pos:       rp.Pos,
			vel:       rp.Vel,
			origin:    rp.Origin,
			target:    rp.Target,
			launchY:   rp.LaunchY,
			speed:     rp.Speed,
			vmax:      rp.VMax,
			accel:     rp.Accel,
			turnAng:   rp.TurnAng,
			homingR:   rp.HomingR,
			gravity:   rp.Gravity,
			aoe:       rp.AoE,
			damage:    rp.Damage,
			ageSec:    rp.AgeSec,
			lifeSec:   rp.LifeSec,
			lastDistT:  rp.LastDist,
			closing:    rp.Closing,
			heading:    rp.Heading,
			pitch:      rp.Pitch,
			fromPiece:  rp.FromPiece,
			burstLeft:  rp.BurstLeft,
			burstGap:   rp.BurstGap,
			burstSince: rp.BurstSince,
			wm:         w.weaponMetaFor(rp.OwnerID, rp.Slot, rp.Weapon, rp.AoE, rp.Damage),
		})
		if rp.ID > maxID {
			maxID = rp.ID
		}
	}
	w.nextProjID = maxID + 1
}

// RemoveUnit despawns a unit.
func (w *World) RemoveUnit(id uint32) {
	if _, ok := w.units[id]; !ok {
		return
	}
	delete(w.units, id)
	for i, oid := range w.order {
		if oid == id {
			w.order = append(w.order[:i], w.order[i+1:]...)
			break
		}
	}
	w.emit(frame.Event{Kind: frame.EvDespawn, UnitID: id})
}

// ApplyOrder dispatches a player order into the world. This is the single
// mutation entry point the session/network layer calls.
func (w *World) ApplyOrder(o order.Order) {
	switch o.Kind {
	case order.KindMove:
		// Hard border: a move destination off the map is pulled to the edge, so
		// no unit can be navigated past it (aircraft fly their own maneuvers and
		// are governed separately in stepMovement).
		o.Target = w.clampToMap(o.Target, 0)
		for _, id := range o.UnitIDs {
			if u := w.units[id]; u != nil && !u.Dead && !u.underConstruction() {
				// A factory can't move — a Move sets its rally template
				// instead: the waypoint chain every produced unit inherits
				// on rolloff. Plain Move replaces the chain, shift extends.
				if isRallyHolder(u) {
					if !o.Queued {
						u.queue = nil
					}
					u.enqueue(queuedCommand{kind: order.KindMove, target: o.Target})
					continue
				}
				if o.Queued && u.busy() {
					u.enqueue(queuedCommand{kind: order.KindMove, target: o.Target})
					continue
				}
				u.queue = nil
				u.hasMove = true
				u.moveTarget = o.Target
				u.clearPath()
				// Move cancels an autonomous attack (as in TA); a committed bomb
				// run survives so the bomb-and-bail tactic still lays its string.
				u.hasAttack = false
				u.autoEngaged = false
				u.curIsPatrol = false
				// The destination becomes the unit's new post — Maneuver's
				// leash and post-combat return anchor there.
				u.homePos = o.Target
			}
		}
	case order.KindPatrol:
		o.Target = w.clampToMap(o.Target, 0)
		for _, id := range o.UnitIDs {
			u := w.units[id]
			if u == nil || u.Dead || u.underConstruction() || u.Meta == nil {
				continue
			}
			// Factory patrol legs extend the rally template; produced units
			// inherit and loop them.
			if isRallyHolder(u) {
				u.enqueue(queuedCommand{kind: order.KindPatrol, target: o.Target})
				continue
			}
			if u.Meta.CanMove {
				// Patrol waypoints always queue; the first one starts at once
				// when the unit has nothing in flight.
				idle := !u.busy()
				u.enqueue(queuedCommand{kind: order.KindPatrol, target: o.Target})
				if idle {
					w.advanceQueue(u)
				}
			}
		}
	case order.KindSelfDestruct:
		for _, id := range o.UnitIDs {
			if u := w.units[id]; u != nil && !u.Dead && !u.underConstruction() {
				if u.selfDAtMs != 0 {
					u.selfDAtMs = 0 // second press disarms
				} else {
					u.selfDAtMs = w.simMs + selfDestructCountdownMs
				}
			}
		}
	case order.KindStance:
		for _, id := range o.UnitIDs {
			if u := w.units[id]; u != nil && !u.Dead {
				if o.MoveMode >= order.MoveHold && o.MoveMode <= order.MoveRoam {
					u.moveMode = uint8(o.MoveMode)
				}
				if o.FireMode >= order.FireHold && o.FireMode <= order.FireAtWill {
					u.fireMode = uint8(o.FireMode)
					// Hold Fire stands an autonomous engagement down at once.
					if u.fireMode == order.FireHold && u.autoEngaged {
						u.hasAttack = false
						u.attackTarget = 0
						u.autoEngaged = false
					}
				}
			}
		}
	case order.KindAttack:
		for _, id := range o.UnitIDs {
			if u := w.units[id]; u != nil && !u.Dead && !u.underConstruction() {
				if t := w.units[o.TargetUnit]; t != nil && !t.Dead && t != u {
					if o.Queued && u.busy() {
						u.enqueue(queuedCommand{kind: order.KindAttack, targetUnit: o.TargetUnit})
						continue
					}
					u.queue = nil
					u.hasAttack = true
					u.attackTarget = o.TargetUnit
				}
			}
		}
	case order.KindStop:
		for _, id := range o.UnitIDs {
			w.stopUnit(id)
		}
	case order.KindFire:
		if u := w.units[o.UnitID]; u != nil && !u.Dead && o.Slot >= 0 && o.Slot < 3 {
			s := &u.weapons[o.Slot]
			s.hasTarget = true
			s.source = "manual"
			if o.HasTargetUnit {
				s.targetUnit = o.TargetUnit
			} else {
				s.targetUnit = 0
				s.targetPt = fixed.Vec3{X: o.Target.X, Z: o.Target.Z}
			}
		}
	case order.KindSpawn:
		if w.spawn != nil {
			meta, binding := w.spawn(o.Name)
			if meta != nil {
				w.AddUnit(o.Name, meta, binding, o.SpawnAt, o.Heading, o.Side)
			}
		}
	case order.KindRemove:
		w.RemoveUnit(o.UnitID)
	case order.KindLoad:
		for _, id := range o.UnitIDs {
			if t := w.units[id]; t != nil && !t.Dead && !t.underConstruction() {
				w.applyLoad(t, o.TargetUnit)
			}
		}
	case order.KindUnload:
		for _, id := range o.UnitIDs {
			if t := w.units[id]; t != nil && !t.Dead {
				w.applyUnload(t, o.Target)
			}
		}
	case order.KindBuild:
		// Resume gesture: a Build naming an existing under-construction
		// frame (TargetUnit) sends the builder to that frame and continues
		// raising IT instead of spawning a fresh one.
		if o.TargetUnit != 0 {
			u := w.units[o.UnitID]
			b := w.units[o.TargetUnit]
			if u == nil || u.Dead || u.Meta == nil || !u.Meta.IsBuilder || !u.Meta.CanMove ||
				b == nil || b.Dead || !b.underConstruction() {
				return
			}
			w.cancelBuild(u)
			u.buildState = buildApproach
			u.buildName = b.Name
			u.buildSite = b.loco.Pos
			u.buildHeadingSet = false
			u.buildResumeID = b.ID
			u.hasAttack = false
			u.queue = nil
			return
		}
		// A site the buildee cannot legally occupy (sonar on land, a plant
		// in deep water, a plot too uneven for its footprint) refuses the
		// order outright. This legality probe applies ONLY to mobile builders
		// placing a structure at a chosen ground site: a factory's order
		// targets the factory's OWN position, where canBuildAt would always
		// fail (the buildee's footprint overlaps the factory itself) — the
		// factory raises its unit on the pad regardless, so it must skip this.
		if w.spawn != nil && w.terrain != nil {
			if ub := w.units[o.UnitID]; ub != nil && ub.Meta != nil && ub.Meta.CanMove {
				if bm, _ := w.spawn(o.Name); bm != nil && !w.canBuildAt(bm, o.Target) {
					return
				}
			}
		}
		// A shift-queued Build on a busy mobile builder defers behind the
		// current job; advanceQueue starts it when the queue reaches it.
		if o.Queued {
			if u := w.units[o.UnitID]; u != nil && !u.Dead && u.Meta != nil &&
				u.Meta.CanMove && u.Meta.IsBuilder &&
				(u.busy() || u.buildState != buildIdle) {
				u.enqueue(queuedCommand{kind: order.KindBuild, name: o.Name, target: o.Target,
					heading: o.Heading, headingSet: true})
				return
			}
		}
		u := w.units[o.UnitID]
		if u == nil || u.Dead || u.underConstruction() ||
			u.Meta == nil || !u.Meta.IsBuilder || o.Name == "" {
			return
		}
		if u.Meta.CanMove {
			// Mobile builder: a new job replaces any current one (the
			// half-built buildee stays, inert, where it was abandoned — as
			// in TA).
			w.cancelBuild(u)
			u.buildState = buildApproach
			u.buildName = o.Name
			u.buildSite = o.Target
			u.buildHeading = o.Heading
			u.buildHeadingSet = true
			u.buildResumeID = 0
			u.hasAttack = false
			u.queue = nil
			return
		}
		// Factory: every order APPENDS to the production run — repeat clicks
		// queue copies, mixed types queue freely. stepBuilder pops the head
		// onto the pad whenever it goes idle.
		if len(u.prodQueue) < maxOrderQueue {
			u.prodQueue = append(u.prodQueue, o.Name)
		}
	}
}

// cancelBuild abandons a builder's job: the StopBuilding script retracts the
// nano/casting pose and the client tears down its lathe effect on the stop
// event. A partially-raised buildee is left where it stands, inert.
func (w *World) cancelBuild(u *Unit) {
	if u.buildState == buildIdle {
		return
	}
	if u.buildState == buildRaising {
		if u.binding != nil && u.binding.HasScript("StopBuilding") {
			u.binding.Start("StopBuilding")
		}
		w.emit(frame.Event{Kind: frame.EvBuildStop, UnitID: u.ID, TargetID: u.buildeeID, Anchor: u.Pos()})
	}
	if !u.Meta.CanMove && u.binding != nil && u.binding.HasScript("Deactivate") {
		u.binding.Start("Deactivate")
	}
	u.buildState = buildIdle
	u.buildName = ""
	u.buildeeID = 0
	u.buildHeadingSet = false
}

// busy reports whether a unit has a current order a queued one would wait
// behind. With nothing in flight a queued order applies immediately.
func (u *Unit) busy() bool {
	return u.hasMove || u.hasAttack || len(u.queue) > 0
}

// enqueue appends a deferred order, bounded by maxOrderQueue (excess orders
// are dropped — the same cap retail TA applied to its queue memory).
func (u *Unit) enqueue(c queuedCommand) {
	if len(u.queue) >= maxOrderQueue {
		return
	}
	u.queue = append(u.queue, c)
}

// isRallyHolder reports whether the unit keeps its order queue as a rally
// template for produced units (an immobile builder — a factory) rather than
// consuming it itself.
func isRallyHolder(u *Unit) bool {
	return u.Meta != nil && !u.Meta.CanMove && u.Meta.IsBuilder
}

// advanceQueue pops deferred orders until one takes effect: a queued move or
// patrol leg arms locomotion (a patrol leg re-queues itself on arrival); a
// queued attack arms pursuit if its target is still alive, else it is
// skipped and the next entry is tried.
func (w *World) advanceQueue(u *Unit) {
	// A factory's queue is its rally template — produced units consume a
	// copy; the factory itself never drains it.
	if isRallyHolder(u) {
		return
	}
	u.curIsPatrol = false
	for len(u.queue) > 0 {
		c := u.queue[0]
		u.queue = u.queue[1:]
		switch c.kind {
		case order.KindMove, order.KindPatrol:
			u.hasMove = true
			u.moveTarget = c.target
			u.clearPath()
			u.hasAttack = false
			u.curIsPatrol = c.kind == order.KindPatrol
			return
		case order.KindAttack:
			if t := w.units[c.targetUnit]; t != nil && !t.Dead && t != u {
				u.hasMove = false
				u.hasAttack = true
				u.attackTarget = c.targetUnit
				return
			}
		case order.KindBuild:
			if c.name != "" && u.Meta != nil && u.Meta.CanMove && u.Meta.IsBuilder {
				u.buildName = c.name
				u.buildSite = c.target
				u.buildHeading = c.heading
				u.buildHeadingSet = c.headingSet
				u.buildState = buildApproach
				return
			}
		case order.KindLoad:
			if cargo := w.units[c.targetUnit]; loadable(u, cargo) {
				u.loadTarget = c.targetUnit
				return
			}
		case order.KindUnload:
			if len(u.carrying) > 0 {
				u.hasUnload = true
				u.unloadAt = c.target
				return
			}
		}
	}
	if len(u.queue) == 0 {
		u.queue = nil
	}
}

func (w *World) stopUnit(id uint32) {
	u := w.units[id]
	if u == nil {
		return
	}
	u.queue = nil
	u.hasMove = false
	u.hasAttack = false
	u.attackTarget = 0
	u.atkActive = false
	u.bombRunActive = false
	u.prodQueue = nil
	u.curIsPatrol = false
	u.autoEngaged = false
	u.loadTarget = 0
	u.hasUnload = false
	// Standing here is the unit's new post.
	u.homePos = u.loco.Pos
	w.cancelBuild(u)
	for i := range u.weapons {
		w.clearWeaponSlot(u, i)
	}
	if u.binding != nil && u.binding.HasScript("StopMoving") {
		u.binding.Start("StopMoving")
	}
}

// ApplyDamage subtracts dmg from target HP, emitting hit and (on lethal) death.
func (w *World) ApplyDamage(sourceID, targetID uint32, dmg fixed.Fixed) bool {
	t := w.units[targetID]
	if t == nil || t.Dead || t.carriedBy != 0 {
		return false
	}
	// Health runs on a 0..100 percent scale; when the target carries its
	// absolute hit points (FBI maxdamage), scale the weapon's absolute TDF
	// damage onto that bar so combat follows the game data. Without it
	// (test fakes, units shipping no maxdamage), damage applies at face
	// value — the legacy percent-direct scale.
	if t.Meta != nil && t.Meta.MaxHealth > 0 {
		dmg = dmg.Mul(fixed.FromInt(100)).Div(t.Meta.MaxHealth)
		if dmg <= 0 {
			dmg = fixed.FromFloat(0.05)
		}
	}
	t.Health -= dmg
	// Mark the provocation for Return Fire: a damaged unit engages back and
	// stays engaged while enemies remain in reach (stepStance re-arms off
	// this stamp).
	t.provokedMs = w.simMs
	w.emit(frame.Event{Kind: frame.EvHit, UnitID: sourceID, TargetID: targetID})
	if t.Health <= 0 {
		// Kill credit: the attacker delivering the lethal blow earns a kill
		// (and the victim's experience value) when the victim was an enemy
		// and fully built — the counters every veterancy consumer reads.
		if killer := w.units[sourceID]; killer != nil && killer != t &&
			killer.Side != t.Side && t.BuildPercent >= fixed.FromInt(100) {
			killer.kills++
			if t.Meta != nil {
				killer.xp += t.Meta.ExperiencePoints
			}
		}
		// severity is the killing blow as a percentage of the unit's full
		// health bar — the figure TA's Killed(severity, corpsetype) scripts
		// threshold on (<=25 leaves a clean corpse, <=50 a damaged one,
		// beyond that debris or nothing). dmg was already scaled onto the
		// percent bar above. An ordinary death detonates the unit's
		// explodeas blast; self-destruct routes through killUnit with
		// selfdestructas instead.
		var blast Blast
		if t.Meta != nil {
			blast = t.Meta.Explode
		}
		w.killUnit(t, int(dmg.Float()), blast)
		return true
	}
	return false
}
