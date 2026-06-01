// tab-bar.js
//
// Host-side wiring for the React-managed tab strip.  Owns the three
// helpers studio.js called by hand before Phase 11:
//   - mapDisplayName(m)  — friendly label for a MapDoc.
//   - renderMapTabs()    — push the host's tabs[] + active index into
//                          the React tab-bar's state signal.
//   - wireMapTabBar()    — install the click/close/+ bridge and
//                          mount the React tab bar.
//
// The tab-strip component itself (the Preact JSX, dropdown popups,
// dirty-marker rendering) lives in /ui/common/tab-bar.js — this
// module is the host-side bridge that feeds it.
//
// /ui/ root rather than /ui/common/ because it imports section
// concerns (size dialog, map picker, model picker, sandbox opener)
// to wire the "+" popup actions.  /ui/common/ stays free of section
// imports per the directional rule.

import { tabs, tabState, getReactUi } from './host-context.js'
import { switchToTab, closeTab } from './tab-registry.js'
import { configureReactUi } from './wire-react-ui.js'
import { openSizeDialog, setSizeDialogSource } from './map-editor/dialogs/size.js'
import { openMapDialog } from './pickers/open-map.js'
import { openModelPicker } from './pickers/open-unit-flow.js'
import { setModelOpenIntent } from './unit-editor/host-state.js'
import { openSandboxStub } from './sandbox/tab.js'
import { openFilesTab } from './files-browser/tab.js'

// mapDisplayName returns the friendly label for a MapDoc — prefers the
// OTA mission name (the human-readable title the player sees in the
// lobby) and falls back to the TNT filename when the mission name is
// empty (#37).
export function mapDisplayName(m) {
  const mission = (m?.ota?.missionName || '').trim()
  if (mission) return mission
  return (m?.name || '').trim() || '(untitled)'
}

export function renderMapTabs() {
  // Tab strip is React-managed (see /ui/common/tab-bar.js).  Push the
  // current tabs[] + tabState.activeIndex into the React state signal each
  // time the host's tab list mutates (open / close / switch).  No-op
  // when the React UI hasn't loaded yet (the next setTabs after boot
  // catches up).
  const ui = getReactUi()
  if (ui && typeof ui.setTabs === 'function') {
    ui.setTabs(tabs, tabState.activeIndex)
  }
}

// buildTabElement removed — tab rendering now lives entirely in the
// React TabBar component.  Per-tab formatting (model glyph, dirty
// marker, title metadata) is data-driven from the tab record.

export function wireMapTabBar() {
  // Tab bar + its "+" popup are React-managed.  configureReactUi
  // resolves asynchronously (dynamic import), so we may run before
  // the React island is loaded — `await` the promise so the bridge +
  // mount fire as soon as the module lands.  configureReactUi caches
  // its promise so this never starts a second import.
  ;(async () => {
    const ui = getReactUi() || await configureReactUi()
    if (!ui) return
    if (typeof ui.configureTabBarBridge === 'function') {
      ui.configureTabBarBridge({
        onSwitch:   (i) => switchToTab(i),
        onClose:    (i) => closeTab(i),
        onNewMap:   () => { setSizeDialogSource('tabbar'); openSizeDialog() },
        onOpenMap:  () => openMapDialog('tabbar'),
        onOpenUnit: () => { setModelOpenIntent('add'); openModelPicker() },
        onSandbox:  () => openSandboxStub(),
        onBrowseFiles: () => openFilesTab(),
      })
    }
    if (typeof ui.mountTabBar === 'function') ui.mountTabBar()
    // Push the current tab list into the React state so the bar paints
    // its initial render with whatever was already open (e.g. when this
    // runs after a tab has already been added at boot).
    if (typeof ui.setTabs === 'function') ui.setTabs(tabs, tabState.activeIndex)
  })()
}
