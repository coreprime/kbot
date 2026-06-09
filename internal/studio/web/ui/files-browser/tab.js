// tab.js
//
// Host-side glue for the Files tab.  Owns the overlay surface
// (#files-dialog), mounts the React FilesBrowser into it once, and
// exposes openFilesTab() for the tab-strip "+" menu plus the
// activate/deactivate hooks the tab descriptor calls.
//
// The Files surface overlays the editor content area the same way the
// model-viewer dialog does: the shared topbar + tab strip stay visible
// above it and the status bar below, so switching to a Files tab feels
// like the other tabs.

import { $, getReactUi, tabs, tabState } from '../host-context.js'
import { openTab } from '../tab-registry.js'
import { configureReactUi } from '../wire-react-ui.js'

// ensureFilesDialog returns the overlay element, creating it on first
// use.  index.html ships the element, but creating it defensively keeps
// the tab working even if the markup is ever dropped.
function ensureFilesDialog() {
  let dlg = $('#files-dialog')
  if (!dlg) {
    dlg = document.createElement('div')
    dlg.id = 'files-dialog'
    dlg.className = 'dialog hidden files-dialog'
    const mount = document.createElement('div')
    mount.id = 'files-browser-mount'
    mount.style.cssText = 'display:contents'
    dlg.appendChild(mount)
    document.body.appendChild(dlg)
  }
  return dlg
}

// mountFilesBrowserOnce renders the FilesBrowser into the overlay's
// mount slot exactly once.  Subsequent activations just reveal the
// already-mounted tree, preserving the user's place.
let _mounted = false
async function mountFilesBrowserOnce() {
  if (_mounted) return
  const ui = getReactUi() || await configureReactUi()
  if (ui && typeof ui.mountFilesBrowser === 'function') {
    ui.mountFilesBrowser()
    _mounted = true
  }
}

// openFilesTab adds a Files tab to the host and focuses it.  Routed
// from the tab-strip "+" menu's "Browse Files" row.
export function openFilesTab() {
  ensureFilesDialog()
  return openTab('files', {})
}

// setFilesTabTitle mirrors the explorer's current location onto the
// active Files tab's strip label so the tab reads "maps" or "acidbrief.gaf"
// instead of a static "Files".  The mounted browser reports its route
// here on each navigation.
export function setFilesTabTitle(label) {
  const rec = tabs[tabState.activeIndex]
  if (!rec || (rec.typeId || rec.type) !== 'files') return
  rec.displayName = label || 'Files'
  const ui = getReactUi()
  if (ui && typeof ui.setTabs === 'function') ui.setTabs(tabs, tabState.activeIndex)
}

// activateFilesTab reveals the overlay (keeping the shared topbar/tabs
// visible) and ensures the browser is mounted.  The status bar (footer
// hints / status + cleared doc-info pills) is repainted by the framework
// after activate via updateTopbarDocInfo's files branch, so this path no
// longer pokes the chrome strings itself.
export async function activateFilesTab() {
  ensureFilesDialog()
  $('#app')?.classList.remove('hidden')
  $('#welcome-dialog')?.classList.add('hidden')
  $('#model-viewer-dialog')?.classList.add('hidden')
  $('#files-dialog')?.classList.remove('hidden')
  await mountFilesBrowserOnce()
}

// deactivateFilesTab hides the overlay so an incoming map/unit tab owns
// the editor surface again.  The mounted tree is left intact for the
// next activation.
export function deactivateFilesTab() {
  $('#files-dialog')?.classList.add('hidden')
}
