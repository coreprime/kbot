// mount.js
//
// Single entry point the vanilla studio.js code uses to bring the
// React/Preact UI island online.  Keeps every Preact import + every
// JSX-style template literal behind ONE module boundary so the host
// doesn't have to know how the components are wired internally; it
// just calls `configureUi({...})` once at boot then `mountSandboxPanel()`
// when the sandbox tab activates.
//
// The bridge intentionally exposes ONLY the side effects the host
// cares about — the Preact tree, the signals, the htm machinery
// are all internal.  When future panels migrate they just add a
// mount-XXX export here and the host gets a one-line integration
// point.

import { render } from 'preact'
import { htm as html } from '/ui/common/htm-bind.js'
import { configurePanelPersistence, setPanelVisible } from '/ui/common/panel-store.js'
import { registerReactPanels } from '/ui/common/panel-layout.js'
import { SandboxPanel } from '/ui/sandbox/sandbox-panel.js'
import {
  SandboxRibbon, configureSandboxRibbonBridge, closeSandboxRibbonDropdowns,
  setSandboxGraphicsState,
} from '/ui/sandbox/sandbox-ribbon.js'
import {
  ModelViewerRibbon, configureModelViewerRibbonBridge,
  setModelViewerRibbonState, setModelViewerCobState,
  closeModelViewerRibbonDropdowns,
} from '/ui/unit-editor/ribbon/model-viewer-ribbon.js'
import {
  TabBar, setTabs, configureTabBarBridge,
} from '/ui/common/tab-bar.js'
import { StaticVarsPanel } from '/ui/panels/static-vars-panel.js'
import { AudioPanel } from '/ui/panels/audio-panel.js'
import { EffectsPanel } from '/ui/panels/effects-panel.js'
import { ProjectilesPanel } from '/ui/panels/projectiles-panel.js'
import { MusicPanel } from '/ui/panels/music-panel.js'
import { MovementPanel } from '/ui/panels/movement-panel.js'
import { RendererPanel } from '/ui/panels/renderer-panel.js'
import { ScriptCommandsPanel } from '/ui/panels/script-commands-panel.js'
import { ControlsPanel } from '/ui/panels/controls-panel.js'
import { UnitPortsPanel } from '/ui/panels/unit-ports-panel.js'
import { RuntimePanel } from '/ui/panels/runtime-panel.js'
import { confirmDialog } from '/ui/dialogs/confirm-dialog.js'
import {
  SettingsDialog, openSettingsDialog, closeSettingsDialog,
} from '/ui/dialogs/settings-dialog.js'
import {
  OpenUnitDialog, openUnitDialog, updateUnitDialog, closeUnitDialog,
} from '/ui/pickers/open-unit-dialog.js'
import {
  OpenMapDialog, openMapDialog, updateMapDialog, closeMapDialog,
} from '/ui/pickers/open-map-dialog.js'
import {
  WeaponPickerDialog, openWeaponPicker, updateWeaponPicker, closeWeaponPicker,
} from '/ui/pickers/weapon-picker-dialog.js'
import {
  TexturesTab, setTexturesModel, setTexturesFilter, configureTexturesBridge,
} from '/ui/unit-editor/tabs/textures-tab.js'
import {
  PieceTree, setPieceTreeModel, setPieceTreeFilter, configurePieceTreeBridge,
} from '/ui/unit-editor/tabs/piece-tree.js'
import {
  WeaponsTab, configureWeaponsTabBridge,
} from '/ui/unit-editor/tabs/weapons-tab.js'
import {
  WelcomeScreen, setWelcomeTab,
} from '/ui/screens/welcome/welcome-screen.js'
import { MapStatsPanel } from '/ui/map-editor/panels/map-stats-panel.js'
import { CameraCursorPanel } from '/ui/map-editor/panels/camera-cursor-panel.js'
import { MinimapPanel } from '/ui/map-editor/panels/minimap-panel.js'
import { MapSidebar } from '/ui/map-editor/tabs/sidebar.js'
import { MapRibbon, closeMapRibbonDropdowns } from '/ui/map-editor/ribbon/map-ribbon.js'
import {
  publishMapStats, publishMapCameraInfo, bumpMinimapTick,
  sidebarDrawer, sidebarFilter, sidebarUsedOnly, sidebarWreckage,
  sidebarUsedOnlyVisible, sidebarWreckageVisible,
  configureSidebarBridge,
  publishRibbonState, configureMapRibbonBridge,
} from '/ui/map-editor/store.js'
import {
  publishInspectorState,
  bumpRuntimeTick,
  configureActionsIncludePrivate,
  configureControlsDevSectionVisible,
  setControlsDevSectionVisible,
} from '/ui/common/inspector-store.js'
import { configureHostBridge } from '/ui/common/host-bridge.js'
import { rescuePanelIntoStage } from '/ui/common/floating-panel.js'

// _mountedInspectors — tracks which inspector panels have a Preact
// root mounted.  Used by the host's setMvInspectorVisible bridge so
// it knows whether to route a visibility flip through the panel-
// store (which the React tree subscribes to) or fall through to the
// legacy DOM toggle for not-yet-migrated panels.
const _mountedInspectors = new Set()

function _mountInto(id, factory, parent = null) {
  // Inspectors + sandbox panel are scoped to the model-viewer-stage
  // (so they share the model viewer's overlay z-order + auto-hide
  // when the user switches to a map tab).  Modal dialogs use
  // position:fixed and need to stay visible from the welcome screen
  // too, so they mount to document.body via an explicit `parent`
  // override — otherwise they'd inherit the model-viewer-dialog's
  // `display: none` while the welcome screen is up and never paint.
  const stage = parent || document.querySelector('.model-viewer-stage') || document.body
  let mountRoot = document.getElementById(`${id}-mount`)
  if (!mountRoot) {
    mountRoot = document.createElement('div')
    mountRoot.id = `${id}-mount`
    mountRoot.style.cssText = 'display:contents'
    stage.appendChild(mountRoot)
  }
  render(factory(), mountRoot)
  _mountedInspectors.add(id)
}

// _mountIntoEl — render INTO a host-supplied container element rather
// than appending a fresh mount-root sibling.  Used by the sidebar tab
// components which slot directly into their pre-existing <div>
// containers in index.html (#model-viewer-tree etc.) AND the welcome
// dialog's `.dialog-card` slot (which still ships legacy markup in
// the HTML so the dialog renders something before the React island
// has loaded).
//
// On FIRST render Preact's `render(vnode, parent)` keeps any
// pre-existing children of `parent` as siblings of the newly-rendered
// tree — it diffs the vnode list against an empty internal `__k` and
// inserts only what the vnode asks for, leaving stale legacy nodes
// alone.  That collides with our welcome dialog (legacy markup
// duplicates the React tabs / cards) so we wipe the slot before the
// FIRST mount via the `__k` sentinel.  Subsequent calls re-use the
// existing Preact root + reconcile in place — wiping then would
// destroy the live tree.  Idempotent.
function _mountIntoEl(el, factory) {
  if (!el) return
  if (!el.__k) el.replaceChildren()
  render(factory(), el)
}

// configureUi — host installs persistence callbacks that route the
// panel-store mutations into its own preference system.  All four
// hooks are optional; the panel-store falls back to no-op + in-memory
// state when omitted (useful for tests / isolated playgrounds).
//
// Required keys when wired up:
//   loadPos(id)               — return persisted { top, left } or null
//   savePos(id, pos)          — persist { top, left }
//   loadCollapsed(id)         — return persisted boolean
//   saveCollapsed(id, on)     — persist boolean
//   loadVisible(id, default)  — return persisted boolean (or default)
//   saveVisible(id, on)       — persist boolean
export function configureUi(persistence) {
  configurePanelPersistence(persistence)
}

// mountSandboxPanel — render the React sandbox panel into the model-
// viewer-stage (the same positioning context the legacy panels use).
// Idempotent: if an existing #sandbox-panel mount root is present we
// re-render into it instead of creating a duplicate, so repeated
// sandbox-tab activations don't stack panels.
//
// onSpawn — host callback invoked when the user clicks Spawn Unit.
// Receives the button element so the side picker can be anchored
// next to the gesture.
export function mountSandboxPanel({ onSpawn } = {}) {
  _mountInto('sandbox-panel', () => html`<${SandboxPanel} onSpawn=${onSpawn} />`)
}

// mountSandboxRibbon — render the React sandbox-mode ribbon into the
// host's #sandbox-ribbon-mount slot.  Idempotent.
export function mountSandboxRibbon() {
  const slot = document.getElementById('sandbox-ribbon-mount')
  if (slot) render(html`<${SandboxRibbon} />`, slot)
}

// mountModelViewerRibbon — render the React unit-editor ribbon (Model
// / Camera / Rendering / Scene / Studio Options / COB / View / Configure
// / Help) into the host's #model-viewer-ribbon-mount slot.  Idempotent.
export function mountModelViewerRibbon() {
  const slot = document.getElementById('model-viewer-ribbon-mount')
  if (slot) render(html`<${ModelViewerRibbon} />`, slot)
}

// mountTabBar — render the shared top-of-editor tab strip into the
// #map-tabs-mount slot.  Same data-driven shape for both map tabs +
// model tabs + sandbox tabs.  Host calls setTabs() after every
// open/close/switch to refresh the visible state.
export function mountTabBar() {
  const slot = document.getElementById('map-tabs-mount')
  if (slot) render(html`<${TabBar} />`, slot)
}

// mountInspectorPanels — bring up every Preact-managed floating
// inspector that the host wants visible.  Idempotent + safe to call
// at boot: each component reads its own visibility from the panel-
// store so re-mounting doesn't flash hidden panels visible.  Adding
// a new panel to the migration is a one-line addition here.
export function mountInspectorPanels() {
  _mountInto('mv-inspector-staticvars', () => html`<${StaticVarsPanel} />`)
  _mountInto('mv-inspector-audio',      () => html`<${AudioPanel} />`)
  _mountInto('mv-inspector-effects',    () => html`<${EffectsPanel} />`)
  _mountInto('mv-inspector-projectiles', () => html`<${ProjectilesPanel} />`)
  _mountInto('mv-inspector-music',       () => html`<${MusicPanel} />`)
  _mountInto('mv-inspector-movement',    () => html`<${MovementPanel} />`)
  _mountInto('mv-inspector-camera',     () => html`<${RendererPanel} />`)
  _mountInto('mv-inspector-actions',    () => html`<${ScriptCommandsPanel} />`)
  _mountInto('mv-inspector-ports',      () => html`<${ControlsPanel} />`)
  _mountInto('mv-inspector-unit-ports', () => html`<${UnitPortsPanel} />`)
  _mountInto('mv-inspector-scripts',    () => html`<${RuntimePanel} />`)
}

// mountDialogs — bring up all React-managed modal dialogs.  Each one
// lazy-renders nothing while its open-state signal is null, so the
// mount is effectively free until the first opener call.  Called
// once at boot (alongside mountInspectorPanels) so the dialog
// components are ready when an opener fires.  Mount root lives on
// document.body so the picker stays visible from the welcome screen
// (when the model-viewer-stage's parent is hidden) and from the map
// editor (no stage at all) — the dialog itself is position:fixed so
// its on-screen position doesn't care which container it lives in.
export function mountDialogs() {
  _mountInto('dialogs-confirm',  () => html`<${ConfirmDialogMount} />`, document.body)
  _mountInto('dialogs-settings', () => html`<${SettingsDialog} />`, document.body)
  _mountInto('dialogs-open-unit', () => html`<${OpenUnitDialog} />`, document.body)
  _mountInto('dialogs-open-map',  () => html`<${OpenMapDialog} />`, document.body)
  _mountInto('dialogs-weapon-pick', () => html`<${WeaponPickerDialog} />`, document.body)
}

// ConfirmDialogMount — confirm-dialog.js mounts lazily inside its own
// helper, so this stub keeps the mountDialogs() call shape uniform.
function ConfirmDialogMount() { return null }

// mountSidebarTabs — render the React sidebar tabs (Pieces, Textures,
// Weapons) into the existing #model-viewer-tree / #model-viewer-textures
// / #model-viewer-weapons containers.  Called when the unit editor is
// ready (modelViewerInstance is up).  Idempotent.
export function mountSidebarTabs() {
  _mountIntoEl(document.getElementById('model-viewer-tree'),
    () => html`<${PieceTree} />`)
  _mountIntoEl(document.getElementById('model-viewer-textures'),
    () => html`<${TexturesTab} />`)
  _mountIntoEl(document.getElementById('model-viewer-weapons'),
    () => html`<${WeaponsTab} />`)
}

// mountMapEditor — render the map-editor's React surface: the
// ribbon, the sidebar (tabs + filter row + drawer slot), and the
// three floating panels (Map Stats, Minimap, Camera & Cursor).
// Idempotent: each mount root is created once and reused on
// re-mount.  The existing canvas-wrap children (#minimap-panel,
// #dev-stats-panel, #camera-info-panel) are removed by index.html —
// the React tree owns them now.
//
// Sidebar mounts INTO `.sidebar` so the React tabs + drawer slot
// replace the legacy static markup.  Panels mount as children of
// `.canvas-wrap` so the existing `.minimap` / `.dev-stats` CSS rules
// (which use `position: absolute` relative to the wrap) keep
// applying without any positioning rewrites.
export function mountMapEditor() {
  // Ribbon — mounts INTO #ribbon-mount which the index.html provides
  // as a `display: contents` shell so the React tree's root <div
  // class="ribbon"> still lands as the immediate child of `.app`
  // (the grid template-area `ribbon` is bound to the immediate
  // child class .ribbon).
  const ribbonSlot = document.getElementById('ribbon-mount')
  if (ribbonSlot) render(html`<${MapRibbon} />`, ribbonSlot)
  // Sidebar header (tabs + filter) — mounts into a dedicated slot
  // alongside the static `<div id="drawer">`.  Keeping the drawer
  // outside the React tree is intentional: renderDrawer paints
  // tile / feature buttons directly into `#drawer`, and Preact's
  // child diff would otherwise clobber that paint on every signal
  // change.  Using a `display:contents` mount slot lets the React
  // tree's tabs + filter rows still flex inside the aside grid
  // alongside the drawer below.
  const sidebarSlot = document.getElementById('sidebar-tabs-mount')
  if (sidebarSlot) render(html`<${MapSidebar} />`, sidebarSlot)
  // Three floating panels.  Mount roots are siblings of `.canvas-wrap`'s
  // direct children so the existing `.minimap` / `.dev-stats` positioning
  // CSS works unchanged.
  //
  // The id list is also registered with the shared panel-layout module
  // so its applyPanelLayout pass skips these three when it restores
  // legacy positions — the React FloatingPanel layer owns their
  // coordinates instead.  Keeping the registration adjacent to the
  // mount call ensures the source of truth for "which panels are
  // React-managed" lives where the panels are actually created.
  const mapPanelIds = ['map-stats-panel', 'camera-info-panel', 'minimap-panel']
  registerReactPanels(mapPanelIds)
  const wrap = document.querySelector('.canvas-wrap')
  if (wrap) {
    _mountInto('map-stats-panel',     () => html`<${MapStatsPanel} />`,     wrap)
    _mountInto('camera-info-panel',   () => html`<${CameraCursorPanel} />`, wrap)
    _mountInto('minimap-panel',       () => html`<${MinimapPanel} />`,      wrap)
  }
}

// mountWelcomeScreen — render the React welcome card body into the
// #welcome-dialog's existing dialog-card slot, leaving the surrounding
// glamour cross-fade + NanoFX canvas + ambient audio layers (which
// don't depend on the tab structure) as legacy vanilla DOM.
//
// onNewMap / onOpenMap / onOpenUnit / onOpenSandbox are host
// callbacks fired when the user clicks the matching welcome card.
export function mountWelcomeScreen({ onNewMap, onOpenMap, onOpenUnit, onOpenSandbox } = {}) {
  const dlg = document.getElementById('welcome-dialog')
  if (!dlg) return
  const card = dlg.querySelector('.dialog-card')
  if (!card) return
  _mountIntoEl(card, () => html`
    <${WelcomeScreen}
      onNewMap=${onNewMap}
      onOpenMap=${onOpenMap}
      onOpenUnit=${onOpenUnit}
      onOpenSandbox=${onOpenSandbox} />
  `)
}

// isInspectorMounted — host bridge predicate.  Lets the vanilla
// setMvInspectorVisible decide whether to write through the panel-
// store (React subscribes) or fall back to direct DOM class toggling
// (legacy panels).
export function isInspectorMounted(id) {
  return _mountedInspectors.has(id)
}

// Re-export the panel-store + inspector-store mutation helpers so
// the host can drive the React tree without importing the framework
// modules directly (which keeps the import map's "preact" resolution
// confined to the /ui island).
export {
  setPanelVisible, publishInspectorState, bumpRuntimeTick,
  configureActionsIncludePrivate,
  configureControlsDevSectionVisible, setControlsDevSectionVisible,
  configureHostBridge,
  confirmDialog,
  openSettingsDialog, closeSettingsDialog,
  // Picker dialog openers / state mutators / forced-cancel.
  openUnitDialog, updateUnitDialog, closeUnitDialog,
  openMapDialog,  updateMapDialog,  closeMapDialog,
  openWeaponPicker, updateWeaponPicker, closeWeaponPicker,
  // Sidebar tab data setters + bridge configurators.
  setTexturesModel, setTexturesFilter, configureTexturesBridge,
  setPieceTreeModel, setPieceTreeFilter, configurePieceTreeBridge,
  configureWeaponsTabBridge,
  configureSandboxRibbonBridge, closeSandboxRibbonDropdowns,
  setSandboxGraphicsState,
  configureModelViewerRibbonBridge, setModelViewerRibbonState,
  setModelViewerCobState, closeModelViewerRibbonDropdowns,
  setTabs, configureTabBarBridge,
  // Welcome screen tab nudger.
  setWelcomeTab,
  // Map editor store + bridge installers.  The host calls these to
  // push live state into the React tree (publishMapStats etc.) and
  // to install action handlers (configureMapRibbonBridge).
  publishMapStats, publishMapCameraInfo, bumpMinimapTick,
  configureSidebarBridge,
  publishRibbonState, configureMapRibbonBridge,
  closeMapRibbonDropdowns,
}

// Sidebar signal setters — explicit re-exports so the host can write
// through the signals (used when switchTab + the filter input have to
// reflect the canonical state on every map open).
export function setSidebarDrawer(key) { sidebarDrawer.value = key }
export function setSidebarFilter(text) { sidebarFilter.value = text || '' }
export function setSidebarUsedOnly(on) { sidebarUsedOnly.value = !!on }
export function setSidebarWreckage(on) { sidebarWreckage.value = !!on }
export function setSidebarUsedOnlyVisible(on)   { sidebarUsedOnlyVisible.value = !!on }
export function setSidebarWreckageVisible(on)   { sidebarWreckageVisible.value = !!on }

// showSandboxPanel — flip the panel-store visibility signal so the
// React tree re-renders with the correct .hidden class.  Mirrors
// the vanilla showSandboxPanel(true|false) API the host already
// uses; routing through here keeps the legacy + React paths sharing
// one source of truth.
export function showSandboxPanel(on) {
  setPanelVisible('sandbox-panel', on)
}

// Re-export the rescue clamp so the host's resize hook can include
// React-managed panels in the same bulk-clamp sweep it runs for the
// legacy panels.
export { rescuePanelIntoStage }
