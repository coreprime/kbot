// Command engine-wasm compiles the deterministic simulation core to a
// GOOS=js/GOARCH=wasm module and exposes it to the browser. It is the local
// half of the two transports the studio web client speaks: the unit viewer and
// offline sandbox drive this in-process module directly, while networked play
// drives the identical engine on the server and replays its command stream.
//
// The bridge is intentionally thin. It owns a registry of Sessions and marshals
// orders in and render snapshots out across the JS boundary, converting
// fixed-point to float exactly once per frame on the way out — the one place a
// float is allowed to touch engine data.
//
//go:build js && wasm

package main

import (
	"bytes"
	"syscall/js"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/script"
	"github.com/coreprime/kbot/engine/session"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/scripting"
)

// instance pairs a session with the optional JS unit-meta resolver used when a
// Spawn order has to materialize a unit by name (the networked path). It owns a
// per-session script runtime that drives every bound unit's COB animation in
// lockstep, plus a name-keyed cache of compiled programs so each unit type's
// bytecode is disassembled at most once.
type instance struct {
	sess     *session.Session
	world    *sim.World
	rt       *script.Runtime
	resolve  js.Value                   // a JS function name -> meta object, or undefined
	programs map[string]*script.Program // unit name -> compiled COB, nil = no script
}

var (
	instances = map[int]*instance{}
	nextID    = 1
)

func main() {
	api := map[string]any{
		"create":       js.FuncOf(create),
		"destroy":      js.FuncOf(destroy),
		"addUnit":      js.FuncOf(addUnit),
		"removeUnit":   js.FuncOf(removeUnit),
		"submitMove":   js.FuncOf(submitMove),
		"submitAttack": js.FuncOf(submitAttack),
		"submitFire":   js.FuncOf(submitFire),
		"submitStop":   js.FuncOf(submitStop),
		"submitBuild":  js.FuncOf(submitBuild),
		"scheduleAt":   js.FuncOf(scheduleAt),
		"restore":      js.FuncOf(restore),
		"step":         js.FuncOf(step),
		"renderState":  js.FuncOf(renderState),
		"hash":           js.FuncOf(hashOf),
		"tick":           js.FuncOf(tickOf),
		"cobState":       js.FuncOf(cobState),
		"exportSnapshot": js.FuncOf(exportSnapshot),
		// Developer commands — sandbox-only script control for the Runtime panel.
		"killAllThreads":  js.FuncOf(killAllThreads),
		"killUnitThreads": js.FuncOf(killUnitThreads),
		"killThread":      js.FuncOf(killThread),
		"resetUnit":       js.FuncOf(resetUnitScript),
		// COB debugger — offline unit-editor script debugging (single-step,
		// breakpoints, variable edits, coverage). Debug-only; never networked.
		"stepThread":          js.FuncOf(stepThread),
		"setThreadPc":         js.FuncOf(setThreadPc),
		"setThreadLocal":      js.FuncOf(setThreadLocal),
		"setStaticVar":        js.FuncOf(setStaticVar),
		"addBreakpoint":       js.FuncOf(addBreakpoint),
		"removeBreakpoint":    js.FuncOf(removeBreakpoint),
		"clearBreakpoints":    js.FuncOf(clearBreakpoints),
		"clearBreakpointHits": js.FuncOf(clearBreakpointHits),
		"coverage":            js.FuncOf(coverage),
		// Unit-value ports — the offline unit editor drives COB GET_UNIT_VALUE
		// reads (HEALTH / build percent / activation / standing orders) from its
		// inspector sliders. Authoring-only; never networked.
		"setUnitValue": js.FuncOf(setUnitValue),
		"getUnitValue": js.FuncOf(getUnitValue),

		// Script invocation — the offline unit editor's Actions panel runs a
		// named entry point, lists the available ones, and retracts a transient
		// pose handler. Authoring-only; never networked.
		"startScript":       js.FuncOf(startScript),
		"restartScript":     js.FuncOf(restartScript),
		"killThreadsByName": js.FuncOf(killThreadsByName),
		"scriptNames":       js.FuncOf(scriptNames),
	}
	js.Global().Set("KbotEngine", js.ValueOf(api))

	// Park the goroutine: the module stays resident so JS can keep calling in.
	select {}
}

// create(seed, inputDelay, spawnResolver?) -> handle. spawnResolver is an
// optional JS function (name) -> metaObject used to back Spawn orders.
func create(_ js.Value, args []js.Value) any {
	seed := uint32(0)
	delay := uint64(0)
	if len(args) > 0 {
		seed = uint32(args[0].Int())
	}
	if len(args) > 1 {
		delay = uint64(args[1].Int())
	}
	inst := &instance{programs: map[string]*script.Program{}}
	if len(args) > 2 && args[2].Type() == js.TypeFunction {
		inst.resolve = args[2]
	}
	inst.rt = script.NewRuntime(seed)
	w := sim.New(sim.Config{Seed: seed, Spawn: inst.spawnFunc()})
	inst.world = w
	inst.sess = session.New(session.Config{World: w, Runtime: inst.rt, InputDelay: delay})
	id := nextID
	nextID++
	instances[id] = inst
	return id
}

func destroy(_ js.Value, args []js.Value) any {
	delete(instances, args[0].Int())
	return nil
}

// spawnFunc adapts the JS resolver into a sim.SpawnFunc. Returns nil when no
// resolver was supplied, so a Spawn order is a no-op rather than a crash.
func (inst *instance) spawnFunc() sim.SpawnFunc {
	return func(name string) (*sim.UnitMeta, sim.Binding) {
		if inst.resolve.Type() != js.TypeFunction {
			return nil, nil
		}
		m := inst.resolve.Invoke(name)
		if !m.Truthy() {
			return nil, nil
		}
		meta := metaFromJS(m)
		return meta, inst.bindingFor(meta.Name, m)
	}
}

// bindingFor builds a per-unit script binding from the COB bytes carried on the
// meta object, or nil when the unit ships no script. The returned binding
// registers with the instance runtime so session.Step animates its pieces.
func (inst *instance) bindingFor(name string, metaObj js.Value) sim.Binding {
	prog := inst.program(name, metaObj)
	if prog == nil {
		return nil
	}
	return inst.rt.NewUnit(prog, nil)
}

// program compiles (and caches) the COB program for a unit type. A miss is
// cached as nil so a script-less type is probed at most once.
func (inst *instance) program(name string, metaObj js.Value) *script.Program {
	if p, ok := inst.programs[name]; ok {
		return p
	}
	prog := compileCOB(cobBytes(metaObj))
	inst.programs[name] = prog
	return prog
}

// compileCOB disassembles raw COB bytes into a shared program, returning nil if
// the bytes are absent or unparseable so the unit degrades to a script-less one.
func compileCOB(b []byte) *script.Program {
	if len(b) == 0 {
		return nil
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(b))
	if err != nil {
		return nil
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		return nil
	}
	return prog
}

// addUnit(handle, metaObj, x, z, headingRad, side) -> unitId. Direct insertion
// for the offline/authoring path; networked clients receive Spawn orders.
func addUnit(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	meta := metaFromJS(args[1])
	at := fixed.Vec2{X: fixed.FromFloat(args[2].Float()), Z: fixed.FromFloat(args[3].Float())}
	heading := fixed.RadiansToAngle(args[4].Float())
	side := args[5].Int()
	binding := inst.bindingFor(meta.Name, args[1])
	return int(inst.world.AddUnit(meta.Name, meta, binding, at, heading, side))
}

func removeUnit(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.RemoveUnit(uint32(args[1].Int()))
	}
	return nil
}

// submitMove(handle, unitIds[], tx, tz, queued?) -> execTick. A truthy queued
// appends the move to each unit's shift-queue instead of replacing its orders.
func submitMove(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	ids := uint32Slice(args[1])
	target := fixed.Vec2{X: fixed.FromFloat(args[2].Float()), Z: fixed.FromFloat(args[3].Float())}
	if len(args) > 4 && args[4].Truthy() {
		return int(inst.sess.Submit(order.MoveQueued(ids, target)))
	}
	return int(inst.sess.Submit(order.Move(ids, target)))
}

// submitAttack(handle, unitIds[], targetUnitId, queued?) -> execTick.
func submitAttack(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	ids := uint32Slice(args[1])
	if len(args) > 3 && args[3].Truthy() {
		return int(inst.sess.Submit(order.AttackQueued(ids, uint32(args[2].Int()))))
	}
	return int(inst.sess.Submit(order.Attack(ids, uint32(args[2].Int()))))
}

// submitFire(handle, unitId, slot, targetUnitId, px, pz) -> execTick. A nonzero
// targetUnitId force-fires the slot at that unit; otherwise the slot fires at
// the ground point (px, pz). This is the manual / shift-to-ground force-fire
// path, distinct from a standing Attack order.
func submitFire(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	unit := uint32(args[1].Int())
	slot := args[2].Int()
	targetUnit := uint32(args[3].Int())
	if targetUnit != 0 {
		return int(inst.sess.Submit(order.FireAtUnit(unit, slot, targetUnit)))
	}
	pt := fixed.Vec2{X: fixed.FromFloat(args[4].Float()), Z: fixed.FromFloat(args[5].Float())}
	return int(inst.sess.Submit(order.FireAtPoint(unit, slot, pt)))
}

// submitBuild(handle, builderId, name, tx, tz) -> execTick. Sends a mobile
// builder to construct unit type name at the ground point.
func submitBuild(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	target := fixed.Vec2{X: fixed.FromFloat(args[3].Float()), Z: fixed.FromFloat(args[4].Float())}
	return int(inst.sess.Submit(order.Build(uint32(args[1].Int()), args[2].String(), target)))
}

// submitStop(handle, unitIds[]) -> execTick.
func submitStop(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	return int(inst.sess.Submit(order.Stop(uint32Slice(args[1]))))
}

// scheduleAt(handle, tick, orderObj) queues an order at an exact tick. The
// networked client uses it to apply the authoritative command stream.
func scheduleAt(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return nil
	}
	inst.sess.ScheduleAt(uint64(args[1].Int()), orderFromJS(args[2]))
	return nil
}

// restore(handle, snapshotObj) reinitializes the local world from an
// authoritative snapshot, used when a client joins a match already in progress.
func restore(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return nil
	}
	// Drop the runtime's stale units before the world rebuilds its set: the
	// session's Restore re-resolves each unit's binding through the spawn
	// provider, which registers a fresh script unit on the runtime. Resetting
	// first keeps the runtime's unit list in step with the restored world.
	inst.rt.Reset()
	tick, units, projectiles, runtimeRng := restoreFromJS(args[1])
	inst.sess.Restore(tick, units, projectiles)
	// Adopt the authority's script RNG draw position so OP_RAND on this client
	// draws the same values in the same order, keeping script-driven animation in
	// lockstep. Reset preserves the rng, so this overwrites the seed-time state
	// with the authority's live position. A periodic snapshot carries no rng (0),
	// in which case we leave the runtime's own stream untouched.
	if runtimeRng != 0 {
		inst.rt.RestoreRng(runtimeRng)
	}
	return nil
}

// step(handle) advances one tick and returns the render snapshot.
func step(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return js.Null()
	}
	return snapshotToJS(inst.sess.Step())
}

// renderState(handle) returns the render snapshot of the world at its current
// tick WITHOUT advancing it. The networked client uses this after a restore to
// paint the authority's unit set immediately — even while the shared clock is
// paused, where step() would never run — so a window joining a paused match
// shows the live units rather than an empty field until resume.
func renderState(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return js.Null()
	}
	return snapshotToJS(inst.world.Snapshot())
}

// exportSnapshot(handle) returns the local world's authoritative state in the
// same shape the server's wire snapshot serializes to (raw fixed-point integers,
// matching field names), for the Network panel's Diagnose drift comparison. It
// does not advance the world. Read-only / debug-only.
func exportSnapshot(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return js.Null()
	}
	return snapshotToWireJS(inst)
}

// hash(handle) returns the world hash as a decimal string (uint64 exceeds the
// JS safe-integer range, so it crosses the boundary as text).
func hashOf(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return ""
	}
	return formatUint(inst.world.Hash())
}

func tickOf(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	return int(inst.world.Tick())
}

// killAllThreads(handle) terminates every COB thread on every unit (the Runtime
// panel's "Terminate All Scripts" command). Sandbox-only dev tooling.
func killAllThreads(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.KillAllThreads()
	}
	return nil
}

// killUnitThreads(handle, unitId) stops every thread on one unit.
func killUnitThreads(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitKillThreads(uint32(args[1].Int()))
	}
	return nil
}

// killThread(handle, unitId, threadId) stops a single thread by its per-unit id.
func killThread(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitKillThread(uint32(args[1].Int()), int32(args[2].Int()))
	}
	return nil
}

// resetUnitScript(handle, unitId) returns one unit to a clean script state:
// threads killed, statics zeroed, animators + visibility reset.
func resetUnitScript(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitReset(uint32(args[1].Int()))
	}
	return nil
}

// stepThread(handle, unitId, threadId) advances one COB thread by a single
// instruction (the debugger's Step button).
func stepThread(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitStepThread(uint32(args[1].Int()), int32(args[2].Int()))
	}
	return nil
}

// setThreadPc(handle, unitId, threadId, pcIndex) moves a thread's program
// counter to an instruction index.
func setThreadPc(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitSetThreadPC(uint32(args[1].Int()), int32(args[2].Int()), args[3].Int())
	}
	return nil
}

// setThreadLocal(handle, unitId, threadId, index, value) edits a thread local.
func setThreadLocal(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitSetThreadLocal(uint32(args[1].Int()), int32(args[2].Int()), args[3].Int(), int32(args[4].Int()))
	}
	return nil
}

// setStaticVar(handle, unitId, index, value) edits a unit static variable.
func setStaticVar(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitSetStatic(uint32(args[1].Int()), args[2].Int(), int32(args[3].Int()))
	}
	return nil
}

// addBreakpoint(handle, unitId, scriptIndex, offset) sets a breakpoint; the
// matching offset arrives as the byte offset from the disassembly listing.
func addBreakpoint(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitAddBreakpoint(uint32(args[1].Int()), args[2].Int(), uint32(args[3].Int()))
	}
	return nil
}

// removeBreakpoint(handle, unitId, scriptIndex, offset) clears one breakpoint.
func removeBreakpoint(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitRemoveBreakpoint(uint32(args[1].Int()), args[2].Int(), uint32(args[3].Int()))
	}
	return nil
}

// clearBreakpoints(handle, unitId) drops every breakpoint on a unit.
func clearBreakpoints(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitClearBreakpoints(uint32(args[1].Int()))
	}
	return nil
}

// clearBreakpointHits(handle, unitId) releases every thread parked on a
// breakpoint so execution resumes (the debugger's Continue).
func clearBreakpointHits(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitClearBreakpointHits(uint32(args[1].Int()))
	}
	return nil
}

// coverage(handle, unitId) returns the unit's executed byte offsets keyed by
// script index, for the debugger's coverage-dimming view.
func coverage(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return js.ValueOf(map[string]any{})
	}
	return coverageToJS(inst.world.UnitCoverage(uint32(args[1].Int())))
}

// setUnitValue(handle, unitId, port, value) writes a COB unit-value port so the
// unit editor's sliders (damage / build) and Ports inspector drive script reads.
func setUnitValue(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitSetValuePort(uint32(args[1].Int()), args[2].Int(), int32(args[3].Int()))
	}
	return nil
}

// getUnitValue(handle, unitId, port) reads back a COB unit-value port for the
// Ports inspector — the value GET_UNIT_VALUE would yield for that port now.
func getUnitValue(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	return int(inst.world.UnitValuePort(uint32(args[1].Int()), args[2].Int()))
}

// startScript(handle, unitId, name, [args]) spawns a thread on the named entry
// point, passing the optional integer array as its initial locals.
func startScript(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitStartScript(uint32(args[1].Int()), args[2].String(), scriptArgs(args, 3)...)
	}
	return nil
}

// restartScript(handle, unitId, name, [args]) spawns the named script after
// cancelling any live instance of it (the COB START supersede).
func restartScript(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitRestartScript(uint32(args[1].Int()), args[2].String(), scriptArgs(args, 3)...)
	}
	return nil
}

// killThreadsByName(handle, unitId, name) marks dead every live thread running
// the named script (retracting a transient pose handler).
func killThreadsByName(_ js.Value, args []js.Value) any {
	if inst := instances[args[0].Int()]; inst != nil {
		inst.world.UnitKillThreadsByName(uint32(args[1].Int()), args[2].String())
	}
	return nil
}

// scriptNames(handle, unitId) lists a unit type's script entry-point names in
// index order, for the editor's Actions panel.
func scriptNames(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return js.ValueOf([]any{})
	}
	names := inst.world.UnitScriptNames(uint32(args[1].Int()))
	out := make([]any, len(names))
	for i, n := range names {
		out[i] = n
	}
	return js.ValueOf(out)
}

// scriptArgs reads an optional JS integer array at args[idx] into the variadic
// []int the script start methods take, tolerating a missing / non-array arg.
func scriptArgs(args []js.Value, idx int) []int {
	if idx >= len(args) {
		return nil
	}
	return intSliceFromJS(args[idx])
}

// cobState(handle) returns the live COB inspection snapshot — the world tick
// plus, per unit, its static variables and running threads — for the studio's
// Runtime / Script Variables panels. Debug-only: it reads no hashed state and is
// safe to call as often as the inspector refreshes.
func cobState(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return js.ValueOf(map[string]any{"tick": 0, "units": []any{}})
	}
	out := make([]any, 0, inst.world.UnitCount())
	inst.world.ForEachUnit(func(u *sim.Unit) {
		entry := map[string]any{
			"id":      int(u.ID),
			"name":    u.Name,
			"static":  []any{},
			"threads": []any{},
		}
		if cs, ok := inst.world.UnitCob(u.ID); ok {
			entry["static"] = i32SliceToJS(cs.Static)
			entry["threads"] = cobThreadsToJS(cs.Threads)
		}
		out = append(out, entry)
	})
	return js.ValueOf(map[string]any{
		"tick":  int(inst.world.Tick()),
		"units": out,
	})
}
