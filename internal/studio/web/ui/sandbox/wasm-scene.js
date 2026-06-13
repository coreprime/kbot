// wasm-scene.js
//
// Snapshot-driven sandbox scene.  Drop-in replacement for SandboxScene /
// GameEngine: instead of running the simulation in JavaScript it drives the
// deterministic Go engine (compiled to WebAssembly) through a WasmFrameSource
// and renders whatever the per-tick render snapshot reports.  The same Go
// simulation runs here as on the authoritative match server, which is what
// lets the offline sandbox and a remote-joined match share one code path.
//
// Responsibilities mirror the old SandboxScene so SandboxView's call sites
// don't change shape:
//
//   - Own the FrameSource (per-tab — one isolated wasm world per tab).
//   - Hold selection state (a VIEW concern, not a sim one).
//   - Translate snapshot events (fire / death / move-stop / explode / …) into
//     the renderer-side particle, audio and projectile visuals exactly once
//     per event regardless of how many panes observe the scene.
//   - Adapt each simulated unit into a plain object shaped like the legacy
//     GameEngine unit (pos / heading / model clone / binding) so the view's
//     entity builder, selection and command paths keep working unchanged.
//
// Commands (move / attack / stop) submit orders to the wasm session; the
// resulting motion comes back through the next snapshot rather than by mutating
// unit fields directly.

import { WasmFrameSource } from '../../engine/net/wasm-source.js'
import { withCobBytes } from '../../engine/net/cob-bytes.js'
import { activeGame } from '../common/game-registry.js'
import { gatherSceneLights } from '../../engine/scene-lights.js'
import { AudioPool } from '@kbot/game3d/audio-pool'
import { ParticlePool } from '../../engine/cob-particles.js'
import {
  SmokeTrailManager,
  spawnProjectile,
  spawnProjectileInFlight,
  playWeaponSound,
  SFX_FIRE_FLASH,
  SFX_SMOKE_WHITE,
} from '@kbot/game3d/weapon-driver'

// One simulation tick in milliseconds (40 Hz), matching the Go engine's
// sim.TickMs.  The scene advances the wasm world on this fixed grid; the
// renderer's variable wall-clock dt only drives the accumulator + particle
// ageing, never the deterministic step count.
const TICK_MS = 25

// Cap the catch-up burst so a long stall (tab backgrounded, GC pause) doesn't
// run hundreds of sim steps in one frame and freeze the UI — drop the surplus
// time instead, the same coalesce a fixed-timestep game loop uses.
const MAX_STEPS_PER_FRAME = 8

// In join mode the host owns sim time and the local prediction must track its
// clock, not free-run on wall-clock.  A wall-clock accumulator capped at
// MAX_STEPS_PER_FRAME can never close a gap once one opens (join-restore
// latency, a GC pause, a briefly backgrounded tab whose rAF was throttled): it
// only ever adds one frame's worth of time, so the prediction stalls behind
// authority and the rendered poses freeze.  Instead we chase serverTick with a
// generous per-frame burst.  A single wasm step is cheap, so a few hundred fit
// in a frame budget; a very large gap drains over several frames, keeping the
// UI responsive.  Stepping only up to (never past) serverTick is safe because
// every order is stamped for serverTick + inputDelay + 1, so the local engine
// never runs ahead of an order it has already been told about.
const MAX_CATCHUP_STEPS = 600

// COB TA-angle (65536 per turn) to radians.
const ANGLE_TO_RAD = (2 * Math.PI) / 65536

// Seconds over which a freshly-launched projectile's frozen muzzle offset
// decays to zero. The sim spawns every shot from the unit origin (it has no
// geometry); we displace the rendered mesh to the real firing piece at launch
// and ease it back onto the authoritative trajectory so the shot still detonates
// where the sim says it does.
const MUZZLE_DECAY_SEC = 0.3

// A single-tick positional delta larger than this (world units) is treated as
// a teleport (respawn / restore / map wrap) rather than continuous motion, so
// render interpolation snaps to it instead of sliding the unit across the map.
// Even the fastest aircraft travel only a few tens of WU per 25 ms tick, so
// this comfortably clears legitimate motion.
const INTERP_SNAP_WU = 256

// Per-(unit, eventKey) sound debounce window, ms — see playUnitSound.
const UNIT_SOUND_DEBOUNCE_MS = 80

// WasmUnit adapts one simulated unit into the shape SandboxView reads.  Motion
// state (pos / heading / health / …) is refreshed from each snapshot; the
// model clone holds the per-unit animated piece tree the snapshot writes into.
//
// moveTarget / attackTarget are accessor properties: the view assigns them as
// "issue this order" hints (the legacy GameEngine acted on the mutation), so
// here the setters translate the assignment into an authoritative order on the
// session.  The stored value also backs the view's order-line overlay.
class WasmUnit {
  constructor(scene, id, name, side) {
    this._scene = scene
    this.id = id
    this.name = name
    this.side = side | 0
    this.model = null      // per-unit clone; snapshot pieces written here
    this.meta = null       // FBI + weapon metadata (weapon driver / sounds)
    this.cobUnit = null    // COB runs server-side now; kept for shape parity
    // cobPorts mirrors the unit-value surface the Controls panel edits.
    // moveOrders/fireOrders are live: reads reflect the sim's standing
    // orders (synced from every snapshot), writes dispatch a Stance order
    // so the change is authoritative and stays in lockstep.
    this._stance = { move: 1, fire: 2 }
    const self = this
    this.cobPorts = {
      get moveOrders() { return self._stance.move },
      set moveOrders(v) { self._scene.source.stance([self.id], v | 0, self._stance.fire) },
      get fireOrders() { return self._stance.fire },
      set fireOrders(v) { self._scene.source.stance([self.id], self._stance.move, v | 0) },
    }
    this._cobPieceNames = []
    this.pos = { x: 0, y: 0, z: 0 }
    this.heading = 0       // radians
    // Render-interpolation endpoints.  The sim ticks at 40 Hz but the renderer
    // paints on rAF (~60+ Hz), so reading the raw tick position straight into
    // pos makes the unit hold still between ticks and then jump — visible
    // stutter, worst when the camera tracks a fast aircraft.  Each tick shifts
    // the previous state into _p0 and the new one into _p1; the scene then
    // lerps pos/heading between them every frame by the leftover-timestep
    // fraction (see _applyInterpolation).  Seeded so a freshly-spawned unit
    // doesn't slide in from the origin.
    this._p0 = { x: 0, y: 0, z: 0, h: 0 }
    this._p1 = { x: 0, y: 0, z: 0, h: 0 }
    this.isMoving = false
    this.speed = 0       // world-units/s from the snapshot, for the Movement panel
    this.dead = false
    this.health = 100
    this.buildPercent = 100
    this.weaponSlots = null // wasm snapshot carries no per-slot aim state
    this._moveTarget = null
    this._attackTarget = null
    this.queue = [] // shift-queued follow-ups from the snapshot (waypoint overlay)
    this.binding = null
  }

  get moveTarget() { return this._moveTarget }
  set moveTarget(v) {
    this._moveTarget = v
    if (!v) return
    // A move order cancels a standing attack the way TA does — the sim has no
    // "clear attack only" order, so stop first (drops the attack + weapon
    // slots) then issue the move.
    if (this._attackTarget || this.weaponSlots) {
      this._scene.source.stop([this.id])
      this._attackTarget = null
      this.weaponSlots = null
    }
    this._scene.source.move([this.id], v.x, v.z)
  }

  get attackTarget() { return this._attackTarget }
  set attackTarget(v) {
    this._attackTarget = v
    // A standing attack supersedes any manual force-fire aim, so drop the
    // per-slot hint that the shift overlay would otherwise double up on.
    if (v) {
      this.weaponSlots = null
      this._scene.source.attack([this.id], v.id)
    }
  }

  // queueMove / queueAttack append to the unit's sim-side order queue (the
  // shift-click gesture). Unlike the setters above they neither stop the unit
  // nor clear standing orders — the queued order runs when the current one
  // completes. The queue itself comes back on each snapshot (this.queue) for
  // the waypoint overlay.
  queueMove(v) {
    if (!v) return
    this._scene.source.move([this.id], v.x, v.z, true)
  }

  queueAttack(t) {
    if (!t) return
    this._scene.source.attack([this.id], t.id, true)
  }
}

export class WasmSandboxScene {
  // Two transports back the scene:
  //   - local (default): an in-process WasmFrameSource; addUnit inserts directly
  //     and returns an id synchronously.
  //   - join: a caller-supplied WsFrameSource (`source` option) wired to an
  //     authoritative host. Units are never inserted locally — they arrive in
  //     the authority's snapshots and the scene adopts an adapter for each new
  //     id (model + meta hydrated lazily via `modelResolver`). Spawning routes
  //     through spawnRemote, which round-trips a Spawn order through the host.
  constructor({ palette = null, seed = 1, source = null, modelResolver = null } = {}) {
    this.palette = palette
    // Factory mirrors SandboxScene: the engine package never imports a concrete
    // audio implementation, keeping the cross-package direction one-way.
    this._audioFactory = () => new AudioPool()
    // Join mode when a transport is injected; otherwise own an isolated wasm world.
    this._join = !!source
    this._modelResolver = modelResolver
    // Synchronous meta cache backing the local engine's spawn resolver: a
    // Build order spawns its buildee sim-side when the builder reaches the
    // site, so the type's meta must already be registered (scene.build()
    // pre-fetches it). Join mode resolves through the transport instead.
    this._spawnMetas = new Map()
    this.source = source || new WasmFrameSource({
      seed: seed >>> 0,
      inputDelay: 0,
      spawnResolver: (name) => this._spawnMetas.get(name) || null,
    })
    // In join mode, let the transport hydrate any unit type it sees in the
    // command stream or a join snapshot but that this client never spawned
    // itself — otherwise the authority's Spawn would resolve to a nil meta and
    // be dropped, leaving the observer with no unit. The provider returns the
    // FBI/weapon meta with COB bytes attached so restored units keep their
    // scripts. _fetchMeta is a method (resolved at call time), so referencing
    // it here before its definition is fine.
    if (this._join && typeof this.source.setMetaProvider === 'function') {
      this.source.setMetaProvider((name) => this._fetchMeta(name))
    }
    this._ready = false
    // WsFrameSource opens with connect(); WasmFrameSource is ready() once loaded.
    const start = this.source.connect ? this.source.connect() : this.source.ready()
    this._readyPromise = Promise.resolve(start).then(() => { this._ready = true })
    // Live unit adapters keyed by sim id, in no particular order (the view
    // tolerates iteration order; the deterministic order lives in the engine).
    this._units = new Map()
    // In-flight model-projectiles from the latest snapshot, in the shape the
    // view's projectile renderer expects.
    this._projectiles = []
    // Per-projectile frozen muzzle offset (id -> {dx,dy,dz}), captured the first
    // tick a shot is seen so the rendered mesh leaves the real firing piece
    // rather than the unit origin. See MUZZLE_DECAY_SEC.
    this._projOffsets = new Map()
    // Selection — pure UI state.
    this.selected = new Set()
    // Inspector hover highlight — transient ids (units + projectiles) a panel
    // row is pointing at, so the renderer can trace their silhouette. Pure UI
    // state, cleared the moment the cursor leaves the row.
    this._highlightUnits = new Set()
    this._highlightProjos = new Set()
    this._spawnCount = 0
    this._silenced = false
    // Renderer-owned gravity; the ballistic visuals read it.
    this.gravity = 80
    // Smoke trails for in-flight missiles — scene-owned so all panes share one
    // set of puffs rather than each pushing duplicates.
    this.smokeTrails = new SmokeTrailManager()
    this._unitSoundDebounce = new Map()
    // Fixed-timestep accumulator.
    this._acc = 0
    // Set when a join restore (snapshot seed or Force-Sync re-pull) re-seeded the
    // world; the next tick folds the authority's state in from a non-advancing
    // render read. Deferring to the tick loop — rather than painting straight
    // from the network callback — guarantees a view is driving the scene (so its
    // model resolver is registered) before units are adopted, and lets a window
    // joining a PAUSED match show the live units even though it never steps.
    this._pendingRenderSync = false
    // IDs of the model-less projectiles (cannon shells / EMG bolts) carried in
    // the most recent restore snapshot that still owe a reconstructed tracer
    // vfx. A restored shot has no local fire event to spawn its visual, so we
    // re-emit one into the firing unit's particle pool once that unit hydrates.
    // Only ids captured at restore time live here, so live post-join shots
    // (drawn by the fire-event path) are never double-painted.
    this._pendingRestoredProjoIds = new Set()
    // Wall-clock time (ms) of the most recent folded sim step, used to derive
    // the render-interpolation fraction in join mode (local mode reads the
    // exact leftover from _acc instead).
    this._lastStepAtMs = 0
    // Event listeners (spawn / despawn / fire / death / …) for hosts that want
    // to observe — the view subscribes 'spawn' to attach its explosion overlay.
    this._listeners = new Map()
    // Memoized COB inspection snapshot, refreshed at most once per sim tick (see
    // _cobSnapshot). The inspector panels read it through the runtime adapter.
    this._cobCache = null
    // Lightweight runtime facade: the wasm world owns sim time, but the
    // inspector + audio/particle playback read pause / rate / clock from here.
    // It doubles as the COB-runtime adapter the Runtime / Script Variables
    // panels consume — tickCount / unitCount() / threadCount() / units() are
    // backed by the live wasm COB snapshot (COB runs in the engine, not here).
    const scene = this
    this._runtime = {
      paused: false,
      playbackRate: 1,
      simTimeMs: 0,
      rng: null,
      lastTickMs: 0,
      lastInstCount: 0,
      // isJoin tells the Runtime panel / step bridge that this runtime is backed
      // by an authoritative host, so Pause / Step / Speed must round-trip
      // through the server rather than poke the local clock.
      get isJoin() { return scene._join },
      // Pause: local sandbox freezes its own clock; a joined sandbox asks the
      // authority to pause, which freezes every connected window. The facade's
      // `paused` is then updated from the authority's echo (see the 'control'
      // subscription below), so the UI reflects the true shared state.
      setPaused(p) {
        if (scene._join && typeof scene.source.setPaused === 'function') {
          scene.source.setPaused(!!p)
          return
        }
        this.paused = !!p
      },
      // setPlaybackRate scales the sim clock (0.01×–10×). The scene's tick loop
      // reads playbackRate each frame, so this is the single knob both the COB
      // ribbon slider and the Runtime overlay's Speed slider drive. In join mode
      // the rate is authoritative — the host re-paces its tick and every client
      // follows — so it routes through the source instead.
      setPlaybackRate(r) {
        const n = Number(r)
        const v = Math.max(0.01, Math.min(10, Number.isFinite(n) ? n : 1))
        if (scene._join && typeof scene.source.setRate === 'function') {
          scene.source.setRate(v)
          return
        }
        this.playbackRate = v
      },
      // stepOnce advances exactly one tick while paused. Local mode is handled by
      // the step bridge's per-frame replay; join mode asks the authority to
      // advance one tick and broadcast it so every client steps together.
      stepOnce() {
        if (scene._join && typeof scene.source.stepOnce === 'function') {
          scene.source.stepOnce()
        }
      },
      tick() { /* sim time is advanced by the scene's step loop */ },
      get tickCount() { const c = scene._cobSnapshot(); return c ? (c.tick | 0) : (scene.source.tick | 0) },
      unitCount() { const c = scene._cobSnapshot(); return c && c.units ? c.units.length : 0 },
      threadCount() {
        const c = scene._cobSnapshot()
        if (!c || !c.units) return 0
        let n = 0
        for (const u of c.units) n += (u.threads ? u.threads.length : 0)
        return n
      },
      units() { return scene._cobUnitAdapters() },
      // Developer command: terminate every COB thread on every unit. COB runs in
      // the engine, so this routes through the source; the join transport has no
      // such method, so it degrades to a no-op there.
      killAllThreads() {
        if (typeof scene.source.killAllThreads === 'function') {
          scene.source.killAllThreads()
          scene._invalidateCob()
        }
      },
    }
    // In join mode the authority owns the clock; mirror its broadcast pause /
    // rate into the facade so the Runtime overlay's Pause label + Speed slider
    // show the true shared state (and the local tick loop honours the pause).
    if (this._join && typeof this.source.on === 'function') {
      this.source.on('control', (c) => {
        this._runtime.paused = !!c.paused
        if (c.rate) this._runtime.playbackRate = c.rate
      })
      // A restore (join snapshot or Force-Sync re-pull) re-seeds the world at the
      // authority's tick but does not step, so the per-tick adopt/sync path never
      // runs. Flag it so the next tick paints the restored unit set from a
      // non-advancing render read; a window joining a PAUSED match then shows the
      // live units instead of an empty field until the clock resumes.
      this.source.on('restored', () => {
        this._pendingRenderSync = true
        this._captureRestoredProjectiles()
      })
    }
  }

  // _captureRestoredProjectiles records the ids of the model-less projectiles
  // present at restore time so _applyRenderState can re-emit a tracer vfx for
  // each once its firing unit hydrates. Model projectiles (3DO mesh) draw
  // straight from scene.projectiles() and need no reconstruction, so only the
  // model-less ids (empty kind) are captured here.
  _captureRestoredProjectiles() {
    if (!this._join || typeof this.source.renderState !== 'function') return
    let snap
    try { snap = this.source.renderState() } catch { snap = null }
    const projos = snap && snap.projos
    if (!projos) return
    for (const p of projos) {
      if (!p.kind) this._pendingRestoredProjoIds.add(p.id)
    }
  }

  // _applyRenderState folds the transport's current-tick render snapshot into the
  // adapter unit set + projectiles without advancing the sim. Used after a
  // restore to surface the authority's world while paused; it deliberately does
  // NOT dispatch events (a restore is not a tick that fired anything).
  _applyRenderState() {
    if (!this._join || !this.source || typeof this.source.renderState !== 'function') return
    let snap
    try { snap = this.source.renderState() } catch { snap = null }
    if (!snap) return
    this._runtime.simTimeMs = (snap.tick || 0) * TICK_MS
    this._syncUnits(snap)
    this._syncProjectiles(snap)
  }

  // _reconstructRestoredProjectiles re-emits a tracer vfx for each model-less
  // projectile captured at restore time, now that the firing unit's particle
  // pool and weapon metadata have hydrated. The authoritative position,
  // velocity and remaining life come straight from the snapshot, so the cosmetic
  // particle picks up the shot mid-flight where the host left it. Each id is
  // drained once spawned; ids whose projectile has already detonated (gone from
  // the snapshot) are dropped so the pending set can't leak.
  _reconstructRestoredProjectiles(snap) {
    if (this._pendingRestoredProjoIds.size === 0) return
    const projos = snap.projos || []
    const present = new Set()
    for (const p of projos) {
      present.add(p.id)
      if (!this._pendingRestoredProjoIds.has(p.id)) continue
      const owner = this._units.get(p.ownerId)
      // Owner not adopted/hydrated yet — leave the id pending for a later pass
      // (each unit hydrate re-runs _applyRenderState via _pendingRenderSync).
      if (!owner || !owner.binding || !owner.meta) continue
      const weapon = this._weaponForProjectile(owner, p)
      if (weapon) {
        const remainingMs = Math.max(100, ((p.life || 0) - (p.age || 0)) * 1000)
        spawnProjectileInFlight({
          binding: owner.binding,
          weapon,
          pos: [p.x, p.y, p.z],
          vel: [p.vx, p.vy, p.vz],
          lifeMs: remainingMs,
          palette: this.palette,
          gravity: this.gravity || 80,
        })
      }
      this._pendingRestoredProjoIds.delete(p.id)
    }
    for (const id of this._pendingRestoredProjoIds) {
      if (!present.has(id)) this._pendingRestoredProjoIds.delete(id)
    }
  }

  // _weaponForProjectile resolves the firing unit's weapon entry for a snapshot
  // projectile, matching on the weapon name the engine stamped onto the shot.
  _weaponForProjectile(owner, p) {
    const weapons = owner.meta && owner.meta.weapons
    if (!weapons) return null
    const name = p.weapon || ''
    for (const w of weapons) {
      if (w && w.name === name) return w
    }
    return null
  }

  // _invalidateCob drops the memoized COB snapshot so the next panel read pulls
  // fresh engine state. A developer command mutates script state without
  // advancing the sim tick, so the per-tick memo would otherwise show stale
  // threads until the clock moved.
  _invalidateCob() { this._cobCache = null }

  // ready resolves once the wasm module is live and this scene owns an engine
  // handle.  The view awaits it before the first addUnit / step.
  ready() { return this._readyPromise }

  // engine alias — the view reaches through scene.engine for a handful of
  // calls (setGravity / on / units / getSceneLight / setWeaponTarget /
  // stopUnits).  They all live on the scene, so the scene IS the engine here.
  get engine() { return this }

  get runtime() { return this._runtime }

  // netStats exposes the transport's network/sync telemetry for the Network
  // developer panel. Only the join transport tracks it; an offline wasm sandbox
  // has no server, so this returns null and the panel renders an offline state.
  netStats() {
    if (!this._join || !this.source || typeof this.source.netStats !== 'function') return null
    return this.source.netStats()
  }

  // forceSync triggers the join transport's Force-Sync re-pull (discard local
  // work, re-seed from authority). A no-op offline.
  forceSync() {
    if (this._join && this.source && typeof this.source.forceSync === 'function') {
      this.source.forceSync()
    }
  }

  // diagnose fetches a read-only authoritative snapshot and resolves with
  // { server, client } for the Network panel's drift comparison, leaving local
  // prediction untouched. Rejects when offline (no authority to query).
  diagnose() {
    if (this._join && this.source && typeof this.source.diagnose === 'function') {
      return this.source.diagnose()
    }
    return Promise.reject(new Error('offline sandbox — no authority'))
  }

  // ── COB inspection ────────────────────────────────────────────────
  //
  // COB runs inside the wasm engine, so the live thread / static-var state the
  // Runtime + Script Variables + I/O Ports panels show is pulled from the
  // engine each refresh rather than read off the (render-only) JS binding. The
  // snapshot is memoized per sim tick so the four panels reading it in one
  // publish share a single boundary crossing.

  _cobSnapshot() {
    if (!this._ready || !this.source || typeof this.source.cobState !== 'function') return null
    const tick = this.source.tick || 0
    if (this._cobCache && this._cobCache.tick === tick && this._cobCache.data) {
      return this._cobCache.data
    }
    let data
    try { data = this.source.cobState() } catch { data = null }
    this._cobCache = { tick, data }
    return data
  }

  // _makeCobUnitAdapter shapes one engine unit's COB state into the object the
  // Runtime panel's unit groups + thread rows and the Script Variables panel
  // read. Interactive controls route through the engine: kill / reset hit the
  // source, which drives the live COB state COB owns. The _wasm flag still tells
  // the thread row to skip the disassembly modal it can't source.
  _makeCobUnitAdapter(cu) {
    const threads = (cu.threads || []).map((t) => ({
      id: t.id,
      pc: t.pc | 0,
      offset: t.offset | 0,
      sleepMs: t.sleepMs | 0,
      signalMask: t.signalMask | 0,
      waitOn: t.waiting ? { type: t.waitTurn ? 'turn' : 'move' } : null,
      script: { name: t.script || '' },
    }))
    const scene = this
    const id = cu.id
    return {
      id,
      name: cu.name || '',
      scriptOriginName: cu.name || '',
      staticVars: cu.static || [],
      _threads: threads,
      _recentlyKilled: [],
      _wasm: true,
      runtime: this._runtime,
      killAllThreads() {
        if (typeof scene.source.killUnitThreads === 'function') {
          scene.source.killUnitThreads(id)
          scene._invalidateCob()
        }
      },
      killThreadById(threadId) {
        if (typeof scene.source.killThread === 'function') {
          scene.source.killThread(id, threadId)
          scene._invalidateCob()
        }
      },
      // reset returns the unit to a clean script state in the engine. The Runtime
      // panel's per-unit Reset routes here for wasm units (the in-JS reset path
      // pokes adapter fields that don't back the engine's real state).
      reset() {
        if (typeof scene.source.resetUnit === 'function') {
          scene.source.resetUnit(id)
          scene._invalidateCob()
        }
      },
    }
  }

  _cobUnitAdapters() {
    const c = this._cobSnapshot()
    if (!c || !c.units) return []
    return c.units.map((cu) => this._makeCobUnitAdapter(cu))
  }

  // cobUnit returns the COB adapter for one engine unit id, for the per-unit
  // Script Variables / I/O Ports panels. Null when the unit has no live COB
  // state (script-less, or not yet present in the latest snapshot).
  cobUnit(id) {
    const c = this._cobSnapshot()
    if (!c || !c.units) return null
    const cu = c.units.find((u) => u.id === id)
    return cu ? this._makeCobUnitAdapter(cu) : null
  }

  // ── Event bus ─────────────────────────────────────────────────────

  on(name, cb) {
    if (!this._listeners.has(name)) this._listeners.set(name, new Set())
    this._listeners.get(name).add(cb)
    return () => { const s = this._listeners.get(name); if (s) s.delete(cb) }
  }

  _emit(name, payload) {
    const s = this._listeners.get(name)
    if (!s) return
    for (const cb of s) { try { cb(payload) } catch { /* listener must not stall sim */ } }
  }

  // ── Unit lifecycle ────────────────────────────────────────────────

  // addUnit introduces a unit into the wasm world and returns its adapter.
  // Async because the sim needs the unit's FBI/weapon meta and raw COB bytes
  // (both fetched here) before the engine can spawn it.  The view awaits it.
  // Local mode only — in join mode units arrive through the authority's
  // snapshots, so callers use spawnRemote instead.
  async addUnit({ name, model = null, cobScript = null, x = 0, z = 0, headingRad = 0, side = 0 }) {
    await this._readyPromise
    const meta = await this._fetchMeta(name)
    const pieceNames = await this._fetchPieceNames(name, cobScript)
    const id = this.source.addUnit({ name, meta, x, z, headingRad, side })
    const u = new WasmUnit(this, id, name, side)
    u.model = model ? model.cloneForInstance() : null
    u.meta = meta
    u._cobPieceNames = pieceNames
    u.pos = { x, y: 0, z }
    u.heading = headingRad
    u._p0 = { x, y: 0, z, h: headingRad }
    u._p1 = { x, y: 0, z, h: headingRad }
    u.binding = this._makeBinding()
    this._units.set(id, u)
    this._spawnCount++
    this._emit('spawn', { unit: u })
    return u
  }

  // setModelResolver installs the geometry resolver used to populate u.model on
  // adopted remote units (join mode). The shared scene is created at tab level
  // before any pane exists, but the resolver needs a pane's GL-bound loader, so
  // the first SandboxView to open against a join scene registers its loader here
  // (idempotent — only the first registration sticks). u.model is consumed solely
  // as the pose-tree source for #copyPieceState, so a single loader suffices even
  // across multiple panes (each pane uploads its own GL geometry by unit name).
  setModelResolver(fn) {
    if (!this._modelResolver) this._modelResolver = fn
  }

  // build sends one mobile builder to construct unit type `name` at a ground
  // point. The buildee spawns sim-side once the builder walks into
  // builddistance, so the type's meta (with COB bytes) must be resolvable
  // synchronously by then — pre-fetch it into the spawn cache (local) or the
  // transport's meta registry (join) before submitting the order.
  async build(builderId, name, x, z, queued = false, headingRad = 0) {
    await this._readyPromise
    if (this._join) {
      if (this.source.registerMeta && !this.source.hasMeta(name)) {
        this.source.registerMeta(name, await this._fetchMeta(name))
      }
    } else if (!this._spawnMetas.has(name)) {
      this._spawnMetas.set(name, await this._fetchMeta(name))
    }
    this.source.build(builderId, name, x, z, queued, headingRad)
  }

  // canBuildAt forwards the source's legality probe (terrain fit + no building
  // overlap) for the build-placement ghost colouring. The wasm probe needs the
  // type registered in the spawn resolver to read its footprint, so ensure the
  // meta is fetched into _spawnMetas first; until it lands the answer is
  // neutral (buildable). Join mode resolves through the transport already.
  canBuildAt(name, x, z) {
    if (!this.source?.canBuildAt) return true
    if (!this._join && !this._spawnMetas.has(name)) {
      if (!this._cbFetching) this._cbFetching = new Set()
      if (!this._cbFetching.has(name)) {
        this._cbFetching.add(name)
        this._fetchMeta(name)
          .then((m) => { if (m) this._spawnMetas.set(name, m) })
          .catch(() => { /* stays neutral */ })
          .finally(() => this._cbFetching.delete(name))
      }
      return true
    }
    return this.source.canBuildAt(name, x, z)
  }

  // spawnRemote requests a unit from the authority (join mode). It prefetches
  // the type's meta + COB so the client's prediction engine can resolve the
  // Spawn order synchronously when the command frame arrives, then sends the
  // order. The unit materializes via the next snapshot, where _syncUnits adopts
  // an adapter for it. No return value — the spawn is fire-and-forget through
  // the host, and the adapter appears asynchronously.
  async spawnRemote({ name, x = 0, z = 0, headingRad = 0, side = 0 }) {
    await this._readyPromise
    if (!this._join || !this.source.registerMeta) return
    if (!this.source.hasMeta(name)) {
      this.source.registerMeta(name, await this._fetchMeta(name))
    }
    // Spawn orders carry an integer TA-angle heading (not radians).
    const heading = (Math.round(headingRad / ANGLE_TO_RAD) % 65536 + 65536) % 65536
    this.source.spawn({ name, x, z, heading, side })
  }

  // _fetchMeta loads a unit type's FBI/weapon meta and attaches raw COB bytes
  // so the simulation runs the unit's script (Create, Killed, aim threads);
  // render-side animation derives from the resulting snapshot.
  async _fetchMeta(name) {
    let meta = null
    try {
      const r = await fetch(`/api/studio/unit/${encodeURIComponent(name)}`)
      if (r.ok) meta = await r.json()
    } catch { /* no FBI — unit spawns static */ }
    if (!meta) meta = { name }
    if (!meta.name) meta.name = name
    return withCobBytes(name, meta)
  }

  // _fetchPieceNames returns the positional piece-name list that maps a
  // snapshot's pieces[] back to model pieces. Accepts a pre-fetched cobScript.
  async _fetchPieceNames(name, cobScript = null) {
    let cs = cobScript
    if (!cs) {
      try {
        const r = await fetch(`/api/studio/cob/${encodeURIComponent(name)}?decompile=0`)
        if (r.ok) cs = await r.json()
      } catch { /* no COB — pieces stay at rest */ }
    }
    return (cs && cs.pieceNames) || []
  }

  // _makeBinding builds the per-unit render binding (particle + audio pools).
  // COB runs in the wasm engine, not here, so the script hooks are inert — the
  // view's auto-Create path becomes a no-op (Create already ran on spawn).
  _makeBinding() {
    const binding = {
      particles: new ParticlePool(1024, { rng: this._runtime.rng }),
      audio: this._audioFactory(),
      worldOffset: { x: 0, y: 0, z: 0 },
      cobPorts: {},
      _lifecycle: 'created',
      hasScript: () => false,
      start: () => {},
      getSceneLight: () => null,
      getSceneLights: () => [],
    }
    if (this._silenced && typeof binding.audio.setPaused === 'function') {
      try { binding.audio.setPaused(true) } catch { /* ignore */ }
    }
    return binding
  }

  // _adoptRemoteUnit builds an adapter for a unit first seen in an authority
  // snapshot (join mode). Motion fields are filled by the caller; model + meta
  // hydrate asynchronously so a missing asset never stalls the snapshot apply.
  _adoptRemoteUnit(su) {
    const u = new WasmUnit(this, su.id, su.name, su.side)
    u.pos = { x: su.x, y: su.y, z: su.z }
    u.heading = su.headingRad
    u._p0 = { x: su.x, y: su.y, z: su.z, h: su.headingRad }
    u._p1 = { x: su.x, y: su.y, z: su.z, h: su.headingRad }
    u.binding = this._makeBinding()
    this._units.set(su.id, u)
    this._spawnCount++
    this._hydrateRemoteUnit(u)
    this._emit('spawn', { unit: u })
    return u
  }

  // _hydrateRemoteUnit fills in the meta, piece-name map and model clone for an
  // adopted remote unit. Until it resolves the unit renders at its origin with
  // no pose (pieces guard on a missing model); once ready it animates normally.
  async _hydrateRemoteUnit(u) {
    try {
      u.meta = await this._fetchMeta(u.name)
      u._cobPieceNames = await this._fetchPieceNames(u.name)
      if (this._modelResolver) u.model = await this._modelResolver(u.name)
    } catch { /* asset hydrate failed — unit stays a static marker */ }
    // The model resolves after the snapshot's poses were first applied (when
    // _applyPieces still bailed on a missing model). Request another render-state
    // pass so the latched poses land now that the model exists — without this a
    // paused join shows units frozen at their origin until a Force Sync.
    this._pendingRenderSync = true
  }

  removeUnit(id) {
    if (!this._units.has(id)) return
    try { this.source.removeUnit(id) } catch { /* ignore */ }
    this._units.delete(id)
    this.selected.delete(id)
    this._emit('despawn', { unitId: id })
  }

  units() { return this._units.values() }
  unitById(id) { return this._units.get(id) || null }
  unitCount() { return this._units.size }
  projectiles() { return this._projectiles }

  // ── Commands ──────────────────────────────────────────────────────
  //
  // The view mostly drives commands by assigning unit.moveTarget /
  // attackTarget (handled by the WasmUnit setters); these are the few it
  // routes through the engine object directly.

  setWeaponTarget(unitId, slot, target /*, opts */) {
    const u = this._units.get(unitId)
    if (!u || !target) return
    const s = slot | 0
    if (typeof this.source.fire !== 'function') return
    if (target.unit) {
      // Force-fire a specific weapon slot at a unit. Unlike an Attack order this
      // does not make the unit chase — it fires the slot in place.
      this.source.fire(unitId, s, target.unit.id >>> 0, 0, 0)
      this._setWeaponHint(u, s, { type: 'unit', unit: target.unit })
      return
    }
    if (target.point) {
      // Shift-to-ground force-fire: aim the slot at a terrain point (x, z); the
      // ground plane supplies the elevation.
      const [x, , z] = target.point
      this.source.fire(unitId, s, 0, x, z)
      this._setWeaponHint(u, s, { type: 'point', point: [x, 0, z] })
    }
  }

  // _setWeaponHint records the slot's current aim target on the adapter so the
  // view's shift-hold overlay can draw an attack glyph for a force-fire order.
  // The wasm snapshot carries no per-slot aim state, so this client-side hint is
  // the overlay's only source; it's cleared by a Stop or a new Move order (both
  // of which the sim treats as cancelling the standing fire).
  _setWeaponHint(u, slot, target) {
    if (!u.weaponSlots) u.weaponSlots = [null, null, null]
    u.weaponSlots[slot] = { target }
  }

  stopUnits(ids) {
    if (!ids || !ids.length) return 0
    this.source.stop(ids)
    for (const id of ids) {
      const u = this._units.get(id)
      if (u) { u._moveTarget = null; u._attackTarget = null; u.weaponSlots = null }
    }
    return ids.length
  }

  stopUnit(id) { return this.stopUnits([id]) }
  clearOrders(id) { this.stopUnits([id]) }

  setGravity(g) {
    const v = +g
    if (Number.isFinite(v) && v > 0) this.gravity = v
  }

  // ── Selection ─────────────────────────────────────────────────────

  selectOnly(id) {
    this.selected.clear()
    if (id != null && this._units.has(id)) this.selected.add(id)
  }
  selectAdd(id) { if (id != null && this._units.has(id)) this.selected.add(id) }
  selectClear() { this.selected.clear() }
  isSelected(id) { return this.selected.has(id) }

  // ── Inspector hover highlight ─────────────────────────────────────
  //
  // setHighlight replaces the highlighted-id sets (unit ids + projectile
  // ids) the entity builder reads to flag the renderer's bright-outline
  // pass.  Called from the host bridge as a panel row is hovered / un-
  // hovered (empty arrays clear it).  The sandbox renderer runs a live RAF
  // loop, so the entity builder picks the new set up on the next frame.
  setHighlight(unitIds, projIds) {
    this._highlightUnits = new Set((unitIds || []).map((n) => n | 0))
    this._highlightProjos = new Set((projIds || []).map((n) => n | 0))
  }
  isUnitHighlighted(id) { return this._highlightUnits.size > 0 && this._highlightUnits.has(id | 0) }
  isProjoHighlighted(id) { return this._highlightProjos.size > 0 && this._highlightProjos.has(id | 0) }

  // ── Audio ─────────────────────────────────────────────────────────

  setSilenced(s) {
    s = !!s
    if (s === this._silenced) return
    this._silenced = s
    for (const u of this._units.values()) {
      const a = u.binding && u.binding.audio
      if (a && typeof a.setPaused === 'function') {
        try { a.setPaused(s) } catch { /* ignore */ }
      }
    }
  }

  playUnitSound(unit, eventKey) {
    if (!unit || !unit.meta || !unit.meta.sounds || !unit.binding) return false
    const stem = unit.meta.sounds[eventKey]
    if (!stem) return false
    const key = `${unit.id}:${eventKey}`
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now()
    const last = this._unitSoundDebounce.get(key) || 0
    if (now - last < UNIT_SOUND_DEBOUNCE_MS) return false
    this._unitSoundDebounce.set(key, now)
    const pool = unit.binding.audio
    if (!pool) return false
    pool.play(stem, {
      vol: 0.85,
      kind: 'unit',
      source: `${unit.name || 'Unit'}: ${eventKey}`,
      pos: [unit.pos.x, unit.pos.y || 0, unit.pos.z],
    })
    return true
  }

  playUnitSoundRandom(unit, eventKeys) {
    if (!unit || !unit.meta || !unit.meta.sounds) return false
    const present = eventKeys.filter((k) => unit.meta.sounds[k])
    if (present.length === 0) return false
    const pick = present[Math.floor(Math.random() * present.length)]
    return this.playUnitSound(unit, pick)
  }

  // getSceneLights scans every live unit's particle pool and returns the
  // strongest light-emitting particles (up to MAX_PULSE_LIGHTS) for the
  // renderer's dynamic light slots.  Returning several — rather than a single
  // winner — lets every concurrent shot light the scene at once, so a
  // rapid-firing battleship's volley each casts its own glow instead of only
  // the first shell.  Mirrors the GameEngine path through the shared collector.
  getSceneLights() {
    const pools = []
    for (const u of this._units.values()) {
      if (u.dead) continue
      const p = u.binding && u.binding.particles
      if (p) pools.push(p)
    }
    return gatherSceneLights(pools)
  }

  // getSceneLight returns the single strongest light for callers still on the
  // one-slot path; null when nothing is lit.
  getSceneLight() {
    const lights = this.getSceneLights()
    return lights.length ? lights[0] : null
  }

  // ── Per-frame tick ────────────────────────────────────────────────

  // tick advances the wasm world on the fixed 25 ms grid for however much
  // wall-clock time `dtMs` (scaled by playback rate) has accumulated, then ages
  // particles / audio / smoke trails by the same scaled dt.
  tick(dtMs) {
    if (!this._ready) return null
    const rt = this._runtime
    const rate = rt.paused ? 0 : (rt.playbackRate || 1)
    let snap = null
    if (this._join) {
      // Authority-clock pacing: step the local prediction up to the host's
      // serverTick.  Pause / step / rate are authoritative — serverTick freezes
      // when the host pauses, advances by one on a host single-step, and paces
      // at the host's rate — so the local clock always follows it rather than
      // gating on the (mirrored) local pause flag.  rate below still scales
      // particle/audio aging so a paused window's effects freeze too.
      const target = this.source.serverTick || 0
      let steps = 0
      while (this.source.tick < target && steps < MAX_CATCHUP_STEPS) {
        const s = this._stepOnce()
        // A join transport stalls (null) while awaiting a snapshot restore or a
        // pending unit-type fetch; stop this frame and retry once the gate clears.
        if (s === null) break
        snap = s
        steps++
      }
      // Fold in a fresh restore that produced no step this frame (a paused join,
      // or a Force-Sync re-pull at the current tick): without this the restored
      // units would never reach the adapters until the clock advanced. When the
      // catch-up loop did step, it already synced the freshest snapshot, so the
      // pending flag is simply cleared.
      if (this._pendingRenderSync) {
        this._pendingRenderSync = false
        if (steps === 0) this._applyRenderState()
      }
      // Re-emit tracer vfx for any model-less shots a restore carried in but that
      // had no local fire event. Runs whether the catch-up loop stepped (paused
      // join uses the non-advancing render read; a resumed / non-paused Force
      // Sync uses the freshest stepped snapshot) and drains as owners hydrate.
      if (this._pendingRestoredProjoIds.size > 0) {
        let s = snap
        if (!s && typeof this.source.renderState === 'function') {
          try { s = this.source.renderState() } catch { s = null }
        }
        if (s) this._reconstructRestoredProjectiles(s)
      }
    } else {
      this._acc += dtMs * rate
      let steps = 0
      while (this._acc >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
        const s = this._stepOnce()
        if (s === null) break
        this._acc -= TICK_MS
        snap = s
        steps++
      }
      if (steps >= MAX_STEPS_PER_FRAME) this._acc = 0
    }
    const dt = dtMs * rate
    for (const u of this._units.values()) {
      const b = u.binding
      if (!b) continue
      if (b.particles) b.particles.tick(dt)
      if (b.audio) b.audio.tick(rt.playbackRate || 1, this._silenced || rt.paused)
    }
    this.smokeTrails.tick(dt)
    return snap
  }

  // interpolate samples every unit's display pose for the CURRENT wall-clock
  // instant, independent of the sim-step cadence. The renderer calls it from
  // its pre-draw hook once per painted frame, so a 30/60/144 Hz display each
  // shows the exact in-between pose for the moment it paints — not the last
  // sim tick's frozen pose. The fraction is real time elapsed since the most
  // recent folded step over the tick interval (scaled by playback rate), which
  // works identically in local and join mode because both stamp _lastStepAtMs
  // on every step. Paused / zero-rate holds the previously sampled fraction so
  // the scene freezes in place rather than snapping.
  interpolate() {
    const rt = this._runtime
    const rate = rt.paused ? 0 : (rt.playbackRate || 1)
    let alpha
    if (rate <= 0) {
      alpha = this._interpAlpha || 0
    } else if (!this._join) {
      // Local mode: the step accumulator IS the phase into the next tick —
      // exact regardless of display rate, playback rate or how many steps a
      // frame folded, where a wall-clock estimate drifts against the fold
      // loop and reads as micro-stutter.
      alpha = this._acc / TICK_MS
    } else {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      const interval = TICK_MS / rate
      alpha = interval > 0 ? (now - this._lastStepAtMs) / interval : 1
    }
    if (!(alpha >= 0)) alpha = 0
    if (alpha > 1) alpha = 1
    this._interpAlpha = alpha
    this._applyInterpolation(alpha)
  }

  // _applyInterpolation writes each unit's display pose as a lerp between its
  // previous (_p0) and latest (_p1) tick states by `alpha` ∈ [0,1]. Heading
  // takes the wrap-aware shortest arc so a unit crossing the ±π seam doesn't
  // spin the long way round. This is the single point both the rendered model
  // (via #refreshEntities) and the tracking camera (via applyTracking) read, so
  // interpolating pos/heading here smooths both at once.
  _applyInterpolation(alpha) {
    for (const u of this._units.values()) {
      const p0 = u._p0, p1 = u._p1
      u.pos.x = p0.x + (p1.x - p0.x) * alpha
      u.pos.y = p0.y + (p1.y - p0.y) * alpha
      u.pos.z = p0.z + (p1.z - p0.z) * alpha
      let dh = p1.h - p0.h
      while (dh > Math.PI) dh -= Math.PI * 2
      while (dh < -Math.PI) dh += Math.PI * 2
      u.heading = p0.h + dh * alpha
      this._applyPieces(u, alpha)
    }
  }

  // _stepOnce advances exactly one sim tick and folds the resulting snapshot
  // into the adapter unit set, model poses, projectile list and visual events.
  _stepOnce() {
    const snap = this.source.step()
    // Join transport may return null to stall (awaiting snapshot/meta); the
    // caller leaves the accumulator intact and retries next frame.
    if (!snap) return null
    this._lastStepAtMs = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    this._runtime.simTimeMs = (snap.tick || 0) * TICK_MS
    this._syncUnits(snap)
    this._syncProjectiles(snap)
    this._dispatchEvents(snap)
    this._tickBuildFx(snap)
    // Per-side resource usage (spent totals + current drain/sec) for the
    // HUD. Infinite pools — display only.
    this.resources = snap.resources || this.resources || []
    return snap
  }

  // _tickBuildFx sprinkles the per-game construction effect over every live
  // build: pulses of bright particles along the builder→buildee line and over
  // the rising frame. The colour comes from the game adapter's buildFx — TA
  // reads as nanolathe spray, TA:K as golden casting sparkles. Pseudo-random
  // scatter derives from the tick so it stays deterministic per client (it is
  // render-only either way).
  _tickBuildFx(snap) {
    if (!this._activeBuilds || this._activeBuilds.size === 0) return
    const tick = snap.tick | 0
    if (tick % 2) return // 20 Hz pulse at the 40 Hz sim rate
    const color = (activeGame().buildFx && activeGame().buildFx.color) || [0.5, 1.7, 0.7, 1.0]
    for (const [builderId, job] of this._activeBuilds) {
      const builder = this._units.get(builderId)
      const buildee = this._units.get(job.buildeeId)
      const b = builder && builder.binding
      if (!builder || !buildee || !b || !b.particles) continue
      const sp = builder._p1 || builder.pos
      const bp = buildee._p1 || buildee.pos
      // Spray stream: dense pulses along the builder→buildee line...
      for (let i = 0; i < 4; i++) {
        const t = 0.25 + 0.75 * (((tick / 2) + i) % 4) / 4
        const x = sp.x + (bp.x - sp.x) * t + (((tick * 7 + i * 13) % 9) - 4)
        const z = sp.z + (bp.z - sp.z) * t + (((tick * 5 + i * 17) % 9) - 4)
        const y = Math.max(bp.y || 0, 0) + 6 + (((tick / 2) + i) % 3) * 6
        b.particles.emit(SFX_FIRE_FLASH, [x, y, z], { size: 10, lifeMs: 380, color })
      }
      // ...plus a shimmer over the rising frame itself, so the buildee
      // visibly crackles with the construction energy.
      for (let i = 0; i < 3; i++) {
        const x = bp.x + (((tick * 11 + i * 23) % 25) - 12)
        const z = bp.z + (((tick * 13 + i * 19) % 25) - 12)
        const y = Math.max(bp.y || 0, 0) + 4 + ((tick * 3 + i * 29) % 22)
        b.particles.emit(SFX_FIRE_FLASH, [x, y, z], { size: 8, lifeMs: 300, color })
      }
    }
  }

  _syncUnits(snap) {
    const units = snap.units || []
    for (const su of units) {
      let u = this._units.get(su.id)
      if (!u) {
        // Local mode creates adapters in addUnit, but engine-spawned units —
        // a builder's buildee materializing at its construction site — first
        // appear here, exactly like join mode's authority snapshots: adopt an
        // adapter and hydrate its model/meta asynchronously.
        u = this._adoptRemoteUnit(su)
      }
      // Shift the last tick's pose into _p0 and record the new one in _p1; the
      // per-frame _applyInterpolation lerps pos/heading between them so motion
      // reads smooth between sim ticks. A large positional jump (respawn /
      // teleport) collapses both endpoints so the unit snaps rather than
      // sliding across the field. pos/heading themselves are left for the
      // interpolation pass to write.
      const p0 = u._p0, p1 = u._p1
      p0.x = p1.x; p0.y = p1.y; p0.z = p1.z; p0.h = p1.h
      p1.x = su.x; p1.y = su.y; p1.z = su.z; p1.h = su.headingRad
      const jump = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)
      if (jump > INTERP_SNAP_WU) { p0.x = p1.x; p0.y = p1.y; p0.z = p1.z; p0.h = p1.h }
      u.isMoving = su.isMoving
      u.speed = su.speed || 0
      u.health = su.health
      // Death drops the unit out of the live selection — a corpse playing
      // its death animation is no longer a commandable actor.
      if (su.dead && !u.dead) this.selected.delete(su.id)
      u.dead = su.dead
      u.buildPercent = su.buildPercent
      // Drop the attack hint when its target dies / despawns. The move hint is
      // NOT cleared on a transient isMoving==false here — acceleration ramps and
      // turn-in-place make isMoving flicker low for a tick or two before the unit
      // actually travels, and clearing on that flicker wiped the shift-drag
      // destination overlay almost immediately. The authoritative arrival is the
      // 'moveStop' event instead (see _dispatchEvents), which fires once when the
      // unit truly reaches its destination.
      const t = u._attackTarget
      if (t && (t.dead || !this._units.has(t.id))) u._attackTarget = null
      // The sim is the authority on the order queue and the current move leg:
      // adopt both each tick so the waypoint overlay tracks queue advancement
      // (a queued leg arming after arrival never went through the setter).
      u.queue = su.queue || []
      // Production state for the build-menu counters: the type currently
      // raising on this builder's pad plus a factory's pending run.
      u.building = su.building || ''
      u.prodQueue = su.prodQueue || []
      // Standing orders — the Controls panel's Move/Fire rows read these.
      u._stance.move = su.moveMode | 0
      u._stance.fire = su.fireMode | 0
      // Armed self-destruct fuse remaining (ms; 0 = off) for the countdown
      // overlay above the unit.
      u.selfDestructMs = su.selfDestructMs | 0
      // Transport links: the carrier this unit rides (0 = grounded) and a
      // transport's passenger list, for the load/unload gestures + badge.
      u.carriedBy = su.carriedBy | 0
      u.carrying = su.carrying || []
      if (su.hasMove) {
        if (!u._moveTarget) u._moveTarget = { x: su.moveX, z: su.moveZ }
        else { u._moveTarget.x = su.moveX; u._moveTarget.z = su.moveZ }
      } else if (u._moveTarget) {
        u._moveTarget = null
      }
      this._bufferPieces(u, su.piecesPacked)
    }
  }

  // _bufferPieces double-buffers a unit's packed piece transforms so the
  // per-frame interpolation pass can lerp the COB animation (walk gaits,
  // turret turns) between sim ticks instead of snapping at the tick rate.
  _bufferPieces(u, packed) {
    if (!packed) return
    const f = new Float32Array(packed.buffer, packed.byteOffset, packed.byteLength >> 2)
    if (!u._pieces1 || u._pieces1.length !== f.length) {
      u._pieces1 = new Float32Array(f)
      u._pieces0 = new Float32Array(f)
      return
    }
    const tmp = u._pieces0
    u._pieces0 = u._pieces1
    u._pieces1 = tmp
    u._pieces1.set(f)
  }

  // _applyPieces writes each piece's display transform onto the unit's model
  // clone as a lerp between the
  // previous and latest tick buffers (packed Float32 stride-7:
  // ox, oy, oz, rx, ry, rz, visible). Rotations take the wrap-aware shortest
  // arc in TA-angle space so a spinning radar crossing the seam doesn't whip
  // the long way round; visibility is a hard switch from the latest tick. The
  // model loader X-flips geometry, so Z-translation and X/Y rotation flip
  // sign while Z-rotation does not; piece lookups stay cached per clone.
  _applyPieces(u, alpha) {
    const f0 = u._pieces0, f1 = u._pieces1
    if (!u.model || !f1) return
    if (u._pieceCacheModel !== u.model) {
      u._pieceCacheModel = u.model
      u._pieceCache = u._cobPieceNames.map((name) => (name ? u.model.findPiece(name) : null))
    }
    const n = Math.min(u._pieceCache.length, (f1.length / 7) | 0)
    const HALF = 32768, FULL = 65536
    const arc = (a0, a1) => {
      let d = (a1 - a0) % FULL
      if (d > HALF) d -= FULL
      else if (d < -HALF) d += FULL
      return a0 + d * alpha
    }
    for (let i = 0; i < n; i++) {
      const piece = u._pieceCache[i]
      if (!piece) continue
      const o = i * 7
      piece.move[0] = f0[o] + (f1[o] - f0[o]) * alpha
      piece.move[1] = f0[o + 1] + (f1[o + 1] - f0[o + 1]) * alpha
      piece.move[2] = -(f0[o + 2] + (f1[o + 2] - f0[o + 2]) * alpha)
      piece.rotate[0] = -ANGLE_TO_RAD * arc(f0[o + 3], f1[o + 3])
      piece.rotate[1] = -ANGLE_TO_RAD * arc(f0[o + 4], f1[o + 4])
      piece.rotate[2] = ANGLE_TO_RAD * arc(f0[o + 5], f1[o + 5])
      piece.visible = f1[o + 6] !== 0
    }
  }

  _syncProjectiles(snap) {
    const projos = snap.projos || []
    if (projos.length === 0) {
      if (this._projectiles.length) this._projectiles = []
      if (this._projOffsets.size) this._projOffsets.clear()
      return
    }
    // Drop frozen offsets for shots that are no longer in flight.
    if (this._projOffsets.size) {
      const live = new Set(projos.map((p) => p.id))
      for (const id of this._projOffsets.keys()) if (!live.has(id)) this._projOffsets.delete(id)
    }
    this._projectiles = projos.map((p) => {
      // Capture the muzzle offset the first tick a shot appears (age ~0, when the
      // sim spawn point still coincides with the launcher), then ease it out so
      // the mesh starts at the firing piece and converges onto the sim path.
      let off = this._projOffsets.get(p.id)
      if (!off) { off = this._muzzleOffsetFor(p); this._projOffsets.set(p.id, off) }
      const k = Math.max(0, 1 - (p.age || 0) / MUZZLE_DECAY_SEC)
      const pos = { x: p.x + off.dx * k, y: p.y + off.dy * k, z: p.z + off.dz * k }
      return {
      id: p.id,
      model: p.kind || null,
      weaponName: p.weapon || p.kind || '',
      pos,
      // The snapshot carries projectile orientation as raw TA-angles (65536 per
      // turn); the renderer's projectile transform expects radians (it feeds
      // these straight into Ry(heading)/Rx(-pitch)). Convert here — without it
      // a TA-angle integer is read as a radian value and the missile spins /
      // flaps / flies sideways as the angle wraps each tick.
      heading: p.heading * ANGLE_TO_RAD,
      pitch: p.pitch * ANGLE_TO_RAD,
      // Inspection fields the Projectiles panel reads (aggregateProjectiles).
      // Without them its model-projectile loop dereferences undefined and
      // throws, which also suppresses the particle-projectile feed.
      dead: false,
      ownerId: p.ownerId || 0,
      targetUnitId: p.targetUnitId || null,
      mode: p.mode || 'straight',
      origin: { x: p.ox, y: p.oy, z: p.oz },
      target: { x: p.tx, y: p.ty, z: p.tz },
      vel: { x: p.vx, y: p.vy, z: p.vz },
      speed: p.speed || 0,
      ageSec: p.age || 0,
      lifeSec: p.life || 0,
      }
    })
  }

  // buildAttachFor reports the live construction job holding a buildee, if
  // any: the builder adapter, the pad piece name to pin the buildee to
  // (QueryBuildInfo; null when the builder has no pad), and the builder's
  // piece-name table index. The view uses it to ride a factory buildee on
  // the build plate while it rises.
  buildAttachFor(buildeeId) {
    if (!this._activeBuilds) return null
    for (const [builderId, job] of this._activeBuilds) {
      if (job.buildeeId !== buildeeId) continue
      const builder = this._units.get(builderId)
      if (!builder) return null
      const names = builder._cobPieceNames || []
      const pieceName = (job.fromPiece >= 0 && job.fromPiece < names.length)
        ? names[job.fromPiece] : null
      return { builder, pieceName }
    }
    return null
  }

  // _muzzleOffsetFor computes the world delta from a shot's sim spawn point (the
  // unit origin) to the actual firing piece, using the owner model's
  // resolvePieceWorld with the same +π render convention _muzzleAnchor uses. Any
  // gap (no owner/model/piece, missing fromPiece) yields a zero offset so the
  // shot simply renders at the sim position.
  _muzzleOffsetFor(p) {
    const zero = { dx: 0, dy: 0, dz: 0 }
    const owner = this._units.get(p.ownerId)
    if (!owner) return zero
    const idx = p.fromPiece
    const names = owner._cobPieceNames || []
    if (idx == null || idx < 0 || idx >= names.length) return zero
    const model = owner.model
    if (!model || typeof model.findPiece !== 'function' || typeof model.resolvePieceWorld !== 'function') return zero
    const piece = model.findPiece(names[idx])
    if (!piece) return zero
    const w = model.resolvePieceWorld(piece, owner.pos.x, owner.pos.y, owner.pos.z, owner.heading + Math.PI)
    if (!w) return zero
    return { dx: w[0] - p.x, dy: w[1] - p.y, dz: w[2] - p.z }
  }

  // _dispatchEvents turns the tick's render events into particle / audio /
  // projectile visuals — once per event, scene-level, so a split view doesn't
  // double them.  Event kind names match cmd/engine-wasm/convert.go.
  _dispatchEvents(snap) {
    const events = snap.events || []
    for (const ev of events) {
      switch (ev.kind) {
        case 'spawn':
          this._spawnCount++
          break
        case 'despawn':
          this.selected.delete(ev.unitId)
          this._emit('despawn', { unitId: ev.unitId })
          break
        case 'fire':
          this._onFire(ev)
          break
        case 'death':
          this._onDeath(ev)
          break
        case 'explode':
          // COB EXPLODE opcode (death-throes debris from a Killed script).
          this._flash(ev.unitId, ev, 24, 500, [1.6, 0.6, 0.2, 1.0])
          break
        case 'emitSfx':
          this._sfx(ev.unitId, SFX_SMOKE_WHITE, ev)
          break
        case 'projectileHit':
          this._flash(ev.unitId, ev, 56, 800, [1.9, 0.7, 0.2, 1.0])
          break
        case 'corpseSpawn':
          // The Killed script settled its corpsetype (carried in slot):
          // 1 = intact corpse feature, 2 = the damaged featuredead wreck,
          // 3 = nothing survives. Swap the dead unit's model for the wreck
          // 3DO so the battlefield keeps TA's TDF-faithful debris.
          this._onCorpse(ev)
          break
        case 'playSound': {
          // COB PLAY_SOUND (TA:K v6) — the sim resolved the opcode's index
          // through the COB's sound table into a .wav stem. Death cries and
          // ability stingers arrive here rather than via the FBI sound map.
          const u = this._units.get(ev.unitId)
          const stem = (ev.sound || '').trim().toLowerCase()
          if (u && stem && u.binding && u.binding.audio) {
            u.binding.audio.play(stem, {
              vol: 0.85,
              kind: 'unit',
              source: `${u.name || 'Unit'}: play-sound`,
              pos: [ev.x || 0, ev.y || 0, ev.z || 0],
            })
          }
          break
        }
        case 'moveStop': {
          const u = this._units.get(ev.unitId)
          if (u) {
            // Authoritative arrival — drop the move hint so the shift-drag
            // destination glyph clears now that the unit has reached its target.
            u._moveTarget = null
            this.playUnitSoundRandom(u, ['arrived1', 'arrived2', 'arrived3', 'arrived4', 'arrived5'])
          }
          break
        }
        case 'buildStart': {
          // Builder reached its site and the buildee exists — run the
          // per-game construction effect (nanolathe / casting) until the
          // matching buildStop. Keyed by builder so a re-ordered builder
          // swaps cleanly to its new job.
          if (!this._activeBuilds) this._activeBuilds = new Map()
          this._activeBuilds.set(ev.unitId, {
            buildeeId: ev.targetId,
            // Factory pad piece (QueryBuildInfo) the buildee rides during
            // construction; -1 when the builder has no pad query.
            fromPiece: ev.fromPiece == null ? -1 : ev.fromPiece,
          })
          const b = this._units.get(ev.unitId)
          if (b) this.playUnitSound(b, 'build')
          break
        }
        case 'buildStop':
          if (this._activeBuilds) this._activeBuilds.delete(ev.unitId)
          break
        case 'blast': {
          // Death explosion (explodeas / selfdestructas) — sized from the
          // weapon's blast diameter (sfxType, world units) so a commander
          // blast reads catastrophically bigger than a peewee pop.
          const aoe = Math.max(32, ev.sfxType | 0)
          this._flash(ev.unitId, ev, aoe, 950, [1.9, 0.8, 0.25, 1.0])
          break
        }
        default:
          break
      }
    }
  }

  _onFire(ev) {
    const u = this._units.get(ev.unitId)
    if (!u) return
    const weapon = u.meta && u.meta.weapons && u.meta.weapons[ev.slot]
    if (!weapon || !weapon.name) return
    // Prefer the muzzle the sim's Query<slot> script reported (post-animation
    // world position of that piece), so multi-barrel weapons fire from the
    // cycling barrel rather than the unit centre. Falls back to the sim anchor.
    const anchor = this._muzzleAnchor(u, ev)
    // Notify external listeners (test harness, HUD) for parity with the
    // legacy GameEngine, which surfaced every muzzle as a 'fire' event.
    this._emit('fire', { unit: u, slot: ev.slot, weapon, anchor, targetId: ev.targetId })
    try {
      // A model weapon (missile / rocket / bomb) is flown by the sim and drawn
      // as a 3DO mesh from the projectile list — just voice the muzzle here.
      if (weapon.model && !weapon.beamWeapon) {
        playWeaponSound({ binding: u.binding, weapon, anchor })
        return
      }
      const target = this._targetPoint(ev)
      spawnProjectile({
        binding: u.binding,
        weapon,
        anchor,
        target,
        palette: this.palette,
        gravity: this.gravity || 80,
        smokeTrails: this.smokeTrails,
      })
    } catch { /* projectile-vis failures must not stall the sim */ }
  }

  // _targetPoint resolves a fire event's aim point. A live target unit's centre
  // of mass takes priority so a tracked shot leads the unit's current pose; for
  // a force-fire at the ground there is no target unit, so the sim's resolved
  // aim point (tx/ty/tz) drives the trajectory. The firing anchor is the final
  // fallback, kept only so the beam helper never throws on a target-less shot.
  _targetPoint(ev) {
    const t = ev.targetId && this._units.get(ev.targetId)
    if (t) return [t.pos.x, t.pos.y + 12, t.pos.z]
    if (Number.isFinite(ev.tx) && (ev.tx !== ev.x || ev.ty !== ev.y || ev.tz !== ev.z)) {
      return [ev.tx, ev.ty, ev.tz]
    }
    return [ev.x, ev.y, ev.z]
  }

  // _muzzleAnchor resolves the world position the shot exits from. The sim runs
  // the unit's Query<slot> script and forwards the firing piece index (ev.fromPiece,
  // into the unit's piece-name table); we look that piece up on the unit's live,
  // COB-animated model and compute its post-animation world position via
  // resolvePieceWorld — the same transform chain the renderer feeds the pose
  // (the +π mirrors the loader's X-flip), so the muzzle tracks the moved/turned
  // unit and cycles between barrels as the query alternates. Any gap (no Query
  // script, no model yet, out-of-range index) falls back to the sim's fire anchor.
  _muzzleAnchor(u, ev) {
    const fallback = [ev.x, ev.y, ev.z]
    const idx = ev.fromPiece
    if (idx == null || idx < 0) return fallback
    const names = u._cobPieceNames || []
    if (idx >= names.length) return fallback
    const model = u.model
    if (!model || typeof model.findPiece !== 'function') return fallback
    const piece = model.findPiece(names[idx])
    if (!piece) return fallback
    if (typeof model.resolvePieceWorld === 'function') {
      const w = model.resolvePieceWorld(piece, u.pos.x, u.pos.y, u.pos.z, u.heading + Math.PI)
      if (w) return w
    }
    return fallback
  }

  _onCorpse(ev) {
    const u = this._units.get(ev.unitId)
    if (!u) return
    const meta = u.meta || {}
    let object = null
    if (ev.slot === 2) object = meta.corpseHeapObject || meta.corpseObject
    else if (ev.slot !== 3) object = meta.corpseObject
    if (!object) {
      // Nothing left (corpsetype 3, or the unit ships no corpse feature):
      // the unit vanishes once its death sequence has finished.
      u.corpseHidden = true
      return
    }
    // The view keys GL geometry by name, so the swap is a name override:
    // #refreshEntities loads + draws the wreck 3DO in place of the unit.
    u.wreckName = object
  }

  _onDeath(ev) {
    const u = this._units.get(ev.unitId)
    this._flash(ev.unitId, ev, 32, 600, [1.6, 0.6, 0.2, 1.0])
    this._emit('death', { unit: u, anchor: [ev.x, ev.y, ev.z] })
  }

  _flash(unitId, ev, size, lifeMs, color) {
    const u = this._units.get(unitId)
    const b = u && u.binding
    if (!b || !b.particles) return
    b.particles.emit(SFX_FIRE_FLASH, [ev.x, ev.y, ev.z], { size, lifeMs, color })
  }

  _sfx(unitId, kind, ev) {
    const u = this._units.get(unitId)
    const b = u && u.binding
    if (!b || !b.particles) return
    b.particles.emit(kind, [ev.x, ev.y, ev.z], {})
  }

  // ── Teardown ──────────────────────────────────────────────────────

  dispose() {
    try { this.smokeTrails.clear() } catch { /* ignore */ }
    this._unitSoundDebounce.clear()
    this._units.clear()
    this._projectiles = []
    try { this.source.dispose() } catch { /* ignore */ }
  }
}
