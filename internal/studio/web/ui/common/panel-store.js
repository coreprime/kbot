// panel-store.js
//
// Signals-backed store for the floating-panel chrome (position,
// visibility, collapsed state).  Keeps the per-panel state outside
// any single component so multiple subscribers (the panel itself,
// the View menu's toggle row, the Developer Tools dropdown, the
// ribbon's status badges) can react to the same source of truth
// without prop-drilling or stale-closure bugs.
//
// The store is intentionally agnostic of where the data is persisted.
// `configurePanelPersistence` lets the host (studio.js) inject the
// load/save callbacks that route into its preference system; that
// keeps the React/Preact island free of imports from the giant
// vanilla studio module and lets us swap the persistence backend
// (localStorage now, server-side later) without touching the
// component code.

import { signal } from '@preact/signals'

// _persistence — pluggable hooks the host installs once at boot.  The
// default no-op functions keep the module importable without any
// configuration (handy for tests + isolated component playgrounds).
let _persistence = {
  loadPos:       (_id) => null,
  savePos:       (_id, _pos) => {},
  loadCollapsed: (_id) => false,
  saveCollapsed: (_id, _on) => {},
  loadVisible:   (_id, _def) => _def,
  saveVisible:   (_id, _on) => {},
}

export function configurePanelPersistence(hooks) {
  _persistence = { ..._persistence, ...hooks }
}

// _panelRegistry — one record per registered panel.  Holding the
// signals on a long-lived record means subscribers don't have to
// re-acquire them after a panel hides/shows; the same Signal
// objects survive component unmount + remount.
const _panelRegistry = new Map()

// _ensure builds (or returns) the registry entry for a panel.  Signals
// are seeded from the host's persistence layer the first time the
// panel is touched — subsequent registers see the in-memory state.
function _ensure(panelId, { defaultVisible = true } = {}) {
  let rec = _panelRegistry.get(panelId)
  if (rec) return rec
  const pos = _persistence.loadPos(panelId)
  rec = {
    id: panelId,
    pos:       signal(pos || null),
    collapsed: signal(!!_persistence.loadCollapsed(panelId)),
    visible:   signal(!!_persistence.loadVisible(panelId, defaultVisible)),
  }
  _panelRegistry.set(panelId, rec)
  return rec
}

// registerPanel — public entry point.  Components call this in their
// constructor (or the surrounding mount helper) to acquire the live
// signal triplet for a panel id.  Defaults are honoured on FIRST
// register; later registers see whatever the current values are.
export function registerPanel(panelId, opts) {
  return _ensure(panelId, opts)
}

// setPanelPos / setPanelCollapsed / setPanelVisible — mutation
// helpers that fan out to both the signal AND the persistence
// callback.  Keeps the two write paths in lockstep so a re-render
// triggered by Signal change reflects what's on disk.
export function setPanelPos(panelId, pos) {
  const rec = _ensure(panelId)
  rec.pos.value = pos ? { top: pos.top, left: pos.left } : null
  if (pos) _persistence.savePos(panelId, rec.pos.value)
}

export function setPanelCollapsed(panelId, on) {
  const rec = _ensure(panelId)
  rec.collapsed.value = !!on
  _persistence.saveCollapsed(panelId, rec.collapsed.value)
}

export function setPanelVisible(panelId, on) {
  const rec = _ensure(panelId)
  rec.visible.value = !!on
  _persistence.saveVisible(panelId, rec.visible.value)
}

// panelSignals — read-only accessor for components that want to bind
// directly to the live signals without writing through the helpers.
export function panelSignals(panelId) {
  return _ensure(panelId)
}
