// network-panel.js
//
// React-rendered Network / Sync overlay for a joined sandbox.  Surfaces the
// transport telemetry the WsFrameSource tracks (mv.net, built each publish from
// scene.netStats()): current tick + hash, the estimated server clock, the
// latest round-trip latency, cumulative byte/message counters, and how long
// since the client's local hash last matched the authority.  A severe-desync
// flag (a confirmed hash mismatch or a multi-second gap with no verified sync)
// paints the Last Sync row as a warning, and a Force Sync button re-pulls the
// authority's full snapshot, discarding local work.
//
// Offline sandbox (no authority) has no net stats, so the body shows an
// "offline" message and hides the Force Sync control.  Like the other
// inspectors the heavy read bails when the panel is hidden so the 4 Hz refresh
// stays cheap when the panel is closed.

import { htm as html } from '/ui/common/htm-bind.js'
import { FloatingPanel } from '/ui/common/floating-panel.js'
import { panelSignals } from '/ui/common/panel-store.js'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'
import { hostBridge } from '/ui/common/host-bridge.js'

const PANEL_ID = 'mv-inspector-network'

const _stopProp = (e) => e.stopPropagation()

// _bytes renders a byte count in the largest unit that keeps it readable.
function _bytes(n) {
  const v = n | 0
  if (v < 1024) return `${v} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${(v / (1024 * 1024)).toFixed(2)} MB`
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

function NetworkBody() {
  const { visible } = panelSignals(PANEL_ID)
  // Subscribe to the per-publish refresh: mv.net is a plain snapshot rebuilt
  // each 4 Hz publish, so reading runtimeTick keeps the live ages/counters
  // moving even when the mv reference itself is reused.
  void runtimeTick.value
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
    <div class="mv-inspector-controls">
      <button class="mv-runtime-ctrl mv-runtime-ctrl-danger mv-runtime-ctrl-wide"
              title="Force Sync — discard the client's local work and re-pull the authority's full state.  Use when the window has fallen out of sync."
              onClick=${(e) => { _stopProp(e); hostBridge.forceSync() }}
              onPointerDown=${_stopProp}
              onMouseDown=${_stopProp}>
        ↻ Force Sync
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
