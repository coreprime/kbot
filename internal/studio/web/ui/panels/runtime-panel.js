// runtime-panel.js
//
// React-rendered Runtime overlay — sim-clock + per-unit thread list +
// runtime-wide controls (Pause / Step / Stop All) + a playback-rate
// slider that's mirrored to the COB-menu Playback slider through the
// host bridge.  Click a thread row to open the live debugger (still
// vanilla; that's its own sub-app + its own future round).
//
// Layout matches the legacy DOM verbatim so studio.css applies as-is:
//   .mv-runtime-stats   — 2 rows of Tick/Ops/Last + Units/Threads
//   .mv-runtime-speed   — slider + value label
//   .mv-inspector-controls — Pause / Step / Stop All buttons
//   .mv-inspector-body  — per-unit groups, each with collapse chevron
//                         + Reset + Stop All-Threads buttons, then a
//                         list of mv-cob-thread-row entries.
//
// Live updates: every signal read here also reads runtimeTick so the
// per-tick refresh (4 Hz) re-runs the body's thread-list build and the
// stats block's number formatting.  Per-unit collapse state lives in a
// local signal so toggling takes effect on the next render without
// waiting for the host's throttled publish.

import { signal } from '@preact/signals'
import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { FloatingPanel } from '@coreprime/kbot-ui/floating-panel'
import { panelSignals } from '@coreprime/kbot-ui/panel-store'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'
import { hostBridge } from '/ui/common/host-bridge.js'

const PANEL_ID = 'mv-inspector-scripts'

// Collapsed-unit state — Set of unit IDs the user has folded shut.
// Module-scoped + signal-backed so re-mounts (panel close + reopen
// via View menu) keep the user's choices intact.
const _collapsedUnits = signal(new Set())
function _toggleUnit(id) {
  const next = new Set(_collapsedUnits.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  _collapsedUnits.value = next
}

// _getRuntime — pulls the active runtime off the inspector mv proxy.
// Single-unit tabs expose it via mv.cob.runtime; sandbox tabs use the
// same field (the proxy's cob is wrapped but still carries .runtime).
function _getRuntime(proxy) {
  return (proxy && proxy.cob && proxy.cob.runtime) || (proxy && proxy._runtime) || null
}

// ── Stats block ─────────────────────────────────────────────────────

function StatsBlock({ rt }) {
  // Reading runtimeTick subscribes the block to the per-publish
  // refresh — the stats are non-signal numbers on the runtime object
  // so we need the tick to know when to re-format them.
  void runtimeTick.value
  const tick    = rt ? (rt.tickCount | 0) : 0
  const last    = rt ? (rt.lastTickMs || 0) : 0
  const units   = (rt && rt.unitCount)   ? rt.unitCount()   : 0
  const threads = (rt && rt.threadCount) ? rt.threadCount() : 0
  const inst    = rt ? (rt.lastInstCount | 0) : 0
  return html`
    <div class="mv-runtime-stats" title="Live runtime telemetry — refreshed 4× per second.">
      <div class="mv-runtime-stats-row mv-runtime-stats-row-3">
        <span class="mv-runtime-stat" title="Total fixed sim ticks executed since the runtime started.">
          <span class="mv-runtime-stat-label">Tick</span>
          <span class="mv-runtime-stat-value">${tick}</span>
        </span>
        <span class="mv-runtime-stat" title="COB bytecode operations executed during the most recent tick() call (sums every fixed sub-step the call drained).">
          <span class="mv-runtime-stat-label">Ops</span>
          <span class="mv-runtime-stat-value">${inst}</span>
        </span>
        <span class="mv-runtime-stat" title="Wall-clock duration of the most recent tick() call (may drain several fixed sub-steps).">
          <span class="mv-runtime-stat-label">Last</span>
          <span class="mv-runtime-stat-value">${last.toFixed(1)} ms</span>
        </span>
      </div>
      <div class="mv-runtime-stats-row">
        <span class="mv-runtime-stat" title="Number of units currently registered with the runtime.">
          <span class="mv-runtime-stat-label">Units</span>
          <span class="mv-runtime-stat-value">${units}</span>
        </span>
        <span class="mv-runtime-stat" title="Total live threads across every unit.">
          <span class="mv-runtime-stat-label">Threads</span>
          <span class="mv-runtime-stat-value">${threads}</span>
        </span>
      </div>
    </div>
  `
}

// ── Speed slider ────────────────────────────────────────────────────

function SpeedSlider({ rt }) {
  void runtimeTick.value
  const rate = rt && typeof rt.playbackRate === 'number' ? rt.playbackRate : 1
  const sliderVal = Math.round(rate * 100)  // 1..1000 maps to 0.01..10
  return html`
    <div class="mv-runtime-speed" title="Simulation speed — scales every unit's tick clock.  Mirrors the COB menu's Playback slider.">
      <label class="mv-runtime-speed-label">Speed</label>
      <input type="range" min="1" max="1000" value=${sliderVal} step="1" class="mv-runtime-speed-input"
             title="Drag to slow down or speed up the simulation.  Range 0.01× to 10×; 1.00× = real time.  Hit + / − to step in 10% increments."
             onInput=${(e) => hostBridge.setSimSpeed(parseInt(e.currentTarget.value, 10) / 100)}
             onClick=${(e) => e.stopPropagation()}
             onPointerDown=${(e) => e.stopPropagation()} />
      <span class="mv-runtime-speed-val">${rate.toFixed(2)}×</span>
    </div>
  `
}

// ── Pause / Step / Stop All controls ────────────────────────────────

const _stopProp = (e) => e.stopPropagation()

function ControlsBar({ rt }) {
  void runtimeTick.value
  const paused = !!(rt && rt.paused)
  return html`
    <div class="mv-inspector-controls">
      <button class="mv-runtime-ctrl mv-threads-toggle"
              title=${paused
                ? 'Resume — un-pause the runtime and continue past any breakpoint that fired.  Spacebar does the same thing.'
                : 'Pause — freeze every unit’s animators + threads on this runtime.  Spacebar does the same thing.'}
              onClick=${(e) => { _stopProp(e); hostBridge.toggleRuntimePaused() }}
              onPointerDown=${_stopProp}
              onMouseDown=${_stopProp}>
        ${paused ? '▶ Resume' : '⏸ Pause'}
      </button>
      <button class="mv-runtime-ctrl mv-threads-step"
              title="Step — advance one fixed-rate tick of script time across every unit."
              onClick=${(e) => { _stopProp(e); hostBridge.stepRuntime() }}
              onPointerDown=${_stopProp}
              onMouseDown=${_stopProp}>
        ⤳ Step
      </button>
      <button class="mv-runtime-ctrl mv-threads-stopall mv-runtime-ctrl-danger mv-runtime-ctrl-wide"
              title="Terminate every COB thread on every unit — motion controllers, smoke, idle background scripts, everything.  You'll be asked to confirm."
              onClick=${(e) => { _stopProp(e); hostBridge.stopAllThreads() }}
              onPointerDown=${_stopProp}
              onMouseDown=${_stopProp}>
        ⏹ Terminate All Scripts
      </button>
    </div>
  `
}

// ── Thread + unit-group rows ─────────────────────────────────────────

// _statusText renders the human "Sleeping 1.2s remaining" / "Waiting
// for turn to complete" / "Running" / "killed by signal N" / "Breakpoint"
// string from the per-thread fields.  Matches the legacy renderer's
// wording, with `killed` taking priority over everything (dead thread
// can't sleep) and `breakpointHit` priority over the run-state lines
// (an instruction whose BP fired isn't really "sleeping" or "running" —
// it's halted, waiting for a Resume click).
function _statusText(t, killed) {
  if (killed) return `killed by signal ${t._killedBy}`
  if (t.breakpointHit) return 'Breakpoint'
  if (t.sleepMs > 0) {
    return t.sleepMs >= 1000
      ? `Sleeping ${(t.sleepMs / 1000).toFixed(1)}s remaining`
      : `Sleeping ${t.sleepMs | 0}ms remaining`
  }
  if (t.waitOn) {
    return t.waitOn.type === 'turn'
      ? 'Waiting for turn to complete'
      : 'Waiting for move to complete'
  }
  return 'Running'
}

function ThreadRow({ t, killed, cob, unitId }) {
  // Offset display: the wasm COB adapter ships a flat byte `offset`; the legacy
  // in-JS runtime instead exposes the full instruction list, so derive it from
  // instructions[pc] when there's no flat offset.
  const insts = t.script && t.script.instructions
  const inst = insts ? (insts[t.pc] || insts[insts.length - 1]) : null
  const off = (typeof t.offset === 'number')
    ? `0x${t.offset.toString(16)}`
    : (inst ? `0x${inst.offset.toString(16)}` : '—')
  // The disassembly modal needs the in-JS program; the wasm adapter (unit._wasm)
  // can't source it, so row clicks are inert there (the panel stays read-only).
  const debuggable = cob && cob.unit && !cob.unit._wasm
  // Killing a thread is independent of the modal — the wasm adapter routes
  // killThreadById into the engine, so the per-row kill button shows whenever
  // the adapter can terminate threads, even when the disassembly modal can't.
  const killable = cob && cob.unit && typeof cob.unit.killThreadById === 'function'
  const onRowClick = (e) => {
    if (killed || !debuggable) return
    if (e.target.closest('.mv-cob-thread-kill')) return
    hostBridge.openThreadCodeModal(cob, t)
  }
  const onKill = (e) => {
    e.stopPropagation()
    if (cob && cob.unit && typeof cob.unit.killThreadById === 'function') {
      cob.unit.killThreadById(t.id)
    }
  }
  // Signal-mask chip strip — one chip per set bit, highlighted red
  // when that bit was the one that killed the thread.
  const sigChips = []
  if (t.signalMask !== 0) {
    for (let b = 0; b < 16; b++) {
      const bit = 1 << b
      if (t.signalMask & bit) {
        const cls = killed && (t._killedBy & bit) ? 'mv-sig-bit killed' : 'mv-sig-bit'
        sigChips.push(html`<span class=${cls} key=${b}>${bit}</span>`)
      }
    }
  }
  // Row class:
  //   .killed     — dead thread (terminated, paints red, ignores breakpoint)
  //   .breakpoint — thread halted at a user breakpoint, paints gold so the
  //                 user immediately sees why the runtime is paused even
  //                 when the debugger panel is closed.
  const rowCls = killed
    ? 'mv-cob-thread-row killed'
    : (t.breakpointHit ? 'mv-cob-thread-row breakpoint' : 'mv-cob-thread-row')
  return html`
    <div class=${rowCls}
         data-unit-id=${unitId}
         onClick=${onRowClick}>
      <div class="mv-cob-thread-name">
        <span>${t.script.name}</span>
        <span class="mv-cob-thread-pc">#${t.pc} @ ${off}</span>
        ${(!killed && killable) ? html`
          <button class="mv-cob-thread-kill"
                  title=${`Terminate this ${t.script.name} thread`}
                  onClick=${onKill}
                  onPointerDown=${_stopProp}>🗑</button>
        ` : null}
      </div>
      <div class="mv-cob-thread-detail">status: ${_statusText(t, killed)}</div>
      <div class="mv-cob-thread-detail">
        ${sigChips.length === 0 ? 'signals: —' : html`signals: ${sigChips}`}
      </div>
    </div>
  `
}

function UnitGroup({ unit, cob, hasContent }) {
  const collapsed = _collapsedUnits.value.has(unit.id)
  const n = unit._threads.length
  const name = unit.name || unit.scriptOriginName || ''
  return html`
    <div class=${hasContent ? 'mv-unit-header' : 'mv-unit-header mv-unit-header-empty'}>
      <button class="mv-unit-header-collapse"
              title=${collapsed ? `Expand Unit ${unit.id}` : `Collapse Unit ${unit.id}`}
              onClick=${(e) => { _stopProp(e); _toggleUnit(unit.id) }}>
        ${collapsed ? '+' : '−'}
      </button>
      <span class="mv-unit-header-label">
        ${name ? `Unit ${unit.id} · ${name}` : `Unit ${unit.id}`}
      </span>
      <span class="mv-unit-header-count">${n === 0 ? 'idle' : `${n} thread${n === 1 ? '' : 's'}`}</span>
      <button class="mv-unit-header-action"
              title=${`Reset Unit ${unit.id} — kill its threads, zero static vars, snap every piece back to its rest pose, and re-engage Create gating.`}
              onClick=${(e) => { _stopProp(e); hostBridge.resetUnit(unit, cob) }}>↺</button>
      <button class="mv-unit-header-action danger"
              title=${`Stop every running thread on Unit ${unit.id}.  Animators keep their last pose.`}
              onClick=${(e) => { _stopProp(e); if (typeof unit.killAllThreads === 'function') unit.killAllThreads() }}>⏹</button>
    </div>
  `
}

// ── Threads body ────────────────────────────────────────────────────

function ThreadsBody({ rt }) {
  void runtimeTick.value
  if (!rt) {
    return html`<div class="mv-inspector-empty">No COB loaded.</div>`
  }
  const units = [...rt.units()]
  if (units.length === 0) {
    return html`<div class="mv-inspector-empty">Runtime has no units loaded.</div>`
  }
  // Reading the collapse signal here keeps the body subscribed so a
  // chevron click re-renders the relevant section.
  const collapsed = _collapsedUnits.value
  const sections = []
  let totalShown = 0
  for (const unit of units) {
    const live = unit._threads
    const killed = unit._recentlyKilled || []
    const hasContent = live.length > 0 || killed.length > 0
    const isCollapsed = collapsed.has(unit.id)
    // Build the per-unit cob shape the debugger + Reset + Kill paths
    // consume.  We deliberately DO NOT reuse `mv.value.cob` — that
    // proxy is either the FOCUSED unit's binding (single-select in
    // sandbox; correct for ONE row only) OR a runtime-only stub with
    // `unit: null` (zero / multi-select; null-derefs the debugger).
    // The iteration unit is the CobUnit that actually owns the
    // thread, and CobUnit holds a runtime back-ref, so a flat
    // `{ unit, runtime }` is everything the debugger / Reset / Kill
    // paths read.
    const cob = { unit, runtime: unit.runtime }
    sections.push(html`<${UnitGroup} unit=${unit} cob=${cob} hasContent=${hasContent} key=${`u${unit.id}`} />`)
    if (isCollapsed || !hasContent) continue
    for (const k of killed) {
      // Killed rows mirror the legacy renderer's snapshot shape
      // ({script, pc, signalMask, _killedBy}) — no cob → no debugger
      // modal (snapshot has no live thread to attach to).
      const snap = { script: k.script, pc: k.pc, sleepMs: 0, waitOn: null, signalMask: k.signalMask, _killedBy: k.killedBySignal }
      sections.push(html`
        <${ThreadRow} t=${snap} killed=${true} cob=${null} unitId=${unit.id}
                     key=${`k${unit.id}-${totalShown++}`} />`)
    }
    for (const t of live) {
      sections.push(html`
        <${ThreadRow} t=${t} killed=${false} cob=${cob} unitId=${unit.id}
                     key=${`t${unit.id}-${t.id}`} />`)
      totalShown++
    }
  }
  if (totalShown === 0) {
    sections.push(html`<div class="mv-inspector-empty" key="all-idle">No active threads on any unit.</div>`)
  }
  return sections
}

// ── Panel root ──────────────────────────────────────────────────────

export function RuntimePanel() {
  const { visible } = panelSignals(PANEL_ID)
  void visible.value
  void runtimeTick.value
  const proxy = mv.value
  const rt = _getRuntime(proxy)
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Runtime">
      <${StatsBlock} rt=${rt} />
      <${SpeedSlider} rt=${rt} />
      <${ControlsBar} rt=${rt} />
      <div class="mv-inspector-body">
        ${visible.value ? html`<${ThreadsBody} rt=${rt} />` : null}
      </div>
    <//>
  `
}
