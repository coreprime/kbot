// wire-dialogs.js
//
// wireModelDialogs — boot-time wiring for the unit editor's model /
// open-unit dialog chrome.  Most of the original wiring vapourised
// when the picker + viewer ribbon migrated to React; what remains is
// the legacy tree-filter input, the inspector chrome, and the cold
// boot of the React UI island.
//
// What lives here:
//   - The piece-tree filter input listener (typing narrows the
//     visible pieces to those whose name matches; case-insensitive
//     substring against both group + leaf rows).
//   - wireMvInspectors() invocation so the floating COB / Static /
//     Camera overlays come online.
//   - configureReactUi() invocation to lift the Preact UI island
//     (persistence callbacks + ribbon bridge + dialogs + sidebar
//     tabs all mount once the dynamic import resolves).

import { $, hostCallbacks } from '../host-context.js'
import { wireMvInspectors } from '../common/inspectors.js'
import { filterPieceTree } from './sidebar.js'

export function wireModelDialogs() {
  // The welcome-card buttons (#welcome-model-open, #welcome-sandbox)
  // are React-managed now via mountWelcomeScreen()'s onOpenUnit /
  // onOpenSandbox callbacks.  The Open Unit picker dialog itself is
  // also React-owned (see /ui/pickers/open-unit-dialog.js), so the
  // legacy #model-filter / #model-open-back / #model-open-confirm
  // wiring is gone too — those static elements are no longer driven.
  // No "Close" button on the viewer overlay any more — the user
  // closes the model tab via the × in the shared tab bar, same
  // gesture they use for maps.
  //
  // The unit-editor ribbon (Model / Camera / Rendering / Scene / Studio
  // Options / Animation / View / Configure / Help) is React-managed
  // now (see /ui/unit-editor/ribbon/model-viewer-ribbon.js).  Mount +
  // bridge wiring lives in wireModelViewerRibbon() which is called
  // once the React UI island has finished loading.
  //
  // Tree filter — typing narrows the visible pieces to those whose
  // name matches.  Match is case-insensitive substring, applied to
  // both group and leaf rows.
  const treeFilter = $('#mv-tree-filter')
  if (treeFilter) treeFilter.addEventListener('input', () => filterPieceTree(treeFilter.value))
  wireMvInspectors()
  // Bring the Preact UI island online once at boot.  Persistence
  // callbacks bridge the panel-store's signals into the existing
  // prefs system so a React panel's saved position / collapsed /
  // visible state ends up in the same localStorage blob the legacy
  // panels write to, and the View menu + Developer Tools dropdown
  // mirrors stay in lockstep without an extra cross-channel.
  hostCallbacks.configureReactUi?.()
}
