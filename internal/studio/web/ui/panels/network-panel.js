// network-panel.js
//
// React-rendered Network / Sync overlay for a joined sandbox.  Surfaces the
// transport telemetry the WsFrameSource tracks (mv.net, built each publish from
// scene.netStats()): current tick + hash, the estimated server clock, the
// latest round-trip latency, cumulative byte/message counters, how long since
// the client's local hash last matched the authority, and rolling in/out
// bandwidth graphs over the last five minutes.  A severe-desync flag (a
// confirmed hash mismatch or a multi-second gap with no verified sync) paints
// the Last Sync row as a warning, a Force Sync button re-pulls the authority's
// full snapshot (discarding local work), and a Diagnose button — enabled only
// while out of sync — fetches a read-only authoritative snapshot and opens a
// per-field drift comparison without disturbing local prediction.
//
// Offline sandbox (no authority) has no net stats, so the body shows an
// "offline" message and hides the sync controls.  Like the other inspectors the
// heavy read bails when the panel is hidden so the 4 Hz refresh stays cheap when
// the panel is closed.

import { useState, useCallback } from 'preact/hooks'
import { signal } from '@preact/signals'
import { htm as html } from '@kbot/ui/htm-bind'
import { FloatingPanel } from '@kbot/ui/floating-panel'
import { AccordionSection } from '@kbot/ui/accordion-section'
import { FloatingPanelTabStrip } from '@kbot/ui/floating-panel-tab-strip'
import { panelSignals } from '@kbot/ui/panel-store'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'
import { hostBridge } from '/ui/common/host-bridge.js'

const PANEL_ID = 'mv-inspector-network'
// The Sync Diagnostics drift comparison rides in its own floating panel so it
// inherits the standard inspector chrome (drag, resize, persisted geometry)
// rather than the old hand-rolled modal backdrop.
const DIAG_PANEL_ID = 'mv-inspector-sync-diag'

// Diagnose result state lives at module scope so the floating diagnostics panel
// can mount as a stage-root sibling of the Network panel (via SyncDiagnosticsPanel
// + mount.js) instead of nesting inside the Network panel's body.  Nesting it as
// a child of NetworkBody made its position:absolute chrome anchor to — and get
// clipped by — the little Network panel, so the diagnostics panel rendered off
// in nowhere and read as "does nothing".  The Network panel's Diagnose button
// writes this signal; the separately-mounted panel reads it and renders when
// non-null.  Shape: { loading } | { result } | { error } | null (closed).
const diagState = signal(null)

// runDiagnose captures a fresh point-in-time comparison: it flips diagState to
// loading, fires the authority snapshot request, and resolves into result/error.
// Shared by the Network panel's Diagnose button and the diagnostics panel's
// header Refresh action so both re-capture identically.
function runDiagnose() {
  diagState.value = { loading: true }
  Promise.resolve(hostBridge.diagnose())
    .then((result) => { diagState.value = { loading: false, result } })
    .catch((err) => { diagState.value = { loading: false, error: (err && err.message) || String(err) } })
}

const _stopProp = (e) => e.stopPropagation()

// _bytes renders a byte count in the largest unit that keeps it readable.
function _bytes(n) {
  const v = n | 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / (1024 * 1024)).toFixed(2)} MB`
}

// _rate renders a per-second byte throughput (bytes-in-an-interval scaled to a
// 1s window) in the largest readable unit.
function _rate(bytesPerSec) {
  const v = Math.max(0, bytesPerSec | 0)
  if (v < 1024) return `${v} B/s`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB/s`
  return `${(v / (1024 * 1024)).toFixed(2)} MB/s`
}

// _lastSync renders the gap since the last verified hash match as a tick delta
// converted to seconds (e.g. "12 ticks · 0.3s ago"), or an em-dash before the
// first verified sync. Tick-based so a paused game shows a frozen age instead
// of an ever-growing wall-clock value.
function _lastSync(ticks, sec) {
  if (ticks === null || ticks === undefined) return '—'
  return `${ticks} ticks · ${(sec || 0).toFixed(1)}s ago`
}

// _serverClock formats the estimated server wall time as HH:MM:SS, or an
// em-dash before the first pong lands.
function _serverClock(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function _stat(label, value, title) {
  return html`
    <span class="mv-runtime-stat" title=${title}>
      <span class="mv-runtime-stat-label">${label}</span>
      <span class="mv-runtime-stat-value">${value}</span>
    </span>
  `
}

// Sparkline renders a fixed-size SVG area/line plot of the given numeric series,
// scaled to its own peak. An empty/flat series draws a baseline. Used for the
// in/out bandwidth graphs.
function Sparkline({ values, color }) {
  const W = 150
  const H = 36
  const n = values.length
  const peak = values.reduce((m, v) => (v > m ? v : m), 0)
  if (n === 0 || peak <= 0) {
    return html`
      <svg class="mv-net-spark" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <line x1="0" y1=${H - 1} x2=${W} y2=${H - 1} stroke=${color} stroke-opacity="0.35" />
      </svg>
    `
  }
  const dx = n > 1 ? W / (n - 1) : W
  const pts = values.map((v, i) => {
    const x = i * dx
    const y = H - 1 - (v / peak) * (H - 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = `M${pts.join(' L')}`
  const area = `M0,${H - 1} L${pts.join(' L')} L${((n - 1) * dx).toFixed(1)},${H - 1} Z`
  return html`
    <svg class="mv-net-spark" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d=${area} fill=${color} fill-opacity="0.18" stroke="none" />
      <path d=${line} fill="none" stroke=${color} stroke-width="1.5" />
    </svg>
  `
}

// BandwidthGraph shows one direction's per-second throughput over the rolling
// window, with the current and peak rates labelled.
function BandwidthGraph({ label, series, color, title }) {
  const cur = series.length ? series[series.length - 1] : 0
  const peak = series.reduce((m, v) => (v > m ? v : m), 0)
  return html`
    <div class="mv-net-bw" title=${title}>
      <div class="mv-net-bw-label" style=${`color:${color}`}>${label}</div>
      <div class="mv-net-bw-vals">
        <span class="mv-net-bw-cur">${_rate(cur)}</span>
        <span class="mv-net-bw-peak">peak ${_rate(peak)}</span>
      </div>
      <${Sparkline} values=${series} color=${color} />
    </div>
  `
}

// ── Drift comparison ──────────────────────────────────────────────────
//
// The Diagnose popup diffs the client's predicted state against an on-demand
// authoritative snapshot.  Fields flagged `hashed` are the ones the desync
// digest actually covers, so a drift there explains a hash mismatch; the rest
// are shown for context (a predicting client legitimately leads the server, so
// some non-hashed drift is expected).

const UNIT_FIELDS = [
  ['Pos X', 'x', true],
  ['Pos Y', 'y', true],
  ['Pos Z', 'z', true],
  ['Heading', 'heading', true],
  ['Health', 'health', true],
  ['Dead', 'dead', true],
  ['Speed', 'speed', false],
  ['Has Move', 'hasMove', false],
  ['Move TX', 'tx', false],
  ['Move TZ', 'tz', false],
  ['Has Attack', 'hasAttack', false],
  ['Attack Target', 'attackTarget', false],
]

const PROJ_FIELDS = [
  ['Model', 'model', false],
  ['Weapon', 'weapon', false],
  ['Mode', 'mode', false],
  ['Phase', 'phase', false],
  ['Pos X', 'x', false],
  ['Pos Y', 'y', false],
  ['Pos Z', 'z', false],
  ['Vel X', 'vx', false],
  ['Vel Y', 'vy', false],
  ['Vel Z', 'vz', false],
  ['Heading', 'heading', false],
  ['Pitch', 'pitch', false],
  ['Speed', 'speed', false],
  ['Age', 'ageSec', false],
  ['Life', 'lifeSec', false],
  ['From Piece', 'fromPiece', false],
]

function _indexById(arr) {
  const m = new Map()
  for (const x of arr || []) m.set(x.id, x)
  return m
}

// _fmt renders a comparison cell value compactly: booleans as yes/—, missing as
// an em-dash, large fixed-point numbers as plain integers.
function _fmt(v) {
  if (v === undefined || v === null) return '—'
  if (v === true) return 'yes'
  if (v === false) return '—'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  return String(v)
}

function _eq(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return a === b
}

// _diffRows builds the per-field rows for one entity pair (server vs client),
// dropping equal rows when diffOnly is set. Returns { rows, anyDiff }.
function _diffRows(fields, srv, cli, diffOnly) {
  const rows = []
  let anyDiff = false
  for (const [label, key, hashed] of fields) {
    const s = srv ? srv[key] : undefined
    const c = cli ? cli[key] : undefined
    const differs = !_eq(s, c)
    if (differs) anyDiff = true
    if (diffOnly && !differs) continue
    rows.push({ label, key, hashed, s, c, differs })
  }
  return { rows, anyDiff }
}

// _buildGroups pairs entities by id across both snapshots and computes their
// field diffs. Entities present on only one side are still listed (the missing
// side shows em-dashes) since their very absence is the most important drift.
function _buildGroups(fields, srvArr, cliArr, diffOnly) {
  const srv = _indexById(srvArr)
  const cli = _indexById(cliArr)
  const ids = new Set([...srv.keys(), ...cli.keys()])
  const groups = []
  for (const id of [...ids].sort((a, b) => a - b)) {
    const s = srv.get(id)
    const c = cli.get(id)
    const onlyOne = !s || !c
    const { rows, anyDiff } = _diffRows(fields, s, c, diffOnly && !onlyOne)
    const differs = anyDiff || onlyOne
    if (diffOnly && !differs) continue
    groups.push({
      id,
      name: (s && s.name) || (c && c.name) || (s && s.model) || (c && c.model) || '',
      onlyOne,
      missingSide: !s ? 'server' : (!c ? 'client' : null),
      rows,
      differs,
    })
  }
  return groups
}

// _syncStats counts, for one entity category, how many of the authority's
// items the client matches exactly (every field in agreement) against the total
// the server reports — the "X/Y" a section header surfaces so the user can see
// at a glance how much of the world is in sync.
function _syncStats(fields, srvArr, cliArr) {
  const cli = _indexById(cliArr)
  const total = (srvArr || []).length
  let synced = 0
  for (const s of srvArr || []) {
    const c = cli.get(s.id)
    if (!c) continue
    const { anyDiff } = _diffRows(fields, s, c, false)
    if (!anyDiff) synced++
  }
  return { synced, total }
}

function DriftTable({ groups, kind }) {
  if (groups.length === 0) {
    return html`<div class="mv-net-diff-empty">No differences in this category.</div>`
  }
  // Hover over a group highlights its object on the renderer so the user can
  // locate it in the scene; leaving clears the highlight. Units route through
  // the unit-id channel, projectiles through the projectile-id channel.
  const onEnter = (id) => () => hostBridge.highlightEntities(
    kind === 'unit' ? [id] : [],
    kind === 'proj' ? [id] : [],
  )
  const onLeave = () => hostBridge.highlightEntities([], [])
  return html`
    <div class="mv-net-diff-list">
      ${groups.map((g) => html`
        <div class="mv-net-diff-acc" key=${g.id}
             onMouseEnter=${onEnter(g.id)} onMouseLeave=${onLeave}>
          <${AccordionSection}
            id=${`sync-diag-${kind}-${g.id}`}
            defaultOpen=${g.differs}
            count=${g.differs ? (g.missingSide ? g.missingSide : g.rows.filter((r) => r.differs).length || null) : null}
            title=${html`
              <span class=${`mv-net-diff-title${g.differs ? ' is-diff' : ''}`}>
                <span class="mv-net-diff-id">#${g.id}</span>
                <span class="mv-net-diff-name">${g.name}</span>
                ${g.missingSide ? html`<span class="mv-net-diff-missing">missing on ${g.missingSide}</span>` : null}
              </span>
            `}>
            ${g.rows.length ? html`
              <table class="mv-net-diff-table">
                <thead>
                  <tr><th>Field</th><th>Server</th><th>Client</th></tr>
                </thead>
                <tbody>
                  ${g.rows.map((r) => html`
                    <tr class=${r.differs ? 'is-diff' : ''} key=${r.key}>
                      <td>${r.label}${r.hashed ? html`<span class="mv-net-diff-hashed" title="Part of the desync hash — drift here causes a confirmed desync.">#</span>` : null}</td>
                      <td>${_fmt(r.s)}</td>
                      <td>${_fmt(r.c)}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            ` : html`<div class="mv-net-diff-empty">No field differences.</div>`}
          <//>
        </div>
      `)}
    </div>
  `
}

function DiagnoseModal({ result, error, loading, onClose }) {
  const [tab, setTab] = useState('units')
  const [diffOnly, setDiffOnly] = useState(true)

  const srv = result && result.server
  const cli = result && result.client
  const unitGroups = (srv && cli) ? _buildGroups(UNIT_FIELDS, srv.units, cli.units, diffOnly) : []
  const projGroups = (srv && cli) ? _buildGroups(PROJ_FIELDS, srv.projectiles, cli.projectiles, diffOnly) : []
  // X/Y per section — synced (fully-matching) items over the authority total.
  const unitStat = (srv && cli) ? _syncStats(UNIT_FIELDS, srv.units, cli.units) : { synced: 0, total: 0 }
  const projStat = (srv && cli) ? _syncStats(PROJ_FIELDS, srv.projectiles, cli.projectiles) : { synced: 0, total: 0 }

  const tabs = [
    { id: 'summary', label: 'Summary' },
    { id: 'units', label: `Units ${unitStat.synced}/${unitStat.total}` },
    { id: 'projectiles', label: `Projectiles ${projStat.synced}/${projStat.total}` },
  ]

  let body
  if (loading) {
    body = html`<div class="mv-net-diff-empty">Fetching authoritative snapshot…</div>`
  } else if (error) {
    body = html`<div class="mv-net-diff-empty mv-net-diff-error">Diagnose failed: ${error}</div>`
  } else if (!srv || !cli) {
    body = html`<div class="mv-net-diff-empty">No snapshot data.</div>`
  } else if (tab === 'summary') {
    const hashMatch = String(srv.hash) === String(cli.hash)
    body = html`
      <div class="mv-net-diff-summary">
        <table class="mv-net-diff-table">
          <thead><tr><th>Field</th><th>Server</th><th>Client</th></tr></thead>
          <tbody>
            <tr class=${srv.tick !== cli.tick ? 'is-diff' : ''}><td>Tick</td><td>${srv.tick}</td><td>${cli.tick}</td></tr>
            <tr class=${hashMatch ? '' : 'is-diff'}><td>Hash</td><td>${String(srv.hash)}</td><td>${String(cli.hash)}</td></tr>
            <tr><td>Units</td><td>${(srv.units || []).length}</td><td>${(cli.units || []).length}</td></tr>
            <tr><td>Projectiles</td><td>${(srv.projectiles || []).length}</td><td>${(cli.projectiles || []).length}</td></tr>
          </tbody>
        </table>
        <p class="mv-net-diff-note">
          The client leads the server by its prediction window, so a tick gap
          (and the non-hashed drift it implies) is normal. Fields marked
          <span class="mv-net-diff-hashed">#</span> feed the desync hash — drift
          there is what a confirmed desync is made of.
        </p>
      </div>
    `
  } else if (tab === 'units') {
    body = html`<${DriftTable} groups=${unitGroups} kind="unit" />`
  } else {
    body = html`<${DriftTable} groups=${projGroups} kind="proj" />`
  }

  const headerActions = html`
    <button class="mv-net-diag-refresh"
            title="Refresh — re-capture a fresh point-in-time comparison against the authority's current state."
            disabled=${!!loading}
            onClick=${(e) => { _stopProp(e); runDiagnose() }}
            onMouseDown=${_stopProp} onPointerDown=${_stopProp}>
      ↻
    </button>
    <label class="mv-net-diffonly" title="Hide rows and entities that match the authority."
           onMouseDown=${_stopProp} onPointerDown=${_stopProp}>
      <input type="checkbox" checked=${diffOnly}
             onChange=${(e) => { _stopProp(e); setDiffOnly(!!e.target.checked) }} />
      Diffs only
    </label>
  `

  return html`
    <${FloatingPanel}
      id=${DIAG_PANEL_ID}
      title="Sync Diagnostics"
      onClose=${onClose}
      resizable=${true}
      defaultSize=${{ width: 420, height: 460 }}
      minSize=${{ width: 320, height: 220 }}
      headerActions=${headerActions}>
      <div class="mv-net-diag">
        <${FloatingPanelTabStrip} tabs=${tabs} active=${tab} onSelect=${setTab} />
        <div class="mv-net-diag-body">${body}</div>
      </div>
    <//>
  `
}

function NetworkBody() {
  const { visible } = panelSignals(PANEL_ID)
  // Subscribe to the per-publish refresh: mv.net is a plain snapshot rebuilt
  // each 4 Hz publish, so reading runtimeTick keeps the live ages/counters
  // moving even when the mv reference itself is reused.
  void runtimeTick.value

  // The diagnose result drives the separately-mounted SyncDiagnosticsPanel; we
  // only write the shared signal here (loading → result/error) so the panel can
  // live at the stage root rather than nested inside this body.
  const onDiagnose = useCallback((e) => {
    _stopProp(e)
    runDiagnose()
  }, [])

  if (!visible.value) return null
  const net = mv.value && mv.value.net
  if (!net) {
    return html`<div class="mv-inspector-empty">Offline sandbox — no authority to sync with.</div>`
  }
  if (!net.joined) {
    return html`<div class="mv-inspector-empty">Connecting to authority…</div>`
  }
  const latency = net.latencyMs === null ? '—' : `${net.latencyMs} ms`
  const hash = net.hash ? String(net.hash) : '—'
  const srvHash = net.serverHash ? String(net.serverHash) : '—'
  const syncCls = net.severeDesync
    ? 'mv-runtime-stat mv-runtime-stat-warn'
    : 'mv-runtime-stat'
  const bw = net.bandwidth || { samples: [], intervalMs: 1000 }
  const outSeries = (bw.samples || []).map((s) => s.sent)
  const inSeries = (bw.samples || []).map((s) => s.recv)
  const diagLoading = !!(diagState.value && diagState.value.loading)
  // Diagnose is always available while joined — it is a point-in-time snapshot
  // taken at the moment the button is pressed, useful for inspecting drift even
  // when the hashes currently agree (a predicting client legitimately leads the
  // server, so transient health/dead differences around a death are expected).
  const canDiagnose = !net.diagnosing && !diagLoading
  return html`
    <div class="mv-runtime-stats" title="Live network + sync telemetry — refreshed 4× per second.">
      <div class="mv-runtime-stats-row">
        ${_stat('Server Tick', net.serverTick | 0, 'Authoritative tick the host has reached (estimated between beacons). Every window agrees on this.')}
        ${_stat('Client Tick', net.clientTick | 0, 'Local prediction tick this client has stepped to — leads the server by its prediction window, and a pause re-pulls to make them match.')}
      </div>
      <div class="mv-runtime-stats-row">
        ${_stat('Server', _serverClock(net.serverTimeMs), 'Authority wall clock, estimated from the latest pong plus elapsed time.')}
        ${_stat('Latency', latency, 'Last measured round-trip to the authority (one ping per second, paced by completion).')}
      </div>
      <div class="mv-runtime-stats-row">
        ${_stat('Hash', hash, 'Local world hash at the current tick.')}
        ${_stat('Srv Hash', srvHash, `Latest authoritative hash observed (tick ${net.serverHashTick | 0}).`)}
      </div>
      <div class="mv-runtime-stats-row">
        ${_stat('Sent', `${net.msgsSent | 0} · ${_bytes(net.bytesSent)}`, 'Total client messages and bytes sent to the authority.')}
        ${_stat('Recv', `${net.msgsRecv | 0} · ${_bytes(net.bytesRecv)}`, 'Total server messages and bytes received from the authority.')}
      </div>
      <div class="mv-runtime-stats-row">
        <span class=${syncCls} title="How many ticks since the local hash last matched the authority, shown as a tick count converted to seconds at the sim rate.  Turns to a warning on a confirmed desync or a long gap with no verified sync.">
          <span class="mv-runtime-stat-label">${net.severeDesync ? '⚠ Last Sync' : 'Last Sync'}</span>
          <span class="mv-runtime-stat-value">${_lastSync(net.lastSyncTicksAgo, net.lastSyncAgoSec)}</span>
        </span>
      </div>
    </div>
    <div class="mv-net-bw-graphs">
      <${BandwidthGraph} label="Incoming" series=${inSeries} color="#4caf82"
        title="Bytes received from the authority per second over the last 5 minutes." />
      <${BandwidthGraph} label="Outgoing" series=${outSeries} color="#5b9bd5"
        title="Bytes sent to the authority per second over the last 5 minutes." />
    </div>
    <div class="mv-inspector-controls">
      <button class="mv-runtime-ctrl mv-runtime-ctrl-danger"
              title="Force Sync — discard the client's local work and re-pull the authority's full state.  Use when the window has fallen out of sync."
              onClick=${(e) => { _stopProp(e); hostBridge.forceSync() }}
              onPointerDown=${_stopProp}
              onMouseDown=${_stopProp}>
        ↻ Force Sync
      </button>
      <button class="mv-runtime-ctrl"
              disabled=${!canDiagnose}
              title=${'Diagnose — capture a point-in-time authoritative snapshot and compare it field-by-field with this window, without disturbing prediction.'}
              onClick=${onDiagnose}
              onPointerDown=${_stopProp}
              onMouseDown=${_stopProp}>
        ⚖ Diagnose
      </button>
    </div>
  `
}

export function NetworkPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Network">
      <${NetworkBody} />
    <//>
  `
}

// SyncDiagnosticsPanel — the floating drift comparison, mounted at the stage
// root (see mount.js) as a sibling of the Network panel rather than nested in
// its body.  Renders nothing until the Network panel's Diagnose button writes
// diagState; closing clears the signal so the panel unmounts cleanly.
export function SyncDiagnosticsPanel() {
  const state = diagState.value
  if (!state) return null
  const onClose = () => { diagState.value = null }
  return html`<${DiagnoseModal} ...${state} onClose=${onClose} />`
}
