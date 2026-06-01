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
    this._tickMs = 1000 / 40 // server tick period; refined from join_accept
    this._srvTick = 0       // newest authoritative tick observed
    this._srvWall = 0       // wall-clock (ms) when _srvTick was observed
  }

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
    return this._srvTick + Math.floor((this._now() - this._srvWall) / this._tickMs)
  }

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
      if (a.tickRate) this._tickMs = 1000 / a.tickRate
      this._joined = true
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
          this._local.scheduleAt(frame.tick, order)
        }
        break
      }
      case 'hash':
        this._serverHashes.set(msg.hash.tick, String(msg.hash.hash))
        this._noteServerTick(msg.hash.tick)
        break
      case 'snapshot':
        this._noteServerTick(msg.snapshot.tick)
        // Seed the local prediction engine from the authority once, on join, so
        // a client entering a match in progress sees the live unit set. Restore
        // is lossy for units caught mid-action (see file header) and clears
        // scheduled orders, so later periodic snapshots are not blindly
        // replayed — the command stream and hash checks maintain lockstep from
        // here. (Full mid-game resync after a confirmed desync is a follow-up.)
        if (!this._seeded) {
          this._local.restore(msg.snapshot)
          this._seeded = true
        }
        this.emit('snapshot', msg.snapshot)
        break
    }
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

  // step advances the local prediction engine one tick and verifies any
  // authoritative hash the server has reported for the tick just produced.
  step() {
    if (!this._local) return { tick: this.tick, units: [], projos: [], events: [] }
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
