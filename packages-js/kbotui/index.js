// @coreprime/kbot-ui — public barrel for KBot Studio's reusable UI chrome.
//
// The ribbon, floating panels, tab strips, split containers, context
// menus and the accordion section all build on a single Preact-bound
// `html` tagged template (htm-bind).  Consumers can either pull the
// whole surface from this barrel or deep-import an individual module
// (e.g. `@coreprime/kbot-ui/ribbon`) via the package's wildcard subpath export.

// The bound htm template, re-exported as `html` for the conventional
// `html\`<div/>\`` call site, and as `htm` for callers that bind it
// under their own alias.
export { htm, htm as html } from './htm-bind.js'

export { AccordionSection } from './accordion-section.js'
export { openContextMenu, closeContextMenu } from './context-menu.js'

export {
  closeAllDropdowns,
  Ribbon,
  RibbonSection,
  RibbonButton,
  RibbonDropdownButton,
  Dropdown,
  closeDropdownById,
  MenuSectionLabel,
  MenuRow,
  MenuToggleRow,
  MenuSubmenuRow,
  MenuSliderRow,
} from './ribbon.js'

export { GraphicsOptionsItems } from './graphics-options-menu.js'

export {
  newLeaf,
  leafIds,
  isOnlyLeaf,
  splitLeaf,
  closeLeaf,
  SplitContainer,
} from './split-container.js'

export {
  splitTreeVersion,
  ensureSplitState,
  mountSplit,
  detachSplit,
  disposeSplit,
  revivePanes,
  startAllRenderers,
  stopAllRenderers,
  splitActivePane,
  closeActivePane,
  canCloseActivePane,
  SplitMenuItems,
} from './split-host.js'

export { FloatingPanelTabStrip } from './floating-panel-tab-strip.js'
export { SideBar, FrozenSlot } from './side-bar.js'
export { SideBarTabStrip } from './side-bar-tab-strip.js'
export { configureTabBarBridge, setTabs, InterfaceTabStrip } from './interface-tab-strip.js'

export {
  rescuePanelIntoStage,
  FloatingPanel,
  CollapsibleSection,
} from './floating-panel.js'

export {
  configurePanelPersistence,
  registerPanel,
  setPanelPos,
  setPanelCollapsed,
  setPanelVisible,
  setPanelSize,
  setSidebarCollapsed,
  sectionSignals,
  setSectionCollapsed,
  panelSignals,
} from './panel-store.js'

// Dialogs + pickers.
export { DialogModal } from './dialog-modal.js'
export { confirmDialog } from './confirm-dialog.js'
export { PickerModal } from './picker-modal.js'

// Form controls + metadata pills.
export { FormField, TextField, SelectField } from './form-field.js'
export { Tag } from './tag.js'
export { GameIcon, GameChip, gameInfo, GAME } from './game-icon.js'

// Explorer chrome + data viewers.
export { Breadcrumbs } from './breadcrumbs.js'
export { SearchBox } from './search-box.js'
export { HexView } from './hex-view.js'
export { fileIcon, fileKind } from './file-icons.js'
export { InterfaceStatusBar } from './interface-status-bar.js'

// Data-fetching hook + placeholder chrome.
export { useAsync, Loading, ErrorMsg } from './async.js'

// Pure formatting + path helpers.
export { formatSize, parentDir, baseName, extOf } from './format.js'
