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
import { mapDisplayName } from './tab-bar.js'

const MAP_HINTS = 'Drag-paint with the mouse.  Hold <kbd>Shift</kbd> to erase.  Scroll to zoom (<kbd>Shift</kbd>+scroll pans).'
const MODEL_HINTS = 'Drag — orbit · Wheel — zoom · <kbd>Shift</kbd> / right-drag — pan · Click a piece to centre on it'
const FILES_HINTS = 'Search, browse, and preview the files in this workspace.'

const MAP_STATUS = 'Ready.  Pick a section on the left, then click on the canvas to stamp it.'
const SANDBOX_STATUS = 'Sandbox ready — click "Spawn Unit" to add a unit to the field.'
const UNIT_STATUS = 'Unit viewer ready.'
const FILES_STATUS = 'File Explorer'

// _statusBarFor returns the { title, meta, hints, status } the chrome
// should show for a tab.  `status` is the tab's remembered live line
// (tab._status, written by setStatus) when present, else a per-type
// default so a never-touched tab still reads sensibly.
function _statusBarFor(tab) {
  if (!tab) return { title: '', meta: '', hints: MAP_HINTS, status: '' }
  const typeId = tab.typeId
  if (typeId === 'unit-editor' || typeId === 'sandbox') {
    const meta = tab.spec?.meta || tab.meta
    const parts = [meta?.unitTitle, meta?.side, meta?.category, meta?.description].filter(Boolean)
    return {
      title: tab.instance?.displayName?.() || tab.name || '',
      meta: parts.join(' · '),
      hints: MODEL_HINTS,
      status: tab._status != null ? tab._status : (typeId === 'sandbox' ? SANDBOX_STATUS : UNIT_STATUS),
    }
  }
  if (typeId === 'files') {
    return {
      title: '',
      meta: '',
      hints: FILES_HINTS,
      status: tab._status != null ? tab._status : FILES_STATUS,
    }
  }
  if (typeId === 'welcome') {
    return {
      title: 'Welcome',
      meta: '',
      hints: '',
      status: tab._status != null ? tab._status : '',
    }
  }
  // Map tab (or unknown legacy record).
  const m = tab.spec?.map || tab.map
  const parts = [
    m?.tileW && m?.tileH ? `${m.tileW}×${m.tileH}` : null,
    m?.planet || null,
  ].filter(Boolean)
  return {
    title: mapDisplayName(m),
    meta: parts.join(' · '),
    hints: MAP_HINTS,
    status: tab._status != null ? tab._status : MAP_STATUS,
  }
}

// updateTopbarDocInfo repaints the doc-info pill + footer hints + status
// line from whichever tab is now active.  Cleared when nothing's open.
export function updateTopbarDocInfo(tab) {
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
