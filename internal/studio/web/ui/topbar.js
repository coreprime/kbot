// topbar.js
//
// The status bar — topbar doc-info pill (title + meta) plus the footer
// hints and status line — is owned by the tab being shown, not shared
// across tabs.  updateTopbarDocInfo repaints the whole bar from a single
// tab record and is the only writer of the chrome strings, so switching
// to a tab can never leave another tab's title / hints / status behind.
// The framework calls it on every activation (tab-registry.switchToTab)
// and the map boot paths call it directly for the deferred first open.

import { $ } from './host-context.js'

// _statusBarFor returns the { title, meta, hints, status } the chrome should
// show for a tab.  Each tab type owns its own chrome via the instance's
// optional statusBar(); shared code keeps NO per-type knowledge and falls
// back to a neutral bar.
const NEUTRAL_BAR = { title: '', meta: '', hints: '', status: '' }
function _statusBarFor(tab) {
  if (!tab) return NEUTRAL_BAR
  const bar = tab.instance?.statusBar?.()
  if (bar) return bar
  return {
    title: tab.displayName || tab.name || '',
    meta: '',
    hints: '',
    status: tab._status != null ? tab._status : '',
  }
}

// updateTopbarDocInfo repaints the doc-info pill + footer hints + status
// line from whichever tab is now active.  Cleared when nothing's open.
export function updateTopbarDocInfo(tab) {
  // Stamp the active tab type on <body> so CSS shows only the chrome that
  // belongs to it. This is the single chrome-owner called on every activation
  // AND by the map editor's direct first-boot path, so it reliably keeps
  // <body data-tab> in sync. The type string is opaque here.
  if (typeof document !== 'undefined' && document.body) {
    document.body.dataset.tab = tab?.typeId || ''
  }
  const titleEl = $('#app-doc-title')
  const metaEl = $('#app-doc-meta')
  const hintsEl = $('#app-hints')
  const statusEl = $('#status')
  const bar = _statusBarFor(tab)
  if (titleEl) titleEl.textContent = bar.title
  if (metaEl) metaEl.textContent = bar.meta
  if (hintsEl) hintsEl.innerHTML = bar.hints
  if (statusEl) statusEl.textContent = bar.status
}
