// wire-react-ui.js
//
// Boots the React/Preact UI island (/ui/mount.js) and installs the
// persistence bridge.  Idempotent: repeated calls return the same
// Promise so multiple init paths (initial boot, hot-reload, tab
// activation before the first import has resolved) all wait on the
// same module load.  The persistence hooks route panel-store
// mutations into the existing state.mvInspectorPos / Collapsed /
// Visible maps + persistPrefs so React panels share saved state
// with the legacy panels and stay in lockstep across reloads.
//
// Lives at /ui/ root because it stitches together every section's
// React mount (map editor, unit editor, sandbox, dialogs, welcome
// screen) — neither /ui/common/ nor any individual section owns it.

import { state, setReactUi } from './host-context.js'
import { persistPrefs } from './common/prefs.js'
import { openSizeDialog } from './map-editor/dialogs/size.js'
import { openMapDialog } from './pickers/open-map.js'
import { openModelPicker } from './pickers/open-unit-flow.js'
import { openSandboxStub } from './sandbox/tab.js'
import { openFilesTab } from './files-browser/tab.js'
import { seedInspectorPanelDefaults } from './unit-editor/panel-defaults.js'
import { seedMapPanelDefaults } from './map-editor/panel-defaults.js'
import {
  publishMapRibbonState,
  wireMapRibbonBridge,
} from './map-editor/ribbon/bridge.js'
import {
  wireModelViewerRibbon,
  wireUnitEditorHostBridge,
} from './unit-editor/ribbon/bridge.js'

// _reactUiPromise — single-flight cache for the lazy /ui/mount.js
// import.  Repeated configureReactUi calls return the same Promise
// so multiple init paths (initial boot, hot-reload, tab activation
// before the first import has resolved) all wait on the same module
// load.  The resolved bridge is mirrored onto host-context via
// setReactUi(ui) so other modules can reach it through getReactUi()
// without holding a private reference here.
let _reactUiPromise = null

// configureReactUi — boot the React/Preact island and install the
// persistence bridge.  Idempotent: repeated calls return the same
// Promise so multiple init paths (initial boot, hot-reload, tab
// activation before the first import has resolved) all wait on the
// same module load.  The persistence hooks route panel-store
// mutations into the existing state.mvInspectorPos / Collapsed /
// Visible maps + persistPrefs so React panels share saved state
// with the legacy panels and stay in lockstep across reloads.
export function configureReactUi() {
  if (_reactUiPromise) return _reactUiPromise
  _reactUiPromise = import('/ui/mount.js').then((ui) => {
    // Mirror the bridge onto host-context so the extracted /ui/*
    // modules (open-map dialog, confirm dialog, ribbon bridges,
    // future ones) can reach the React API without a back-reference
    // into studio.js.
    setReactUi(ui)
    ui.configureUi({
      loadPos:       (id) => (state.mvInspectorPos       || {})[id] || null,
      savePos:       (id, pos) => {
        state.mvInspectorPos = state.mvInspectorPos || {}
        state.mvInspectorPos[id] = { top: pos.top, left: pos.left }
        persistPrefs()
      },
      loadCollapsed: (id) => !!(state.mvInspectorCollapsed || {})[id],
      saveCollapsed: (id, on) => {
        state.mvInspectorCollapsed = state.mvInspectorCollapsed || {}
        state.mvInspectorCollapsed[id] = !!on
        persistPrefs()
      },
      loadVisible:   (id, def) => {
        const vis = state.mvInspectorVisible || {}
        return Object.prototype.hasOwnProperty.call(vis, id) ? !!vis[id] : !!def
      },
      saveVisible:   (id, on) => {
        state.mvInspectorVisible = state.mvInspectorVisible || {}
        state.mvInspectorVisible[id] = !!on
        persistPrefs()
        // Both dropdown rows (unit-editor View + sandbox Developer
        // Tools) are React-managed now and subscribe to the panel-
        // store's visible signal directly, so writing through here is
        // enough — the rows re-render on the next signal commit.
      },
    })
    // Seed each migrated inspector panel from the persisted visibility
    // BEFORE the first mount so the Preact tree doesn't flash visible
    // and then hide.  Defaults match the legacy wireMvInspectors path
    // (true unless explicitly closed at some prior session).  Lives
    // in /ui/unit-editor/panel-defaults.js so the per-section IDs are
    // co-located with the inspector code that owns the panels.
    seedInspectorPanelDefaults(ui, state)
    // Install the unit-editor host bridge bundle (camera + cob +
    // runtime + reset + thread-debugger opener) + the Include-Private
    // + Developer-Controls preference bridges in one shot.  Lives in
    // /ui/unit-editor/ribbon/bridge.js so the cluster of unit-editor-
    // specific callbacks is co-located with the ribbon mount.
    wireUnitEditorHostBridge(ui)
    // Bring the inspector panel tree online — sandbox panel is mounted
    // lazily on first sandbox tab activation (it needs the onSpawn
    // callback closure); the always-on inspectors come up at boot so
    // they're ready when the user opens any tab.
    ui.mountInspectorPanels()
    // Mount the React-managed modal dialogs (confirm, Open Unit, Open
    // Map, weapon picker) so their open-state signals are wired and
    // the first opener call paints instantly.
    if (typeof ui.mountDialogs === 'function') ui.mountDialogs()
    // Mount the shared footer status strip.  Done once at boot; the
    // host keeps driving `#status` / `#app-hints` imperatively after.
    if (typeof ui.mountStatusBar === 'function') ui.mountStatusBar()
    // Mount the unit-editor sidebar tab components (Pieces, Textures,
    // Weapons).  Each one renders empty until the host pushes a model
    // via setPieceTreeModel / setTexturesModel — but mounting at boot
    // keeps Preact's reconciler attached so subsequent updates flow
    // straight to the existing DOM instead of replaceChildren-churn.
    if (typeof ui.mountSidebarTabs === 'function') ui.mountSidebarTabs()
    // Mount the React unit-editor ribbon + install its bridge.  The
    // bridge resolves modelViewerInstance / renderer at call time so
    // a tab swap automatically routes to the right one — no per-open
    // re-wiring needed.  Idempotent on subsequent calls.
    wireModelViewerRibbon()
    // Mount the React welcome card body, wiring its tab card buttons
    // into the existing host helpers (showSizeDialog / openOpenDialog
    // / openModelPicker / openSandboxStub).
    if (typeof ui.mountWelcomeScreen === 'function') {
      ui.mountWelcomeScreen({
        onNewMap:     () => openSizeDialog(),
        onOpenMap:    () => openMapDialog('welcome'),
        onOpenUnit:   () => openModelPicker(),
        onOpenSandbox: (opts) => openSandboxStub(opts),
        onBrowseFiles: () => openFilesTab(),
      })
    }
    // Texture / piece-tree / weapons-tab bridges are installed by
    // wireUnitEditorHostBridge (above) so the unit-editor-specific
    // configure calls + their getActiveModelViewer closures stay in
    // /ui/unit-editor/ribbon/bridge.js.
    // ── Map editor surface ───────────────────────────────────────
    // Mount the React-rendered ribbon, sidebar, and three floating
    // panels (Stats, Camera & Cursor, Minimap).  Idempotent — re-
    // mount during File → New / Open is a re-render into the same
    // roots.  The host wiring below routes every button press
    // through the existing studio.js functions (setMode, undo, etc.)
    // so we don't duplicate behaviour.
    if (typeof ui.mountMapEditor === 'function') ui.mountMapEditor()
    wireMapRibbonBridge(ui)
    // Seed default visibility for the map panels so their first
    // mount reads the persisted state (or defaults to visible) and
    // the React tree doesn't flash hidden then show.  Per-panel
    // logic lives in /ui/map-editor/panel-defaults.js next to the
    // map ribbon bridge that owns the matching toggles.
    seedMapPanelDefaults(ui, state)
    // Publish the initial ribbon state so the React ribbon has the
    // right mode label + view toggles on its first paint.
    publishMapRibbonState()
    return ui
  }).catch((err) => {
    console.error('[studio] React UI island failed to load:', err)
    _reactUiPromise = null
    return null
  })
  return _reactUiPromise
}
