// topbar.js
//
// Shared topbar's doc-info pill + footer hints — populated whenever
// the active tab changes (open / close / switch).  Lives at /ui/
// root because the helper services every tab type's activate() hook
// through hostCallbacks.updateTopbarDocInfo.

import { $ } from './host-context.js'
import { mapDisplayName } from './tab-bar.js'

// updateTopbarDocInfo populates the shared topbar's doc-info pill
// AND the shared footer's hints from whichever tab is now active.
// Empty when nothing's open.
export function updateTopbarDocInfo(tab) {
  const titleEl = $('#app-doc-title')
  const metaEl = $('#app-doc-meta')
  const hintsEl = $('#app-hints')
  const MAP_HINTS = 'Drag-paint with the mouse.  Hold <kbd>Shift</kbd> to erase.  Scroll to zoom (<kbd>Shift</kbd>+scroll pans).'
  const MODEL_HINTS = 'Drag — orbit · Wheel — zoom · <kbd>Shift</kbd> / right-drag — pan · Click a piece to centre on it'
  if (!titleEl || !metaEl) return
  if (!tab) {
    titleEl.textContent = ''
    metaEl.textContent = ''
    if (hintsEl) hintsEl.innerHTML = MAP_HINTS
    return
  }
  // Read off the registered typeId (set by openTab / _ensureTabInstance)
  // rather than the legacy `tab.type` discriminator.  Both stay in
  // sync for now via attachTabRef; once readers migrate the legacy
  // field can drop.
  if (tab.typeId === 'unit-editor' || tab.typeId === 'sandbox') {
    titleEl.textContent = tab.instance?.displayName?.() || tab.name || ''
    const meta = tab.spec?.meta || tab.meta
    const parts = [meta?.unitTitle, meta?.side, meta?.category, meta?.description].filter(Boolean)
    metaEl.textContent = parts.join(' · ')
    if (hintsEl) hintsEl.innerHTML = MODEL_HINTS
  } else {
    const m = tab.spec?.map || tab.map
    titleEl.textContent = mapDisplayName(m)
    const parts = [
      m?.tileW && m?.tileH ? `${m.tileW}×${m.tileH}` : null,
      m?.planet || null,
    ].filter(Boolean)
    metaEl.textContent = parts.join(' · ')
    if (hintsEl) hintsEl.innerHTML = MAP_HINTS
  }
}
