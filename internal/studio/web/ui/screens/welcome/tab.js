// tab.js
//
// Host-side show/hide for the Welcome tab. The welcome screen is now a
// first-class MDI tab rather than a separate full-screen modal: activating
// it keeps the shared topbar + tab strip (#app) visible and reveals the
// welcome surface (#welcome-dialog) as an overlay below the chrome — the
// same shape the Files and Sandbox tabs use. The welcome card body itself
// is mounted once into #welcome-dialog by mountWelcomeScreen() at boot, so
// this module only toggles visibility.

import { openTab, switchToTab } from '../../tab-registry.js'
import { $, tabs } from '../../host-context.js'

// activateWelcomeTab reveals the welcome surface within the editor chrome
// (tab strip stays visible) and hides the other content surfaces.
export function activateWelcomeTab() {
  $('#model-viewer-dialog')?.classList.add('hidden')
  $('#model-open-dialog')?.classList.add('hidden')
  $('#files-dialog')?.classList.add('hidden')
  $('#app')?.classList.remove('hidden')
  const wel = $('#welcome-dialog')
  if (wel) {
    // `as-tab` re-positions the (normally full-screen) dialog to sit below
    // the topbar + tab strip so it reads as the active tab's body. The
    // glamour/nanofx MutationObserver keys off the `hidden` class, so
    // removing it also (re)starts the background slideshow.
    wel.classList.add('as-tab')
    wel.classList.remove('hidden')
  }
}

// deactivateWelcomeTab hides the welcome surface so an incoming tab owns
// the editor area again.
export function deactivateWelcomeTab() {
  $('#welcome-dialog')?.classList.add('hidden')
}

// openWelcomeTab adds (or focuses, via the registry) a Welcome tab.
export function openWelcomeTab() {
  // Reuse an existing Welcome tab if one is open rather than stacking up
  // duplicates (the + menu and Join-Hosted both route through here).
  const idx = tabs.findIndex((t) => (t.typeId || t.type) === 'welcome')
  if (idx >= 0) { switchToTab(idx, { force: true }); return tabs[idx] }
  const rec = openTab('welcome', {})
  // Pin a freshly-opened Welcome tab to the front of the tab order.
  const i = tabs.indexOf(rec)
  if (i > 0) {
    tabs.splice(i, 1)
    tabs.unshift(rec)
    switchToTab(0, { force: true })
  }
  return rec
}
