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

	Dead         bool
	BuildPercent fixed.Fixed

	IsMoving   bool
	hasMove    bool
	moveTarget fixed.Vec2

	hasAttack    bool
	attackTarget uint32

	weapons [3]weaponSlot

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

	binding Binding
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
	rng     *rng.Rng
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
}

// SpawnFunc builds the meta and (optional) script binding for a unit type.
// Returning a nil binding yields a script-less unit (movement/combat only).
type SpawnFunc func(name string) (*UnitMeta, Binding)

// Config configures a new World.
type Config struct {
	Seed    uint32
	Gravity fixed.Fixed
	Spawn   SpawnFunc
}

// New creates an empty world.
func New(cfg Config) *World {
	g := cfg.Gravity
	if g == 0 {
		g = fixed.FromInt(80)
	}
	return &World{
		units:      make(map[uint32]*Unit),
		nextID:     1,
		nextProjID: 1,
		rng:        rng.New(cfg.Seed),
		gravity:    g,
		spawn:      cfg.Spawn,
	}
}

// Tick returns the current simulation tick number.
func (w *World) Tick() uint64 { return w.tick }

// UnitByID returns a unit or nil.
func (w *World) UnitByID(id uint32) *Unit { return w.units[id] }

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
	u.loco.Pos = at
	u.loco.Heading = fixed.FromInt(int(fixed.NormalizeAngle(heading)))
	w.units[id] = u
	w.order = append(w.order, id)
	if binding != nil && binding.HasScript("Create") {
		binding.Start("Create")
	}
	w.emit(frame.Event{Kind: frame.EvSpawn, UnitID: id})
	return id
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
	Weapons      [3]RestoredWeapon
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
	ID       uint32
	OwnerID  uint32
	TargetID uint32
	Slot     int
	Mode     uint8
	Phase    uint8
	Model    string
	Weapon   string
	Pos      fixed.Vec3
	Vel      fixed.Vec3
	Origin   fixed.Vec3
	Target   fixed.Vec3
	LaunchY  fixed.Fixed
	Speed    fixed.Fixed
	VMax     fixed.Fixed
	Accel    fixed.Fixed
	TurnAng  int32
	HomingR  fixed.Fixed
	Gravity  fixed.Fixed
	AoE      fixed.Fixed
	Damage   fixed.Fixed
	AgeSec   fixed.Fixed
	LifeSec  fixed.Fixed
	LastDist fixed.Fixed
	Closing  bool
	Heading  int32
	Pitch    int32
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
			ID:           u.ID,
			Name:         u.Name,
			Side:         u.Side,
			Pos:          u.Pos(),
			Heading:      u.loco.Heading,
			Speed:        u.loco.Speed,
			HasMove:      u.hasMove,
			MoveTarget:   u.moveTarget,
			Health:       u.Health,
			Dead:         u.Dead,
			HasAttack:    u.hasAttack,
			AttackTarget: u.attackTarget,
		}
		for i := range u.weapons {
			s := &u.weapons[i]
			ru.Weapons[i] = RestoredWeapon{
				HasTarget:  s.hasTarget,
				TargetUnit: s.targetUnit,
				TargetPt:   s.targetPt,
				Source:     s.source,
				LastFireMs: s.lastFireMs,
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
			ID:       p.id,
			OwnerID:  p.ownerID,
			TargetID: p.targetID,
			Slot:     p.slot,
			Mode:     uint8(p.mode),
			Phase:    uint8(p.phase),
			Model:    p.model,
			Weapon:   p.weapon,
			Pos:      p.pos,
			Vel:      p.vel,
			Origin:   p.origin,
			Target:   p.target,
			LaunchY:  p.launchY,
			Speed:    p.speed,
			VMax:     p.vmax,
			Accel:    p.accel,
			TurnAng:  p.turnAng,
			HomingR:  p.homingR,
			Gravity:  p.gravity,
			AoE:      p.aoe,
			Damage:   p.damage,
			AgeSec:   p.ageSec,
			LifeSec:  p.lifeSec,
			LastDist: p.lastDistT,
			Closing:  p.closing,
			Heading:  p.heading,
			Pitch:    p.pitch,
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
	w.simMs = int64(tick) * TickMs // simMs is derived purely from the tick count
	w.events = nil
	w.restoreProjectiles(projectiles)
	var maxID uint32
	for _, ru := range units {
		var meta *UnitMeta
		var binding Binding
		if w.spawn != nil {
			meta, binding = w.spawn(ru.Name)
		}
		u := &Unit{
			ID:           ru.ID,
			Name:         ru.Name,
			Side:         ru.Side,
			Meta:         meta,
			Health:       ru.Health,
			Dead:         ru.Dead,
			BuildPercent: fixed.FromInt(100),
			hasMove:      ru.HasMove,
			moveTarget:   ru.MoveTarget,
			IsMoving:     ru.HasMove,
			hasAttack:    ru.HasAttack,
			attackTarget: ru.AttackTarget,
			binding:      binding,
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
				lastFireMs: rw.LastFireMs,
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
				binding.Start("Create")
			}
			// A unit caught mid-move was animating its walk/drive cycle on the
			// authority; the move-start transition that kicks StartMoving already
			// fired before the snapshot, so re-arm it here or the restored unit glides
			// to its destination frozen in its Create-time rest pose (legs/tracks not
			// moving).
			if u.hasMove && binding != nil && binding.HasScript("StartMoving") {
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
			lastDistT: rp.LastDist,
			closing:   rp.Closing,
			heading:   rp.Heading,
			pitch:     rp.Pitch,
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
		for _, id := range o.UnitIDs {
			if u := w.units[id]; u != nil && !u.Dead {
				u.hasMove = true
				u.moveTarget = o.Target
				// Move cancels an autonomous attack (as in TA); a committed bomb
				// run survives so the bomb-and-bail tactic still lays its string.
				u.hasAttack = false
			}
		}
	case order.KindAttack:
		for _, id := range o.UnitIDs {
			if u := w.units[id]; u != nil && !u.Dead {
				if t := w.units[o.TargetUnit]; t != nil && !t.Dead && t != u {
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
	}
}

func (w *World) stopUnit(id uint32) {
	u := w.units[id]
	if u == nil {
		return
	}
	u.hasMove = false
	u.hasAttack = false
	u.atkActive = false
	u.bombRunActive = false
	for i := range u.weapons {
		u.weapons[i] = weaponSlot{}
	}
	if u.binding != nil && u.binding.HasScript("StopMoving") {
		u.binding.Start("StopMoving")
	}
	if u.binding != nil && u.binding.HasScript("TargetCleared") {
		u.binding.Start("TargetCleared", 0)
	}
}

// ApplyDamage subtracts dmg from target HP, emitting hit and (on lethal) death.
func (w *World) ApplyDamage(sourceID, targetID uint32, dmg fixed.Fixed) bool {
	t := w.units[targetID]
	if t == nil || t.Dead {
		return false
	}
	t.Health -= dmg
	w.emit(frame.Event{Kind: frame.EvHit, UnitID: sourceID, TargetID: targetID})
	if t.Health <= 0 {
		t.Health = 0
		t.Dead = true
		// Run the unit's death script so its corpse animation plays and its
		// EXPLODE opcodes emit debris effects (drained into the render event
		// stream like any other effect). TA's Killed(severity, corpsetype)
		// takes a severity input; corpsetype is an output the script fills, so
		// it starts at zero. Fire-and-forget — the corpse value isn't read back.
		if t.binding != nil && t.binding.HasScript("Killed") {
			t.binding.Start("Killed", 1, 0)
		}
		anchor := t.Pos()
		anchor.Y += fixed.FromInt(18)
		w.emit(frame.Event{Kind: frame.EvDeath, UnitID: targetID, Anchor: anchor})
		return true
	}
	return false
}
