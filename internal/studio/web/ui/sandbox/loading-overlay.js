// loading-overlay.js
//
// The sandbox launch loading screen: a centred modal overlay shown while a
// battlefield preloads (terrain, the faction leader, its buildable units),
// draped with the game's own loading-screen art — TA's classic "LOADING…"
// panel, TA:Kingdoms' gothic stained-glass window — behind a live progress
// bar and phase label. Driven by a signal so the launch path (tab.js) can
// show it, push progress through the preload, and dismiss it on completion.
//
// Body-mounted (mount.js) at a z-index above the floating panels so it
// covers the partially-initialised 3D canvas during setup. Modal: no close
// button — it clears itself when the field is ready (or after surfacing a
// setup error).

import { signal } from '@preact/signals'
import { htm as html } from '@kbot/ui/htm-bind'
import { activeGame } from '../common/game-registry.js'

const wsBase = () => (typeof window !== 'undefined' && window.__WS_BASE__) || ''

// _state: null when hidden, else { frac, label, title, sub, art, error }.
const _state = signal(null)

// _MIN_VISIBLE_MS keeps the overlay up long enough to read even when a
// battlefield preloads almost instantly (The Grid), so it doesn't flash.
const _MIN_VISIBLE_MS = 550
let _shownAt = 0

// showLoadingOverlay raises the overlay for a fresh launch. title/sub label
// the battlefield + faction; the art URL is the session game's load screen.
export function showLoadingOverlay({ title = 'Preparing the battlefield', sub = '' } = {}) {
  _shownAt = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  _state.value = {
    frac: 0,
    label: 'Starting up…',
    title,
    sub,
    art: `${wsBase()}/api/studio/sandbox-loadscreen`,
    error: null,
  }
}

// setLoadingProgress advances the bar. frac is 0..1; label names the phase.
export function setLoadingProgress(frac, label) {
  const cur = _state.value
  if (!cur) return
  const f = Math.max(cur.frac, Math.max(0, Math.min(1, frac))) // never regress
  _state.value = { ...cur, frac: f, label: label != null ? label : cur.label }
}

// loadingError surfaces a setup failure in the overlay, then auto-dismisses
// after a beat so the user isn't stranded on a frozen bar.
export function loadingError(message) {
  const cur = _state.value
  if (!cur) return
  _state.value = { ...cur, error: String(message || 'Setup failed'), label: 'Setup failed' }
  setTimeout(() => { _state.value = null }, 2600)
}

// hideLoadingOverlay finishes the bar and clears the overlay, honouring the
// minimum-visible dwell so a fast load still reads.
export function hideLoadingOverlay() {
  const cur = _state.value
  if (!cur || cur.error) return
  _state.value = { ...cur, frac: 1, label: 'Ready.' }
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const wait = Math.max(220, _MIN_VISIBLE_MS - (now - _shownAt))
  setTimeout(() => {
    // Only clear if no newer launch replaced our state in the meantime.
    if (_state.value && _state.value.frac >= 1 && !_state.value.error) _state.value = null
  }, wait)
}

export function SandboxLoadingOverlay() {
  const st = _state.value
  if (!st) return null
  const pct = Math.round(st.frac * 100)
  const game = activeGame()
  return html`
    <div class="sandbox-loading" data-game=${game?.id || 'totala'}>
      <div class="slo-card">
        <img class="slo-art" alt="" src=${st.art}
             onError=${(e) => { e.currentTarget.style.display = 'none' }} />
        <div class="slo-scrim"></div>
        <div class="slo-body">
          <div class="slo-title">${st.title}</div>
          ${st.sub ? html`<div class="slo-sub">${st.sub}</div>` : null}
          <div class="slo-bar" role="progressbar" aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100">
            <div class="slo-bar-fill" style=${`width:${pct}%`}></div>
          </div>
          <div class=${`slo-phase${st.error ? ' slo-phase-error' : ''}`}>
            <span class="slo-phase-label">${st.error || st.label}</span>
            <span class="slo-phase-pct">${pct}%</span>
          </div>
        </div>
      </div>
    </div>
  `
}
