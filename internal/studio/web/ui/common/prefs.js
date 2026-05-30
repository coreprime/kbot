// prefs.js
//
// Persisted UI preferences.  A handful of UI state lives outside
// any specific map and is worth remembering across reloads: drawer
// filters, the usedOnly / wreckage toggles, the animation +
// gridlines toggles, view mode, and the floating-panel visibility.
// Stored as one JSON blob under a single localStorage key so we
// don't pollute the user's storage namespace.
//
// Used by the map editor, the unit editor (inspector panel visibility
// + positions), and the sandbox (Developer Tools toggle).  Lives in
// /ui/common/ rather than any subsystem folder because every view
// reads and writes its own subset of PREF_FIELDS.

import { state, $, $$ } from '../host-context.js'

export const PREFS_KEY = 'kbot-studio:prefs:v1'
export const PREF_FIELDS = ['usedOnly', 'includeWreckage', 'animateFeatures',
  'showGridlines', 'showMinimap', 'showCameraInfo', 'showFeatures', 'showVoids', 'showContours', 'showBuildable', 'showStartPositions',
  'viewMode', 'panelLayout', 'settings',
  // Model-viewer inspector panels.  Without these the close /
  // collapse / drag positions are written to state.* but never
  // serialised, so the panels would forget every preference on
  // reload — including a user's explicit close, which is exactly
  // the signal the "default visible" logic uses to decide whether
  // to auto-show next time.
  'mvInspectorVisible', 'mvInspectorCollapsed', 'mvInspectorPos',
  // Script Commands inspector's "Include Private" filter — preserved
  // across sessions so a user debugging internal helpers doesn't
  // have to re-tick the box on every reload.  Pref key keeps the
  // legacy 'mvActions' prefix so saved preferences survive the
  // rename.
  'mvActionsIncludePrivate',
  // Sandbox Developer Controls toggle — persists the "hide developer
  // editors at the bottom of the Controls panel" preference so a
  // user who wants the lean sandbox UI doesn't have to retoggle
  // each visit.
  'mvControlsDevVisible',
  // Graphics Options menu state (shadows + effect toggles + liquid
  // sim) — one blob shared by the unit-editor + sandbox ribbons so a
  // user's chosen look persists across reloads and applies to every
  // rendering pane.  See /ui/common/graphics-options-state.js.
  'graphicsOptions']

// createPrefsStore returns a {load, save} interface backed by a
// Web Storage implementation (defaults to window.localStorage).
// The abstraction lets the editor pass in a different backing
// store for tests, throw-away sessions ("Open in new tab" with
// prefs disabled), or future server-side sync.  All localStorage
// access in this file goes through this interface — nothing else
// calls window.localStorage directly.
export function createPrefsStore({ key, storage } = {}) {
  const k = key || PREFS_KEY
  const s = storage !== undefined ? storage : (typeof window !== 'undefined' ? window.localStorage : null)
  return {
    load() {
      try {
        const raw = s?.getItem(k)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return (parsed && typeof parsed === 'object') ? parsed : null
      } catch { return null }
    },
    save(blob) {
      try { s?.setItem(k, JSON.stringify(blob)) } catch { /* incognito / quota / disabled */ }
    },
  }
}

// Module-level singleton for prefs persistence.  Swappable for
// tests by reassigning this via setPrefsStore() to a different
// createPrefsStore() return value, or to a `{ load: () => null,
// save: () => {} }` no-op stub.
let prefsStore = createPrefsStore()

export function setPrefsStore(s) { prefsStore = s }
export function getPrefsStore() { return prefsStore }

export function loadPersistedPrefs() {
  const parsed = prefsStore.load()
  if (!parsed) return
  for (const k of PREF_FIELDS) {
    if (parsed[k] === undefined) continue
    state[k] = parsed[k]
  }
  // Push the loaded values onto any DOM mirrors so the menu rows
  // reflect them on first render.
  syncDomFromPrefs()
}

export function syncDomFromPrefs() {
  const setOn = (id, on) => { const el = $(id); if (el) el.dataset.on = on ? '1' : '0' }
  setOn('#opt-gridlines', state.showGridlines)
  setOn('#opt-animate', state.animateFeatures)
  setOn('#opt-minimap', state.showMinimap)
  setOn('#opt-camera-info', state.showCameraInfo)
  setOn('#opt-voids', state.showVoids)
  setOn('#opt-contours', state.showContours)
  setOn('#opt-buildable', state.showBuildable)
  setOn('#opt-features', state.showFeatures)
  setOn('#opt-startpoints', state.showStartPositions)
  const used = $('#filter-used'); if (used) used.checked = !!state.usedOnly
  const wrk = $('#filter-wreckage'); if (wrk) wrk.checked = !!state.includeWreckage
  // View mode active row.
  $$('#display-mode-group .menu-row').forEach((r) => r.classList.toggle('active', r.dataset.display === state.viewMode))
  const viewLbl = $('#view-current-lbl')
  if (viewLbl) {
    const row = $$('#display-mode-group .menu-row').find((r) => r.dataset.display === state.viewMode)
    const span = row?.querySelector('span:not(.ico)')
    if (span) viewLbl.textContent = span.textContent
  }
  // Apply panel visibility flags.
  const mini = $('#minimap-panel')
  if (mini) mini.classList.toggle('hidden', !state.showMinimap)
  const cam = $('#camera-info-panel')
  if (cam) cam.classList.toggle('hidden', !state.showCameraInfo)
}

// persistPrefs debounces writes — calls during a burst of UI
// interactions (e.g. dragging a panel) coalesce into one save 250ms
// after the last change.
let prefsSaveTimer = null
export function persistPrefs() {
  if (prefsSaveTimer) return
  prefsSaveTimer = setTimeout(() => {
    prefsSaveTimer = null
    const blob = {}
    for (const k of PREF_FIELDS) blob[k] = state[k]
    prefsStore.save(blob)
  }, 250)
}
