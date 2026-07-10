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
import { TA_TICK_HZ, TA_TICK_MS } from '../tick-rate.js'

const FRAC = 65536 // Q16.16 — world float -> fixed-point for the wire.

// Beyond this long without a verified-matching authoritative hash, the client
// is treated as severely out of sync and the panel raises its warning. The
// authority emits a hash every 8 ticks (~267ms at 30Hz), so a multi-second gap
// means hash verification has stopped landing — a real divergence or stall.
const SEVERE_DESYNC_MS = 2000

// Bandwidth history granularity + span. One bucket per second, 5 minutes deep,
// so the panel's in/out graphs plot 300 samples of per-second throughput.
const BW_SAMPLE_MS = 1000
const BW_WINDOW_MS = 5 * 60 * 1000
const BW_MAX_SAMPLES = Math.round(BW_WINDOW_MS / BW_SAMPLE_MS)

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
    this._baseTickMs = TA_TICK_MS // server's real-time tick period at rate 1 (overridden by join_accept tickRate)
    this._tickMs = TA_TICK_MS // current tick period = baseTickMs / rate
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
    // Network/sync telemetry for the developer panel. Byte counts are the
    // serialized JSON length (close enough to wire size for a dev gauge).
    this._bytesSent = 0
    this._bytesRecv = 0
    this._msgsSent = 0
    this._msgsRecv = 0
    // Latency probe state. The ping loop sends one ping, waits for its pong,
    // then waits a further second before the next — a self-paced cadence, not a
    // fixed-rate interval, so a stalled link never piles up unanswered pings.
    this._pingSeq = 0
    this._pingInFlight = 0   // seq of the outstanding ping, 0 when idle
    this._pingSentAt = 0     // _now() when the outstanding ping was sent
    this._pingTimer = null   // doubles as the in-flight timeout and inter-ping delay
    this._latencyMs = 0      // last measured round-trip, ms
    // Server-clock estimate, anchored at each pong and extrapolated on the wall
    // clock between pongs so the panel can show a live server time.
    this._srvClockMs = 0
    this._srvClockWall = 0
    // Sync tracking. _lastSyncTick marks the most recent tick whose local hash
    // matched the authority; _lastDesyncTick marks the most recent mismatch. The
    // panel reports the gap as a tick delta (current tick − _lastSyncTick), so a
    // paused game shows a frozen "ticks ago" rather than an ever-growing wall
    // age. A desync newer than the last good sync (or a stale sync) trips the
    // warning.
    this._lastSyncTick = 0
    this._lastDesyncTick = 0
    // Latest authoritative hash observed, for side-by-side display with the
    // local hash (kept even after the per-tick verification entry is consumed).
    this._lastServerHash = null
    this._lastServerHashTick = 0
    // Force-Sync latch: set when the user requests a re-pull so the next
    // snapshot re-seeds the local world even though it was already seeded.
    this._forceResync = false
    // Diagnose: a pending {resolve,reject,timer} for an in-flight read-only
    // server-snapshot request the Network panel's Diagnose button raised. The
    // server answers with a snapshot flagged `diagnostic`, which the dispatcher
    // routes here instead of re-seeding the local world.
    this._diagPending = null
    // Bandwidth history: one bucket per BW_SAMPLE_MS of bytes sent/received,
    // capped at BW_WINDOW_MS worth (the panel plots the last 5 minutes). A timer
    // started on join snapshots the cumulative counters each interval and pushes
    // the delta so the graph shows per-interval throughput, not running totals.
    this._bwSamples = []
    this._bwLastSent = 0
    this._bwLastRecv = 0
    this._bwTimer = null
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
      ws.onopen = () => this._wsSend({ type: 'join', join: { matchId: '' } })
      ws.onerror = () => reject(new Error('websocket error'))
      ws.onclose = () => this.emit('disconnect', null)
      ws.onmessage = (evt) => {
        this._bytesRecv += (evt.data && evt.data.length) || 0
        this._msgsRecv += 1
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
      this._startPingLoop()
      this._startBandwidthSampler()
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
          // Spawn (5) materializes at the frame's tick; Build (7) spawns its
          // buildee later, when the builder reaches the site — register the
          // meta now so that deferred spawn resolves on this replica too.
          if ((order.Kind === 5 || order.Kind === 7) && order.Name) this._ensureSpawnMeta(order.Name, frame.tick)
          this._local.scheduleAt(frame.tick, order)
        }
        break
      }
      case 'hash':
        this._serverHashes.set(msg.hash.tick, String(msg.hash.hash))
        this._lastServerHash = String(msg.hash.hash)
        this._lastServerHashTick = msg.hash.tick
        this._noteServerTick(msg.hash.tick)
        break
      case 'pong': {
        // Match the answer to the outstanding probe; ignore a stale/duplicate
        // pong whose sequence we already retired on timeout.
        const p = msg.pong || {}
        if (p.seq === this._pingInFlight) {
          this._latencyMs = this._now() - this._pingSentAt
          // Estimate the server clock at receive time: its stamped wall time
          // plus the half-RTT the pong spent travelling back to us.
          this._srvClockMs = (p.serverTime || 0) + this._latencyMs / 2
          this._srvClockWall = this._now()
          this._completePing(p.seq)
        }
        break
      }
      case 'control': {
        // Authority's shared-clock state. Adopt paused / rate, re-pace the tick
        // period, and anchor serverTick to the tick the control reports so a
        // pause or single-step lands every client on the same authoritative
        // tick rather than wherever each had predicted to.
        const ctl = msg.control || {}
        this._paused = !!ctl.paused
        if (ctl.rate) { this._rate = ctl.rate; this._tickMs = this._baseTickMs / this._rate }
        if (typeof ctl.tick === 'number') {
          this._noteServerTick(ctl.tick)
          // Wall-clock extrapolation can race a pause: the client may have
          // already stepped its local engine one tick past where the authority
          // actually froze, so two windows disagree by 1. When a pause lands and
          // we have predicted past the authoritative tick, re-pull the snapshot
          // to roll the local world back to the exact paused tick — every window
          // then converges on the same state. (Deterministic replay means a
          // behind/at-tick client needs no rollback; only an ahead one does.)
          if (this._paused && this._restored && this.tick > ctl.tick) {
            this.forceSync()
          }
        }
        this.emit('control', { paused: this._paused, rate: this._rate, tick: this._srvTick })
        break
      }
      case 'snapshot':
        // A diagnostic snapshot is a read-only Diagnose reply: do NOT re-seed
        // the local world from it. Resolve the pending request with the server
        // state paired against the client's own export for a field-by-field diff.
        if (msg.snapshot && msg.snapshot.diagnostic) {
          this._resolveDiagnose(msg.snapshot)
          break
        }
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
        if (!this._seeded || this._forceResync) {
          this._seeded = true
          const force = this._forceResync
          this._forceResync = false
          if (this._needsRestore || force) {
            // Mid-game (or a Force-Sync re-pull): hydrate every restored type's
            // meta first (so units come back with COB bindings), then restore
            // and lift the step gate. A re-pull's snapshot is always full state,
            // so the local world adopts the authority's exact poses again.
            this._seedFromSnapshot(msg.snapshot)
          } else {
            // Fresh join: the world is empty at tick 0, so restore synchronously
            // before any step and skip the (no-op) meta hydration.
            this._local.restore(msg.snapshot)
            this.tick = msg.snapshot.tick | 0
            this.emit('restored', { tick: this.tick })
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
    this.tick = snapshot.tick | 0
    this._restored = true
    // Let the scene paint the restored unit set now (it adopts render adapters
    // only while stepping, which never happens on a paused join), and align the
    // public tick to the authority so the catch-up loop does not overshoot by 1.
    this.emit('restored', { tick: this.tick })
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
  // queued (the shift-click gesture) appends the order to each unit's queue on
  // the authority instead of replacing its current orders.
  move(unitIds, x, z, queued = false) {
    this._send({ Kind: 1, UnitIDs: unitIds, Target: { X: toFixed(x), Z: toFixed(z) }, Queued: !!queued })
  }

  attack(unitIds, targetId, queued = false) {
    this._send({ Kind: 2, UnitIDs: unitIds, TargetUnit: targetId >>> 0, Queued: !!queued })
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

  // build sends one mobile builder to construct unit type `name` at a ground
  // point (Kind 7). The buildee spawns sim-side when the builder reaches the
  // site; the meta registers via the command-frame hook on every client.
  build(builderId, name, x, z, queued = false, headingRad = 0) {
    // Heading is the buildee's facing as a TA-angle (65536 = full turn), to
    // match the authoritative sim's order.Heading.
    const heading = Math.round((headingRad / (2 * Math.PI)) * 65536) | 0
    this._send({ Kind: 7, UnitID: builderId >>> 0, Name: name, Target: { X: toFixed(x), Z: toFixed(z) }, Queued: !!queued, Heading: heading })
  }

  // canBuildAt has no cheap authoritative answer over the wire, so the hosted
  // client leaves the build ghost neutral (always buildable); the server still
  // refuses an illegal site when the order arrives.
  canBuildAt() { return true }

  // repair resumes an existing under-construction frame (Build with a
  // TargetUnit instead of a site).
  repair(builderId, targetId) {
    this._send({ Kind: 7, UnitID: builderId >>> 0, TargetUnit: targetId >>> 0 })
  }

  // patrol appends a patrol waypoint (Kind 8); stance sets the standing
  // move/fire orders (Kind 9).
  patrol(unitIds, x, z) {
    this._send({ Kind: 8, UnitIDs: unitIds, Target: { X: toFixed(x), Z: toFixed(z) } })
  }

  stance(unitIds, moveMode, fireMode) {
    this._send({ Kind: 9, UnitIDs: unitIds, MoveMode: moveMode | 0, FireMode: fireMode | 0 })
  }

  // selfDestruct toggles the units' 5-second fuses (Kind 10).
  selfDestruct(unitIds) {
    this._send({ Kind: 10, UnitIDs: unitIds })
  }

  // load sends transports to pick up a unit (Kind 11); unload sets their
  // cargo down at a ground point (Kind 12).
  load(transportIds, targetUnit) {
    this._send({ Kind: 11, UnitIDs: transportIds, TargetUnit: targetUnit >>> 0 })
  }

  unload(transportIds, x, z) {
    this._send({ Kind: 12, UnitIDs: transportIds, Target: { X: toFixed(x), Z: toFixed(z) } })
  }

  // spawn requests a new unit by type name at a world point. Like every order
  // it round-trips through the authority, which stamps an execution tick and
  // broadcasts a command frame; the unit then materializes on every client at
  // the same tick with the same id, resolved through each client's meta map.
  spawn({ name, x, z, heading = 0, side = 0 }) {
    this._send({ Kind: 5, Name: name, SpawnAt: { X: toFixed(x), Z: toFixed(z) }, Heading: heading, Side: side })
  }

  _send(order) {
    this._wsSend({ type: 'order', order })
  }

  // _wsSend serializes and sends one client message, tallying it into the
  // bytes/messages-sent telemetry. Returns false (and sends nothing) when the
  // socket is not open, so callers degrade gracefully on a dropped link.
  _wsSend(obj) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false
    const data = JSON.stringify(obj)
    this._ws.send(data)
    this._bytesSent += data.length
    this._msgsSent += 1
    return true
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
    this._wsSend({ type: 'control', control })
  }

  // ── Latency probe ─────────────────────────────────────────────────
  //
  // The loop is self-paced: send one ping, await its pong (or a timeout), then
  // wait a full second before the next send. _pingTimer holds whichever delay
  // is live — the in-flight timeout while a ping is outstanding, the one-second
  // gap between completions otherwise — since the two never overlap.

  _startPingLoop() {
    if (this._pingTimer || this._pingInFlight) return
    this._sendPing()
  }

  _sendPing() {
    this._pingTimer = null
    if (!this._wsSend({ type: 'ping', ping: { seq: this._pingSeq + 1 } })) {
      // Socket closed; stop probing until a fresh connect restarts the loop.
      this._pingInFlight = 0
      return
    }
    this._pingSeq += 1
    this._pingInFlight = this._pingSeq
    this._pingSentAt = this._now()
    // Give up on a silent link after 5s and resume the cadence so a transient
    // stall does not wedge the loop permanently.
    this._pingTimer = setTimeout(() => this._completePing(this._pingInFlight), 5000)
  }

  // _completePing retires the outstanding probe (answered or timed out) and
  // schedules the next ping one second later, giving the requested gap between
  // completions rather than a fixed send rate.
  _completePing(seq) {
    if (seq !== this._pingInFlight || this._pingInFlight === 0) return
    this._pingInFlight = 0
    if (this._pingTimer) { clearTimeout(this._pingTimer); this._pingTimer = null }
    this._pingTimer = setTimeout(() => this._sendPing(), 1000)
  }

  // forceSync asks the authority to re-push a full snapshot, then stalls local
  // stepping until it lands. The restore discards the client's locally diverged
  // (and any pending) work and re-seeds from authority, and the warning clears
  // since we are deliberately re-pulling the canonical state.
  forceSync() {
    if (!this._joined) return
    if (!this._wsSend({ type: 'resync' })) return
    this._forceResync = true
    this._restored = false
    this._lastDesyncTick = 0
  }

  // diagnose asks the authority for a read-only full snapshot and resolves with
  // both sides' state so the Network panel can diff them field-by-field. Unlike
  // forceSync the local world is NOT re-seeded — prediction keeps running. The
  // client export is captured at request time (the closest local tick to the
  // server's reply); the panel surfaces both ticks so the lead is visible.
  // Rejects if not joined, the send fails, or no reply arrives within 5s.
  diagnose() {
    return new Promise((resolve, reject) => {
      if (!this._joined) { reject(new Error('not joined')); return }
      // Only one in-flight request; a second supersedes the first.
      if (this._diagPending) {
        clearTimeout(this._diagPending.timer)
        this._diagPending.reject(new Error('superseded'))
        this._diagPending = null
      }
      if (!this._wsSend({ type: 'diagnose' })) { reject(new Error('socket closed')); return }
      const timer = setTimeout(() => {
        const p = this._diagPending
        this._diagPending = null
        if (p) p.reject(new Error('diagnose timed out'))
      }, 5000)
      this._diagPending = { resolve, reject, timer }
    })
  }

  // _resolveDiagnose pairs the server's diagnostic snapshot with the local
  // engine's own export (same wire shape, raw fixed-point) and hands both to the
  // waiting diagnose() promise.
  _resolveDiagnose(serverSnap) {
    const p = this._diagPending
    if (!p) return
    clearTimeout(p.timer)
    this._diagPending = null
    const clientSnap = this._local ? this._local.exportSnapshot() : null
    p.resolve({ server: serverSnap, client: clientSnap })
  }

  // ── Bandwidth history ─────────────────────────────────────────────
  //
  // A once-a-second timer snapshots the cumulative byte counters and records the
  // delta since the previous tick, so the panel's graphs plot per-second
  // throughput over a rolling 5-minute window rather than ever-growing totals.

  _startBandwidthSampler() {
    if (this._bwTimer) return
    this._bwLastSent = this._bytesSent
    this._bwLastRecv = this._bytesRecv
    this._bwTimer = setInterval(() => this._sampleBandwidth(), BW_SAMPLE_MS)
  }

  _sampleBandwidth() {
    const sent = this._bytesSent - this._bwLastSent
    const recv = this._bytesRecv - this._bwLastRecv
    this._bwLastSent = this._bytesSent
    this._bwLastRecv = this._bytesRecv
    this._bwSamples.push({ t: Date.now(), sent: Math.max(0, sent), recv: Math.max(0, recv) })
    if (this._bwSamples.length > BW_MAX_SAMPLES) {
      this._bwSamples.splice(0, this._bwSamples.length - BW_MAX_SAMPLES)
    }
  }

  // netStats returns a plain snapshot of the network/sync telemetry for the
  // developer panel: the authoritative serverTick alongside the local clientTick
  // (they differ by the client's prediction lead, and pausing reveals it), live
  // hashes, estimated server clock, last latency, cumulative byte/message
  // counts, and how many ticks since the last verified sync (converted to
  // seconds via the tick rate, so a paused game shows a frozen age rather than
  // an ever-growing wall-clock gap). A severe flag the panel surfaces as a
  // warning trips on a confirmed desync or a stale sync.
  netStats() {
    const now = this._now()
    const serverTimeMs = this._srvClockWall
      ? Math.round(this._srvClockMs + (now - this._srvClockWall))
      : 0
    const tickHz = this._baseTickMs > 0 ? 1000 / this._baseTickMs : TA_TICK_HZ
    const haveSync = this._lastSyncTick > 0
    const lastSyncTicksAgo = haveSync ? Math.max(0, (this.tick | 0) - this._lastSyncTick) : null
    const lastSyncAgoSec = lastSyncTicksAgo === null ? null : lastSyncTicksAgo / tickHz
    const hadDesync = this._lastDesyncTick > this._lastSyncTick
    const severeTicks = this._baseTickMs > 0 ? SEVERE_DESYNC_MS / this._baseTickMs : SEVERE_DESYNC_MS / TA_TICK_MS
    const stale = lastSyncTicksAgo !== null && lastSyncTicksAgo > severeTicks
    return {
      joined: this._joined,
      serverTick: this.serverTick,
      clientTick: this.tick,
      hash: this.hash(),
      serverHash: this._lastServerHash,
      serverHashTick: this._lastServerHashTick,
      serverTimeMs,
      latencyMs: this._latencyMs > 0 ? Math.round(this._latencyMs) : null,
      bytesSent: this._bytesSent,
      bytesRecv: this._bytesRecv,
      msgsSent: this._msgsSent,
      msgsRecv: this._msgsRecv,
      lastSyncTick: this._lastSyncTick || null,
      lastSyncTicksAgo,
      lastSyncAgoSec,
      severeDesync: hadDesync || stale,
      diagnosing: !!this._diagPending,
      bandwidth: {
        intervalMs: BW_SAMPLE_MS,
        windowMs: BW_WINDOW_MS,
        samples: this._bwSamples,
      },
    }
  }

  // renderState returns the local prediction engine's render snapshot at its
  // current tick without advancing it, for painting the unit set right after a
  // restore (a paused join never steps, so this is the only way its units reach
  // the scene). Null before the engine seeds.
  renderState() { return this._local ? this._local.renderState() : null }

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
        this._lastDesyncTick = snap.tick
        this.emit('desync', { tick: snap.tick, local: got, authority: expected })
      } else {
        // Verified in lockstep with the authority at this tick; mark the sync so
        // the panel can report how many ticks ago the client was last known-good.
        this._lastSyncTick = snap.tick
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
    if (this._pingTimer) { clearTimeout(this._pingTimer); this._pingTimer = null }
    if (this._bwTimer) { clearInterval(this._bwTimer); this._bwTimer = null }
    if (this._diagPending) {
      clearTimeout(this._diagPending.timer)
      this._diagPending.reject(new Error('disposed'))
      this._diagPending = null
    }
    this._pingInFlight = 0
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
