// ws-source.js
//
// FrameSource for authoritative multiplayer.  It connects to a `kbot host`
// server over a websocket, runs a local WasmFrameSource for prediction, and
// applies the server's command stream so the local engine stays bit-identical
// to the authority.  The render loop drives step() exactly as it does offline;
// the only difference is that orders round-trip through the server, which
// assigns each one an execution tick before broadcasting it back as a command
// frame that every client applies at the same tick.
//
// Reconciliation status: the local engine is kept in lockstep purely by the
// command stream, and each authoritative hash is checked against the local
// hash (a mismatch emits a 'desync' event).  Mid-game resync from a full
// snapshot — needed for late joins and after a confirmed desync — requires a
// world-restore entry point the wasm bridge does not yet expose, so it is a
// follow-up.  For a match joined near tick 0 (the common case) the command
// stream alone keeps the client correct.

import { FrameSource } from './frame-source.js'
import { WasmFrameSource } from './wasm-source.js'

const FRAC = 65536 // Q16.16 — world float -> fixed-point for the wire.

function toFixed(f) { return Math.round(f * FRAC) }

export class WsFrameSource extends FrameSource {
  // url:    websocket endpoint, e.g. ws://host:8080/ws?match=default
  // metas:  optional map of unit-type-name -> meta object, used to resolve
  //         Spawn orders in the command stream synchronously.
  constructor({ url, metas = {} } = {}) {
    super()
    this._url = url
    this._metas = metas
    this._ws = null
    this._local = null      // WasmFrameSource driving prediction
    this._joined = false
    this._serverHashes = new Map() // tick -> hash string, pending verification
    this._backlog = []      // messages buffered while the local engine loads
    this._seeded = false    // has an initial snapshot seeded the local world
    this._baseTickMs = 1000 / 40 // server's real-time tick period at rate 1
    this._tickMs = 1000 / 40 // current tick period = baseTickMs / rate
    this._srvTick = 0       // newest authoritative tick observed
    this._srvWall = 0       // wall-clock (ms) when _srvTick was observed
    // Shared-clock state mirrored from the authority's MsgControl. While paused
    // the client stops extrapolating serverTick so every window freezes at the
    // authoritative tick; rate scales _tickMs so a slowed/sped host paces all
    // clients identically.
    this._paused = false
    this._rate = 1
    // Mid-game-join gate: a join above tick 0 must apply the authority's
    // snapshot (and hydrate every unit type's meta) before the local engine may
    // step, or the command stream would replay against an empty world. A fresh
    // (tick-0) join needs no restore and starts stepping immediately.
    this._needsRestore = false
    this._restored = true
    // On-demand meta provider + spawn barrier. A client only registers a type's
    // meta when *it* spawns that type; when another client (or a join snapshot)
    // introduces a type this one has never seen, the Spawn order would resolve
    // to a nil meta and be silently dropped (→ missing unit + permanent desync).
    // _metaProvider lets the source fetch+register such a type the moment it is
    // named, and _spawnBarrier stalls step() until the fetch lands so the Spawn
    // tick never runs against a still-unknown type.
    this._metaProvider = null
    this._metaInflight = new Set()
    this._spawnBarrier = Infinity
  }

  // setMetaProvider installs an async (name) -> meta resolver the source uses to
  // hydrate unit types it observes but has never spawned itself. The scene wires
  // this to its own asset-fetching path (FBI/weapon meta + COB bytes) so a
  // command-stream Spawn or a join snapshot for any type materializes correctly.
  setMetaProvider(fn) { this._metaProvider = fn }

  // registerMeta adds (or replaces) a unit-type meta in the spawn-resolver map.
  // Spawn orders in the command stream resolve synchronously, so a client must
  // have a type's meta + COB bytes registered *before* the authority broadcasts
  // a Spawn for it. The sandbox prefetches these when the user picks a unit.
  registerMeta(name, meta) { this._metas[name] = meta }

  hasMeta(name) { return Object.prototype.hasOwnProperty.call(this._metas, name) }

  _now() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now())
  }

  // _noteServerTick records the authority's clock from any message that carries
  // its *current* tick (join_accept, hash, snapshot — not command frames, whose
  // tick is a future execution time). The render loop extrapolates from this so
  // every client paces its local engine to the same server clock and the two
  // windows stay visually aligned instead of free-running and drifting apart.
  _noteServerTick(t) {
    if (t >= this._srvTick) {
      this._srvTick = t
      this._srvWall = this._now()
    }
  }

  // serverTick is the estimated authoritative tick *right now*, extrapolated at
  // the tick rate from the last observed beacon. The render loop steps the local
  // engine up to (but not past) this value.
  get serverTick() {
    if (!this._joined) return 0
    // Paused: clamp to the last authoritative tick so local prediction freezes
    // exactly where the server did instead of free-running on the wall clock.
    if (this._paused) return this._srvTick
    return this._srvTick + Math.floor((this._now() - this._srvWall) / this._tickMs)
  }

  // paused / rate expose the shared-clock state so the scene's runtime facade
  // can mirror it into the UI (Pause/Resume label, Speed slider) for a joined
  // window without owning the clock itself.
  get paused() { return this._paused }
  get rate() { return this._rate }

  // connect opens the socket and resolves once the server's join_accept has
  // seeded the local prediction engine.
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this._url)
      this._ws = ws
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', join: { matchId: '' } }))
      ws.onerror = () => reject(new Error('websocket error'))
      ws.onclose = () => this.emit('disconnect', null)
      ws.onmessage = (evt) => {
        let msg
        try { msg = JSON.parse(evt.data) } catch { return }
        this._onServerMessage(msg, resolve)
      }
    })
  }

  // _onServerMessage runs the join handshake and, once the local engine is
  // live, dispatches each message.  Command/hash/snapshot frames that arrive
  // while the wasm engine is still loading are buffered and flushed in arrival
  // order, so a join_accept immediately followed by a snapshot never races.
  async _onServerMessage(msg, onJoined) {
    if (msg.type === 'join_accept') {
      const a = msg.joinAccept
      this._local = new WasmFrameSource({
        seed: a.seed,
        inputDelay: a.inputDelay,
        spawnResolver: (name) => this._metas[name] || null,
      })
      await this._local.ready()
      if (a.tickRate) { this._baseTickMs = 1000 / a.tickRate; this._tickMs = this._baseTickMs / this._rate }
      this._joined = true
      // A join above tick 0 is mid-game: hold stepping until the snapshot has
      // restored the live unit set (and its metas) so the replayed command
      // frames execute against the authority's world, not an empty one.
      this._needsRestore = (a.tick || 0) > 0
      this._restored = !this._needsRestore
      this._noteServerTick(a.tick || 0)
      this.emit('join', a)
      const queued = this._backlog
      this._backlog = []
      for (const m of queued) this._dispatch(m)
      if (onJoined) onJoined(a)
      return
    }
    if (!this._joined) {
      this._backlog.push(msg)
      return
    }
    this._dispatch(msg)
  }

  _dispatch(msg) {
    switch (msg.type) {
      case 'command': {
        const frame = msg.command
        for (const order of frame.orders || []) {
          // A Spawn (Kind 5) for a type this client never registered would
          // resolve to a nil meta and be dropped; fetch+register it and hold the
          // step barrier at its exec tick until the meta lands.
          if (order.Kind === 5 && order.Name) this._ensureSpawnMeta(order.Name, frame.tick)
          this._local.scheduleAt(frame.tick, order)
        }
        break
      }
      case 'hash':
        this._serverHashes.set(msg.hash.tick, String(msg.hash.hash))
        this._noteServerTick(msg.hash.tick)
        break
      case 'control': {
        // Authority's shared-clock state. Adopt paused / rate, re-pace the tick
        // period, and anchor serverTick to the tick the control reports so a
        // pause or single-step lands every client on the same authoritative
        // tick rather than wherever each had predicted to.
        const ctl = msg.control || {}
        this._paused = !!ctl.paused
        if (ctl.rate) { this._rate = ctl.rate; this._tickMs = this._baseTickMs / this._rate }
        if (typeof ctl.tick === 'number') this._noteServerTick(ctl.tick)
        this.emit('control', { paused: this._paused, rate: this._rate, tick: this._srvTick })
        break
      }
      case 'snapshot':
        this._noteServerTick(msg.snapshot.tick)
        // Seed the local prediction engine from the authority once, on join, so
        // a client entering a match in progress sees the live unit set. The
        // restore carries unit motion, standing weapon orders + their reload
        // clocks, and every in-flight projectile, so a late joiner re-engages on
        // the authority's fire cadence and its missiles land in lockstep; only a
        // unit's exact mid-animation piece pose is re-derived (Create/StartMoving
        // replay) rather than transferred. Restore also clears scheduled orders,
        // so later periodic snapshots are not blindly replayed — the command
        // stream and hash checks maintain lockstep from here. (Full mid-game
        // resync after a confirmed desync is a follow-up.)
        if (!this._seeded) {
          this._seeded = true
          if (this._needsRestore) {
            // Mid-game: hydrate every restored type's meta first (so units come
            // back with COB bindings), then restore and lift the step gate.
            this._seedFromSnapshot(msg.snapshot)
          } else {
            // Fresh join: the world is empty at tick 0, so restore synchronously
            // before any step and skip the (no-op) meta hydration.
            this._local.restore(msg.snapshot)
          }
        }
        this.emit('snapshot', msg.snapshot)
        break
    }
  }

  // _seedFromSnapshot hydrates the meta for every unit type the snapshot names,
  // then restores the local world and lifts the mid-game step gate. Running
  // before restore guarantees World.Restore re-resolves each unit through a
  // populated meta map, so restored units regain their COB bindings instead of
  // coming back script-less.
  async _seedFromSnapshot(snapshot) {
    const names = new Set()
    for (const u of snapshot.units || []) if (u.name) names.add(u.name)
    if (this._metaProvider) {
      await Promise.all([...names].map(async (name) => {
        if (this.hasMeta(name)) return
        try {
          const meta = await this._metaProvider(name)
          if (meta) this.registerMeta(name, meta)
        } catch { /* asset miss — unit restores script-less */ }
      }))
    }
    this._local.restore(snapshot)
    this._restored = true
  }

  // _ensureSpawnMeta fetches+registers a unit type seen in the command stream
  // that this client never spawned itself, and raises the step barrier to the
  // Spawn's exec tick so step() cannot run that tick (and silently drop the
  // unspawnable order) before the meta is registered.
  _ensureSpawnMeta(name, execTick) {
    if (this.hasMeta(name) || !this._metaProvider) return
    this._spawnBarrier = Math.min(this._spawnBarrier, execTick)
    if (this._metaInflight.has(name)) return
    this._metaInflight.add(name)
    Promise.resolve(this._metaProvider(name))
      .then((meta) => { if (meta) this.registerMeta(name, meta) })
      .catch(() => { /* asset miss — Spawn will no-op, but don't wedge the barrier */ })
      .then(() => {
        this._metaInflight.delete(name)
        if (this._metaInflight.size === 0) this._spawnBarrier = Infinity
      })
  }

  // Orders are not applied locally; they are sent to the authority, which
  // stamps an execution tick and broadcasts a command frame the local engine
  // applies in lockstep with every other client.
  move(unitIds, x, z) {
    this._send({ Kind: 1, UnitIDs: unitIds, Target: { X: toFixed(x), Z: toFixed(z) } })
  }

  attack(unitIds, targetId) {
    this._send({ Kind: 2, UnitIDs: unitIds, TargetUnit: targetId >>> 0 })
  }

  // fire force-fires one unit's weapon slot (Kind 4). A nonzero targetUnit aims
  // at that unit; otherwise the slot fires at the ground point (px, pz). Like
  // every order it round-trips through the authority before any client applies
  // it, so force-fire stays in lockstep with the rest of the command stream.
  fire(unitId, slot, targetUnit = 0, px = 0, pz = 0) {
    const order = { Kind: 4, UnitID: unitId >>> 0, Slot: slot | 0 }
    if (targetUnit) {
      order.HasTargetUnit = true
      order.TargetUnit = targetUnit >>> 0
    } else {
      order.HasTargetUnit = false
      order.Target = { X: toFixed(px), Z: toFixed(pz) }
    }
    this._send(order)
  }

  stop(unitIds) {
    this._send({ Kind: 3, UnitIDs: unitIds })
  }

  // spawn requests a new unit by type name at a world point. Like every order
  // it round-trips through the authority, which stamps an execution tick and
  // broadcasts a command frame; the unit then materializes on every client at
  // the same tick with the same id, resolved through each client's meta map.
  spawn({ name, x, z, heading = 0, side = 0 }) {
    this._send({ Kind: 5, Name: name, SpawnAt: { X: toFixed(x), Z: toFixed(z) }, Heading: heading, Side: side })
  }

  _send(order) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'order', order }))
    }
  }

  // ── Shared-clock control ──────────────────────────────────────────
  //
  // Runtime Pause / Step / Speed in a joined sandbox are authoritative: the
  // request round-trips through the host, which applies it to the one shared
  // simulation clock and echoes the new state to every client. The client does
  // not freeze/step its own prediction directly — it follows the authority's
  // serverTick, which these commands move.

  setPaused(paused) { this._sendControl({ action: paused ? 'pause' : 'resume' }) }
  stepOnce() { this._sendControl({ action: 'step' }) }
  setRate(rate) {
    const n = Number(rate)
    this._sendControl({ action: 'rate', rate: Number.isFinite(n) ? n : 1 })
  }

  _sendControl(control) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'control', control }))
    }
  }

  // step advances the local prediction engine one tick and verifies any
  // authoritative hash the server has reported for the tick just produced.
  step() {
    if (!this._local) return { tick: this.tick, units: [], projos: [], events: [] }
    // Stall (return null) rather than advance when a mid-game join is still
    // awaiting its snapshot restore, or when the next tick would run a Spawn
    // whose type meta is still being fetched. The scene treats null as "no step
    // this frame" and retries, so the local engine resumes — and catches up —
    // the moment the gate clears, with every order still at its stamped tick.
    if (!this._restored) return null
    if (this.tick + 1 >= this._spawnBarrier) return null
    const snap = this._local.step()
    this.tick = snap.tick
    const expected = this._serverHashes.get(snap.tick)
    if (expected !== undefined) {
      this._serverHashes.delete(snap.tick)
      const got = this._local.hash()
      if (got !== expected) {
        this.emit('desync', { tick: snap.tick, local: got, authority: expected })
      }
    }
    this._fanOutEvents(snap)
    return snap
  }

  // hash exposes the local prediction engine's world hash so callers can show
  // it alongside the authoritative value. Returns null before the engine seeds.
  hash() { return this._local ? this._local.hash() : null }

  // cobState exposes the local prediction engine's COB inspection snapshot so
  // the inspector panels show live script state in join mode too. Empty until
  // the prediction engine has seeded.
  cobState() { return this._local ? this._local.cobState() : { tick: 0, units: [] } }

  get joined() { return this._joined }

  dispose() {
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
    if (this._local) {
      this._local.dispose()
      this._local = null
    }
  }
}
