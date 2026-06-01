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
		"submitStop":   js.FuncOf(submitStop),
		"scheduleAt":   js.FuncOf(scheduleAt),
		"restore":      js.FuncOf(restore),
		"step":         js.FuncOf(step),
		"hash":         js.FuncOf(hashOf),
		"tick":         js.FuncOf(tickOf),
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

// submitMove(handle, unitIds[], tx, tz) -> execTick.
func submitMove(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	ids := uint32Slice(args[1])
	target := fixed.Vec2{X: fixed.FromFloat(args[2].Float()), Z: fixed.FromFloat(args[3].Float())}
	return int(inst.sess.Submit(order.Move(ids, target)))
}

// submitAttack(handle, unitIds[], targetUnitId) -> execTick.
func submitAttack(_ js.Value, args []js.Value) any {
	inst := instances[args[0].Int()]
	if inst == nil {
		return 0
	}
	ids := uint32Slice(args[1])
	return int(inst.sess.Submit(order.Attack(ids, uint32(args[2].Int()))))
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
	tick, units := restoreFromJS(args[1])
	inst.sess.Restore(tick, units)
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
