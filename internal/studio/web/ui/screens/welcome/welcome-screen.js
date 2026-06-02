// welcome-screen.js
//
// React-rendered Welcome screen body.  Owns the title, the workflow
// tab strip (Sandbox Mode / Map Creator / Unit Creator / Scripting /
// Other), and each tab's card content.  The host (studio.js) renders
// this component into the dialog card SLOT inside #welcome-dialog;
// the surrounding chrome (the glamour cross-fade layer, the NanoFX
// canvas, the buildup-audio cue) stays as static markup + leaf-level
// imperative wiring because none of it depends on tab switching.
//
// Tab state lives in a local signal so a tab click takes effect
// without a host round-trip.  Each card fires a host callback (passed
// via props) — onNewMap, onOpenMap, onOpenUnit, onOpenSandbox — so
// the screen doesn't reach into studio.js's globals to do its work.
// Cards with no live host wiring yet (Load Sandbox, New Unit, every
// Scripting card, the HPI/TNT upload button) are rendered `disabled`
// so the user sees the planned surface area without thinking the
// click did nothing.

import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { htm as html } from '@kbot/ui/htm-bind'

// _hostWsUrl builds a websocket URL onto the in-process game host
// (mounted at /host/ws on the same origin the studio is served from).
// `params` becomes the query string — `match` selects/creates the
// match, and `name`/`kind` tag a freshly-created one for the listing.
function _hostWsUrl(params) {
  const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:'
  const host = (typeof location !== 'undefined' && location.host) ? location.host : 'localhost'
  const qs = new URLSearchParams(params).toString()
  return `${proto}//${host}/host/ws?${qs}`
}

// _genMatchId mints a short, collision-unlikely id for a New Hosted
// match.  The host lazily creates the match on first connect, so the
// id only needs to be unique among live matches, not globally.
function _genMatchId() {
  return 'sbx-' + Math.random().toString(36).slice(2, 8)
}

// _sandboxView toggles the Sandbox panel between its mode menu (Local
// / New Hosted / Join Hosted) and the Join Hosted picker that lists
// live sessions.  Module-scoped so it survives the dialog's
// unmount/remount the same way _activeTab does.
const _sandboxView = signal('menu')

// Module-scoped so the tab the user picked survives unmount/remount
// (e.g. opening + closing the dialog without losing the workflow
// context).  Defaults to 'explorer' — the file explorer is the first
// tab and the broadest entry point into a workspace, so a fresh boot
// lands there.
const _activeTab = signal('explorer')

// _TABS — single source of truth for the tab strip.  Each entry has
// the display label and an optional `disabled` flag.  Order here is
// the visual left-to-right order in the tab bar.  Scripting stays
// enabled (its sub-cards are all disabled stubs — clicking the tab
// lets the user see what's coming) while Other is a fully-disabled
// roadmap placeholder.
const _TABS = [
  { key: 'explorer',  label: 'Explorer' },
  { key: 'sandbox',   label: 'Sandbox Mode' },
  { key: 'mapping',   label: 'Map Creator' },
  { key: 'modelling', label: 'Unit Creator' },
  { key: 'scripting', label: 'Scripting' },
  { key: 'other',     label: 'Other', disabled: true,
    title: 'More workflows on the roadmap.' },
]

// _CARD — small helper that renders one welcome-card.  Centralising
// the markup keeps the disabled / placeholder treatment (extra class
// + click no-op + cursor flip) in one place; without it each card
// duplicated the ternary.  `onClick` is optional — disabled cards
// pass null + the helper skips the binding.
function _Card({ icon, title, sub, onClick, disabled = false, titleAttr = null }) {
  const cls = 'welcome-card' + (disabled ? ' welcome-card-disabled' : '')
  return html`
    <button class=${cls}
            disabled=${disabled || null}
            title=${titleAttr || (disabled ? 'Coming soon.' : null)}
            onClick=${disabled ? null : onClick}>
      <span class="welcome-card-ico">${icon}</span>
      <span class="welcome-card-title">${title}</span>
      <span class="welcome-card-sub">${sub}</span>
    </button>
  `
}

// _JoinPicker — lists the live hosted sandboxes from
// /api/studio/sandboxes and joins the one the user clicks.  Fetched on
// mount (and via the Refresh button); editor sessions are already
// filtered out server-side.  Selecting a row hands the host ws URL for
// that match's id back up through onOpenSandbox, which spins up a
// sandbox tab whose scene observes the authoritative world.
function _JoinPicker({ onOpenSandbox, onBack }) {
  const [state, setState] = useState({ status: 'loading', sessions: [], error: null })
  const load = () => {
    setState((s) => ({ ...s, status: 'loading', error: null }))
    fetch('/api/studio/sandboxes')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((rows) => setState({ status: 'ready', sessions: Array.isArray(rows) ? rows : [], error: null }))
      .catch((e) => setState({ status: 'error', sessions: [], error: String(e && e.message || e) }))
  }
  useEffect(() => { load() }, [])
  const join = (s) => {
    if (!onOpenSandbox) return
    onOpenSandbox({
      joinUrl: _hostWsUrl({ match: s.id }),
      displayName: s.name || s.id,
    })
  }
  return html`
    <div class="welcome-tab-panel" data-welcome-tab-panel="sandbox-join">
      <div class="welcome-join-head">
        <button class="welcome-link-btn" onClick=${() => onBack && onBack()}>← Back</button>
        <button class="welcome-link-btn" onClick=${load}>↻ Refresh</button>
      </div>
      ${state.status === 'loading' ? html`<p class="welcome-join-msg">Loading live sandboxes…</p>` : null}
      ${state.status === 'error' ? html`<p class="welcome-join-msg welcome-join-err">Couldn't load sandboxes: ${state.error}</p>` : null}
      ${state.status === 'ready' && state.sessions.length === 0 ? html`
        <p class="welcome-join-msg">No live hosted sandboxes.  Start one with New Hosted.</p>
      ` : null}
      ${state.status === 'ready' && state.sessions.length > 0 ? html`
        <ul class="welcome-join-list">
          ${state.sessions.map((s) => html`
            <li key=${s.id}>
              <button class="welcome-join-row" onClick=${() => join(s)}>
                <span class="welcome-join-name">${s.name || s.id}</span>
                <span class="welcome-join-meta">${s.units} unit${s.units === 1 ? '' : 's'} · ${s.players} player${s.players === 1 ? '' : 's'}</span>
              </button>
            </li>
          `)}
        </ul>
      ` : null}
    </div>
  `
}

// _WorkspaceFootnote reports which VFS / workspace the studio is serving
// (the active kbot context's base path plus headline counts), fetched
// once from the explorer's ?stats document.  Stays silent until the
// numbers arrive so a slow mount doesn't flash an empty line.
function _WorkspaceFootnote() {
  const [stats, setStats] = useState(null)
  useEffect(() => {
    let ok = true
    fetch('/api/vfs/?stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (ok) setStats(d) })
      .catch(() => { /* explorer surface unavailable — stay silent */ })
    return () => { ok = false }
  }, [])
  if (!stats || !stats.basePath) return null
  const num = (n) => Number(n || 0).toLocaleString()
  return html`
    <p class="welcome-footnote">
      📂 Workspace: <code>${stats.basePath}</code>
      <span class="welcome-footnote-sep">·</span> ${num(stats.archives)} archives
      <span class="welcome-footnote-sep">·</span> ${num(stats.totalFiles)} files
    </p>
  `
}

export function WelcomeScreen({
  onNewMap,
  onOpenMap,
  onOpenUnit,
  onOpenSandbox,
  onBrowseFiles,
}) {
  const active = _activeTab.value
  // Read the sandbox sub-view (menu vs join picker) so the keyboard-nav
  // effect below re-binds when the Sandbox panel swaps between its card
  // grid and the Join Hosted list — the card row remounts on that
  // toggle, so the listener must follow it.
  const sandboxView = _sandboxView.value
  // Keyboard nav — Arrow Left / Right walks the cards inside whichever
  // panel is active.  Same shape the legacy wireWelcomeKeyboard()
  // shipped; mounted on the card row so tab-press doesn't carry
  // through to the dialog.  The ref is re-bound each time `active` (or
  // the sandbox sub-view) changes — the rendered panel changes too —
  // so every tab gets identical keyboard behaviour without per-tab
  // duplication.
  const cardRowRef = useRef(null)
  useEffect(() => {
    if (!cardRowRef.current) return undefined
    const row = cardRowRef.current
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const cards = [...row.querySelectorAll('button:not([disabled])')]
      if (cards.length === 0) return
      const cur = cards.indexOf(document.activeElement)
      const next = e.key === 'ArrowLeft'
        ? (cur <= 0 ? cards.length - 1 : cur - 1)
        : (cur < 0 ? 0 : (cur + 1) % cards.length)
      cards[next].focus()
      e.preventDefault()
    }
    row.addEventListener('keydown', onKey)
    return () => row.removeEventListener('keydown', onKey)
  }, [active, sandboxView])
  return html`
    <h1 class="welcome-title">Welcome to KBot Studio</h1>
    <p class="welcome-tagline">
      <span>A web-based workbench for Total Annihilation and TA: Kingdoms.  Pick a workflow to begin.</span>
    </p>
    <div class="welcome-tabs" role="tablist" aria-label="Workflow">
      ${_TABS.map((t) => html`
        <button key=${t.key}
                class=${'welcome-tab' + (active === t.key ? ' active' : '')}
                role="tab"
                aria-selected=${active === t.key ? 'true' : 'false'}
                aria-disabled=${t.disabled ? 'true' : null}
                disabled=${t.disabled ? true : null}
                title=${t.title || null}
                onClick=${() => { if (!t.disabled) _activeTab.value = t.key }}>
          ${t.label}
        </button>
      `)}
    </div>
    ${active === 'sandbox' && _sandboxView.value === 'join' ? html`
      <${_JoinPicker}
        onOpenSandbox=${onOpenSandbox}
        onBack=${() => { _sandboxView.value = 'menu' }} />
    ` : null}
    ${active === 'sandbox' && _sandboxView.value !== 'join' ? html`
      <div class="welcome-tab-panel" data-welcome-tab-panel="sandbox">
        <div class="welcome-options" ref=${cardRowRef}>
          <${_Card}
            icon="🪖"
            title="Local Sandbox"
            sub="Drop units on a blank battlefield and test them live, in-browser."
            onClick=${() => onOpenSandbox && onOpenSandbox()} />
          <${_Card}
            icon="🌐"
            title="New Hosted"
            sub="Start an authoritative hosted match and join it for multiplayer testing."
            onClick=${() => {
              const id = _genMatchId()
              const name = `Sandbox ${id}`
              onOpenSandbox && onOpenSandbox({
                joinUrl: _hostWsUrl({ match: id, name, kind: 'sandbox' }),
                displayName: name,
              })
            }} />
          <${_Card}
            icon="🔗"
            title="Join Hosted"
            sub="Browse live hosted sandboxes and join one to share the world."
            onClick=${() => { _sandboxView.value = 'join' }} />
        </div>
      </div>
    ` : null}
    ${active === 'mapping' ? html`
      <div class="welcome-tab-panel" data-welcome-tab-panel="mapping">
        <div class="welcome-options" ref=${cardRowRef}>
          <${_Card}
            icon="✨"
            title="New Map"
            sub="Start a fresh battlefield from a blank canvas."
            onClick=${() => onNewMap && onNewMap()} />
          <${_Card}
            icon="📂"
            title="Open Map"
            sub="Open an existing map from your workspace."
            onClick=${() => onOpenMap && onOpenMap()} />
          <${_Card}
            icon="⬆"
            title="Upload TNT / OTA"
            sub="Bring in a TNT + OTA pair from outside your workspace."
            disabled=${true} />
        </div>
      </div>
    ` : null}
    ${active === 'modelling' ? html`
      <div class="welcome-tab-panel" data-welcome-tab-panel="modelling">
        <div class="welcome-options" ref=${cardRowRef}>
          <${_Card}
            icon="✨"
            title="New Unit"
            sub="Start a new unit from a COB script and 3DO model."
            disabled=${true} />
          <${_Card}
            icon="🛠"
            title="Open Unit"
            sub="Browse, test, and tune existing units in your workspace."
            onClick=${() => onOpenUnit && onOpenUnit()} />
        </div>
      </div>
    ` : null}
    ${active === 'explorer' ? html`
      <div class="welcome-tab-panel" data-welcome-tab-panel="explorer">
        <div class="welcome-options" ref=${cardRowRef}>
          <${_Card}
            icon="🗂"
            title="Browse Files"
            sub="View the full set of content for this workspace."
            onClick=${() => onBrowseFiles && onBrowseFiles()} />
        </div>
      </div>
    ` : null}
    ${active === 'scripting' ? html`
      <div class="welcome-tab-panel" data-welcome-tab-panel="scripting">
        <div class="welcome-options" ref=${cardRowRef}>
          <${_Card}
            icon="✨"
            title="New Script"
            sub="Start a new BOS script for a unit or mission."
            disabled=${true} />
          <${_Card}
            icon="📂"
            title="Open Script"
            sub="Open an existing BOS file from your workspace."
            disabled=${true} />
          <${_Card}
            icon="↻"
            title="Decompile Script"
            sub="Recover BOS from a COB when source is missing."
            disabled=${true} />
        </div>
      </div>
    ` : null}
    <${_WorkspaceFootnote} />
  `
}

// setWelcomeTab — host helper for surfacing a specific workflow
// programmatically (e.g. after a Modelling-context error the host
// might want to nudge the user back to the Mapping tab).
export function setWelcomeTab(key) {
  if (_TABS.find((t) => t.key === key && !t.disabled)) _activeTab.value = key
}
