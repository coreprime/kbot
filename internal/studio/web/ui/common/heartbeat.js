// heartbeat.js
//
// Server heartbeat poller.  Polls /api/studio/heartbeat to detect
// when the `kbot studio` CLI has been killed (or hit a deeper
// error).  Two consecutive failures flip the UI into a
// "disconnected" state — an orange card in the bottom-right and a
// translucent overlay that swallows clicks so the user doesn't try
// to edit against a dead backend.  Subsequent successful pings
// dismiss both immediately.
//
// Two cadences: idle polls slowly when everything's fine, then the
// moment we detect a drop switch to a faster retry rate so the
// reconnect feels snappy and the user knows the page is actively
// trying.  Both cadences come from state.settings (Settings
// dialog) so the user can tune them; the defaults match the
// original hardcoded constants.

import { state, $ } from '../host-context.js'

const HEARTBEAT_TIMEOUT_OK_MS = 4000
const HEARTBEAT_TIMEOUT_RETRY_MS = 1500
const DISCONNECT_THRESHOLD = 2 // consecutive failures before showing "disconnected"

let heartbeatState = 'connecting' // 'connecting' | 'connected' | 'disconnected'
let heartbeatFailures = 0
let heartbeatTimer = null
// Monotonically increases each time the status card is shown; the
// retry-counter UI reads this to display "retry N…" while the
// server is down so the user can see we're actually polling.
let heartbeatRetryCount = 0

export function startServerHeartbeat() {
  // The first ping fires immediately so we know about a dead
  // server before the user takes any action.
  pingHeartbeat()
}

// isConnected returns the current heartbeat state for read-only
// consumers like the React ribbon's connectivity dot.  The
// monolithic studio.js used to inline `heartbeatState !==
// 'disconnected'`; this accessor keeps the same semantics without
// exporting the mutable string.
export function isConnected() { return heartbeatState !== 'disconnected' }

function scheduleNextHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer)
  const idle = state.settings?.heartbeatIdleMs ?? 5000
  const retry = state.settings?.heartbeatReconnectMs ?? 1000
  const delay = heartbeatState === 'disconnected' ? retry : idle
  heartbeatTimer = setTimeout(pingHeartbeat, delay)
}

async function pingHeartbeat() {
  const ctrl = new AbortController()
  const timeoutMs = heartbeatState === 'disconnected' ? HEARTBEAT_TIMEOUT_RETRY_MS : HEARTBEAT_TIMEOUT_OK_MS
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let ok
  try {
    const resp = await fetch('/api/studio/heartbeat', {
      cache: 'no-store',
      signal: ctrl.signal,
    })
    ok = resp.ok
  } catch { ok = false }
  clearTimeout(timer)
  if (ok) {
    heartbeatFailures = 0
    if (heartbeatState !== 'connected') {
      heartbeatState = 'connected'
      heartbeatRetryCount = 0
      applyConnectionUI()
    }
  } else {
    heartbeatFailures++
    if (heartbeatFailures >= DISCONNECT_THRESHOLD && heartbeatState !== 'disconnected') {
      heartbeatState = 'disconnected'
      heartbeatRetryCount = 0
      applyConnectionUI()
    }
    if (heartbeatState === 'disconnected') {
      heartbeatRetryCount++
      const detail = document.querySelector('#connection-detail')
      if (detail) detail.textContent = `Reconnecting… (try ${heartbeatRetryCount})`
    }
  }
  scheduleNextHeartbeat()
}

function applyConnectionUI() {
  const card = $('#connection-card')
  const overlay = $('#disconnect-overlay')
  if (!card || !overlay) return
  const offline = heartbeatState === 'disconnected'
  card.classList.toggle('hidden', !offline)
  overlay.classList.toggle('hidden', !offline)
  if (!offline) {
    const detail = document.querySelector('#connection-detail')
    if (detail) detail.textContent = 'Reconnecting…'
  }
}
