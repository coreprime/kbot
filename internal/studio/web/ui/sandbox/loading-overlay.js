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
import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { activeGame } from '../common/game-registry.js'

const wsBase = () => (typeof window !== 'undefined' && window.__WS_BASE__) || ''

// _state: null when hidden, else { frac, label, title, sub, art, error }.
const _state = signal(null)

// The classic loading readout: a fixed list of load categories that light up
// in sequence as the launch progresses, echoing the game's own sequential
// "now loading X" screen. Each entry's `to` is the global progress fraction at
// which that category is considered complete — so a section is DONE below its
// own threshold's predecessor, ACTIVE while the bar is inside its band, and
// PENDING beyond it. The bands roughly track the preload's real phase order
// (terrain → side/graphics → leader → the whole build tree → finish).
const SECTIONS = {
  totala: [
    { key: 'gaf', name: 'Graphics', to: 0.14 },
    { key: 'map', name: 'Maps', to: 0.42 },
    { key: 'weap', name: 'Weapons', to: 0.52 },
    { key: 'unit', name: 'Units', to: 0.72 },
    { key: 'obj', name: '3D Objects', to: 0.9 },
    { key: 'snd', name: 'Sound', to: 1.0 },
  ],
  takingdoms: [
    { key: 'gaf', name: 'Artwork', to: 0.14 },
    { key: 'map', name: 'Realms', to: 0.42 },
    { key: 'spell', name: 'Spells', to: 0.52 },
    { key: 'unit', name: 'Creatures', to: 0.72 },
    { key: 'obj', name: '3D Models', to: 0.9 },
    { key: 'snd', name: 'Sound', to: 1.0 },
  ],
}

// sectionsFor resolves the readout for a game id (TA by default) and tags each
// entry with its live state from the current progress fraction.
function sectionsFor(gameId, frac) {
  const list = SECTIONS[gameId] || SECTIONS.totala
  let prevTo = 0
  return list.map((s) => {
    let state = 'pending'
    if (frac >= s.to) state = 'done'
    else if (frac >= prevTo) state = 'active'
    prevTo = s.to
    return { ...s, state }
  })
}

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
  const gameId = game?.id || 'totala'
  // The sequential category readout freezes on error so the failed frame is
  // legible; otherwise it tracks the live progress fraction.
  const sections = st.error ? [] : sectionsFor(gameId, st.frac)
  return html`
    <div class="sandbox-loading" data-game=${gameId}>
      <div class="slo-card">
        <img class="slo-art" alt="" src=${st.art}
             onError=${(e) => { e.currentTarget.style.display = 'none' }} />
        <div class="slo-scrim"></div>
        <div class="slo-body">
          <div class="slo-title">${st.title}</div>
          ${st.sub ? html`<div class="slo-sub">${st.sub}</div>` : null}
          ${sections.length ? html`
            <ul class="slo-sections">
              ${sections.map((s) => html`
                <li key=${s.key} class=${`slo-section slo-section-${s.state}`}>
                  <span class="slo-section-tick">${s.state === 'done' ? '✓' : s.state === 'active' ? '▸' : '·'}</span>
                  <span class="slo-section-name">${s.name}</span>
                </li>
              `)}
            </ul>
          ` : null}
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
