// frame-source.js
//
// A FrameSource is the renderer's single point of contact with simulation
// state, regardless of where that state is computed.  Two implementations back
// it:
//
//   - WasmFrameSource  — runs the deterministic Go engine in-process via
//                        WebAssembly.  Used by the unit viewer and offline
//                        sandbox.  Orders take effect locally and immediately.
//   - WsFrameSource    — connects to the authoritative server over a websocket
//                        and drives a local WasmFrameSource for prediction,
//                        applying the authoritative command stream so the local
//                        engine stays in lockstep.
//
// Both expose the same surface so the sandbox / unit-editor can swap transports
// without touching their render or input code:
//
//   source.on(event, handler)        subscribe to sim events (fire, death, ...)
//   source.addUnit(spec) -> id       introduce a unit (offline / authoring)
//   source.move(ids, x, z)           issue orders
//   source.attack(ids, targetId)
//   source.stop(ids)
//   source.step() -> snapshot        advance one tick, return the render frame
//   source.tick  -> number           current simulation tick
//   source.dispose()                 release resources
//
// A render snapshot is a plain object:
//   { tick, units:[{id,name,side,x,y,z,heading,headingRad,health,dead,
//                   buildPercent,isMoving,pieces:[{ox,oy,oz,rx,ry,rz,visible}]}],
//     projos:[...], events:[{kind,unitId,targetId,slot,weapon,sound,x,y,z}] }
//
// The events array on each snapshot is also fanned out through on()/emit() so
// listeners written against the legacy engine event bus keep working.

export class FrameSource {
  constructor() {
    this._handlers = new Map()
    this.tick = 0
  }

  on(event, handler) {
    let set = this._handlers.get(event)
    if (!set) {
      set = new Set()
      this._handlers.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  emit(event, payload) {
    const set = this._handlers.get(event)
    if (!set) return
    for (const h of set) {
      try {
        h(payload)
      } catch (err) {
        // A misbehaving listener must never stall the sim loop.
        console.error(`frame-source: listener for "${event}" threw`, err)
      }
    }
  }

  // _fanOutEvents replays a snapshot's discrete events onto the event bus so
  // effects / audio subscribers fire once per tick.  Subclasses call this from
  // step() after producing the snapshot.
  _fanOutEvents(snapshot) {
    if (!snapshot || !snapshot.events) return
    for (const ev of snapshot.events) {
      this.emit(ev.kind, ev)
    }
  }

  // Subclasses override the rest.
  addUnit() { throw new Error('FrameSource.addUnit not implemented') }
  removeUnit() { throw new Error('FrameSource.removeUnit not implemented') }
  move() { throw new Error('FrameSource.move not implemented') }
  attack() { throw new Error('FrameSource.attack not implemented') }
  stop() { throw new Error('FrameSource.stop not implemented') }
  step() { throw new Error('FrameSource.step not implemented') }
  dispose() {}
}
