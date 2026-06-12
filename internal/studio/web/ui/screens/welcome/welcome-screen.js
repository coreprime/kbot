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
import { PickerModal } from '@kbot/ui/picker-modal'

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

// Local-sandbox launch flow — two PickerModal steps in front of the
// sandbox: choose a battlefield (The Grid, or any workspace map with its
// minimap thumbnail — searchable, the same selector the Map editor uses),
// then choose a faction (dynamic from gamedata/sidedata.tdf: ARM/CORE in
// TA, the kingdoms in TA:K, each fronted by its leader's build picture).
// Confirming hands { mapPath, faction } to onOpenSandbox; the sandbox
// activation loads the map and spawns the leader at player 1's start.
const _launch = signal(null)

const _wsBase = () => (typeof window !== 'undefined' && window.__WS_BASE__) || ''

function _startLaunchFlow(onOpenSandbox) {
  _launch.value = { step: 'map', maps: null, sides: null, mapPath: null, query: '', selectedKey: null, onOpenSandbox }
  fetch('/api/studio/maps')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const cur = _launch.value
      if (cur) _launch.value = { ...cur, maps: (d && d.maps) || [] }
    })
    .catch(() => { const cur = _launch.value; if (cur) _launch.value = { ...cur, maps: [] } })
  fetch('/api/studio/sandbox-sides')
    .then((r) => (r.ok ? r.json() : []))
    .then((sides) => {
      const cur = _launch.value
      if (cur) _launch.value = { ...cur, sides: Array.isArray(sides) ? sides : [] }
    })
    .catch(() => { const cur = _launch.value; if (cur) _launch.value = { ...cur, sides: [] } })
}

const _GRID_ITEM = { path: '', name: 'The Grid', gridItem: true }

export function SandboxLaunchFlow() {
  const st = _launch.value
  if (!st) return null
  const onOpenSandbox = st.onOpenSandbox
  const cancel = () => { _launch.value = null }
  if (st.step === 'map') {
    const items = [_GRID_ITEM, ...(st.maps || [])]
    const q = (st.query || '').trim().toLowerCase()
    const filtered = q
      ? items.filter((m) => `${m.name} ${m.missionName || ''} ${m.planet || ''}`.toLowerCase().includes(q))
      : items
    const selected = items.find((m) => (m.path || '__grid__') === st.selectedKey) || null
    const choose = (m) => {
      const sides = st.sides || []
      if (sides.length > 1) {
        _launch.value = { ...st, step: 'faction', mapPath: m.path || null, mapName: m.name, query: '', selectedKey: null }
      } else {
        // Single (or unknown) faction roster: launch straight away.
        const f = sides[0] || null
        _launch.value = null
        onOpenSandbox && onOpenSandbox({ mapPath: m.path || null, faction: f })
      }
    }
    const renderItem = (m) => {
      const key = m.path || '__grid__'
      const cls = ['open-list-item', key === st.selectedKey ? 'selected' : ''].filter(Boolean).join(' ')
      const meta = m.gridItem
        ? 'Blank floor — no terrain rules'
        : [m.planet || null, m.numPlayers ? `${m.numPlayers} players` : null].filter(Boolean).join(' · ')
      return html`
        <button type="button" class=${cls} key=${key}
                onClick=${() => { _launch.value = { ...st, selectedKey: key } }}
                onDblClick=${() => choose(m)}>
          ${m.gridItem
            ? html`<div class="thumb welcome-map-grid"></div>`
            : html`<img class="thumb" loading="lazy" alt=""
                        src=${`${_wsBase()}/api/studio/minimap/${m.path}`}
                        onError=${(e) => { e.currentTarget.style.visibility = 'hidden' }} />`}
          <div class="title">${m.missionName || m.name}</div>
          <div class="meta">${meta}</div>
        </button>
      `
    }
    return html`
      <${PickerModal} open=${true}
                      title="Choose a battlefield"
                      sub="The Grid for a blank field, or any map in this workspace."
                      filterPlaceholder="Filter by name, planet, or player count"
                      filterValue=${st.query}
                      onFilterChange=${(v) => { _launch.value = { ...st, query: v } }}
                      loading=${st.maps == null}
                      emptyMessage=${st.maps == null ? 'Loading maps…' : 'No maps match.'}
                      items=${filtered}
                      selectedKey=${st.selectedKey}
                      onSelect=${(m) => { _launch.value = { ...st, selectedKey: m.path || '__grid__' } }}
                      onConfirm=${() => { if (selected) choose(selected) }}
                      onCancel=${cancel}
                      confirmDisabled=${!selected}
                      renderItem=${renderItem}
                      itemKey=${(m) => m.path || '__grid__'} />
    `
  }
  // Faction step.
  const sides = st.sides || []
  const selected = sides.find((f) => String(f.index) === st.selectedKey) || null
  const choose = (f) => {
    _launch.value = null
    onOpenSandbox && onOpenSandbox({ mapPath: st.mapPath, faction: f })
  }
  const renderItem = (f) => {
    const key = String(f.index)
    const cls = ['open-list-item', key === st.selectedKey ? 'selected' : ''].filter(Boolean).join(' ')
    return html`
      <button type="button" class=${cls} key=${key}
              onClick=${() => { _launch.value = { ...st, selectedKey: key } }}
              onDblClick=${() => choose(f)}>
        ${f.commander
          ? html`<img class="thumb" loading="lazy" alt=""
                      src=${`${_wsBase()}/api/studio/buildpic/${f.commander}`}
                      onError=${(e) => { e.currentTarget.style.visibility = 'hidden' }} />`
          : html`<div class="thumb"></div>`}
        <div class="title">${f.name}</div>
        <div class="meta">${f.commander ? `Leader: ${f.commander}` : ''}</div>
      </button>
    `
  }
  return html`
    <${PickerModal} open=${true}
                    title="Choose your faction"
                    sub=${`Battlefield: ${st.mapName || 'The Grid'} — your leader unit spawns at the player 1 start.`}
                    filterPlaceholder="Filter factions"
                    filterValue=${st.query}
                    onFilterChange=${(v) => { _launch.value = { ...st, query: v } }}
                    loading=${st.sides == null}
                    emptyMessage=${st.sides == null ? 'Loading factions…' : 'No playable factions found.'}
                    items=${sides}
                    selectedKey=${st.selectedKey}
                    onSelect=${(f) => { _launch.value = { ...st, selectedKey: String(f.index) } }}
                    onConfirm=${() => { if (selected) choose(selected) }}
                    onCancel=${() => { _launch.value = { ...st, step: 'map', query: '', selectedKey: null } }}
                    confirmDisabled=${!selected}
                    renderItem=${renderItem}
                    itemKey=${(f) => String(f.index)} />
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
            sub="Pick a battlefield and test units live, in-browser."
            onClick=${() => _startLaunchFlow(onOpenSandbox)} />
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

// setSandboxView — host helper to surface the Sandbox workflow's Join
// picker (or its menu) directly, e.g. from the tab-bar's "+" menu.
export function setSandboxView(view) { _sandboxView.value = view }

// setWelcomeTab — host helper for surfacing a specific workflow
// programmatically (e.g. after a Modelling-context error the host
// might want to nudge the user back to the Mapping tab).
export function setWelcomeTab(key) {
  if (_TABS.find((t) => t.key === key && !t.disabled)) _activeTab.value = key
}
