// map-ribbon.js
//
// React-rendered ribbon for the map editor.  Composes the shared
// Ribbon primitives in /ui/common/ribbon.js (same building blocks the
// unit-editor + sandbox ribbons use) so the chrome — colours, hover
// states, dropdown anchoring, outside-click dismissal — stays
// consistent across the three modes.
//
// Every interactive bit fires through the map-ribbon bridge so the
// component doesn't reach into studio.js's globals.  Live state
// (current mode, undo enabled, schema list, etc.) is published to
// `ribbonState` and read here on each render — the host doesn't have
// to imperatively poke individual buttons after a state change, it
// just publishes once and React re-renders the affected sections.

import { useEffect, useRef, useState } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'
import {
  Ribbon, RibbonSection, RibbonButton,
  RibbonDropdownButton, Dropdown,
  MenuRow, MenuToggleRow, MenuSectionLabel, MenuSubmenuRow,
  closeAllDropdowns, closeDropdownById,
} from '/ui/common/ribbon.js'
import { ribbonState, mapRibbonBridge } from '/ui/common/map-editor-store.js'

// _MODES — single source of truth for the Mode dropdown.  Order +
// labels mirror the legacy HTML byte-for-byte so the keyboard
// hot-keys + the tooltips stay consistent with what the user is
// trained on.  `sub` is the optional nested submenu shape — present
// only on modes that show a "current" badge (voids brush, hm tool,
// erase brush, symmetry).
const _MODES = [
  { key: 'select-terrain', icon: '⬚', label: 'Select',         hotkey: 'T',
    title: 'Select — pick an area to drag/rotate' },
  { key: 'view',           icon: '✋', label: 'View',           hotkey: null,
    title: 'View — pan, scroll and zoom without making changes' },
  { key: 'paint',          icon: '🖌', label: 'Tiler',          hotkey: 'P',
    title: 'Place Tiles' },
  { key: 'select-features',icon: '🌳', label: 'Features',       hotkey: 'F',
    title: 'Place Features' },
  { key: 'picker',         icon: '🎯', label: 'Feature Select', hotkey: 'K',
    title: 'Feature Select — marquee multi-select features' },
  { key: 'start-points',   icon: '🤖', label: 'Start Points',   hotkey: 'S',
    title: 'Start Points' },
  { key: 'voids',          icon: '🚫', label: 'Voids',          hotkey: 'D',
    title: 'Voids — paint impassable / no-build cells.  Hover for brush size.',
    sub: 'voids' },
  { key: 'heightmap',      icon: '⛰', label: 'Heightmap',      hotkey: 'H',
    title: 'Heightmap — raise, lower, smooth or level terrain',
    sub: 'hm' },
  { key: 'fill',           icon: '🪣', label: 'Fill',           hotkey: 'B',
    title: 'Bucket fill — replace a connected region of matching tiles with the selected section\'s top-left tile.  Shift-click to replace globally across the whole map.' },
  { key: 'ruler',          icon: '📏', label: 'Ruler',          hotkey: 'R',
    title: 'Ruler — click two points to measure distance + heightmap delta.  Esc clears.' },
  { key: 'erase',          icon: '🧽', label: 'Erase',          hotkey: 'X',
    title: 'Erase — hover for brush size',
    sub: 'erase' },
]

const _VOIDS_SIZES   = [1, 2, 4, 8, 16]
const _ERASE_SIZES   = [1, 2, 3, 4, 6, 8]
const _HM_RADII      = [1, 2, 4, 8, 16]
const _HM_TOOLS      = [
  ['raise',  'Raise',  'Raise terrain under the brush'],
  ['lower',  'Lower',  'Lower terrain under the brush'],
  ['smooth', 'Smooth', 'Smooth terrain under the brush'],
  ['level',  'Level',  'Set terrain to the cell first clicked'],
]
const _HM_STRENGTHS  = [
  [1,  'Light (1)'],
  [4,  'Normal (4)'],
  [12, 'Heavy (12)'],
]
const _SYM_OPTS = [
  ['off', '·',  'Off',        'No mirroring'],
  ['x',   '↔',  'Vertical',   'Mirror across the vertical centre (left↔right)'],
  ['y',   '↕',  'Horizontal', 'Mirror across the horizontal centre (top↔bottom)'],
  ['xy',  '✛',  'Both',       'Mirror across both axes (4-way)'],
]
const _SYM_LABELS = { off: 'Off', x: 'Vertical', y: 'Horizontal', xy: 'Both' }

// _modeBadgeLabel — small text the Mode toolbar button shows next to
// its icon.  Mirrors the active mode entry's label.
function _modeBadgeLabel(mode) {
  const m = _MODES.find((x) => x.key === mode)
  return m ? m.label : 'Mode'
}
function _modeBadgeIcon(mode) {
  const m = _MODES.find((x) => x.key === mode)
  return m ? m.icon : '🖌'
}

// _VIEW_DISPLAY — top section of the View dropdown (display mode
// picker: map / heightmap / blended).
const _VIEW_DISPLAY = [
  ['map',       '🗺', 'Map'],
  ['heightmap', '⛰', 'Height'],
  ['blended',   '🏞', 'Blended'],
]

// _displayLabel — text shown on the View button next to the eye icon.
function _displayLabel(viewMode) {
  const d = _VIEW_DISPLAY.find((x) => x[0] === viewMode)
  return d ? d[2] : 'Map'
}

// ── Sub-components ─────────────────────────────────────────────────

function FileDropdown() {
  return html`
    <div class="ribbon-dropdown" id="file-dropdown">
      <${RibbonDropdownButton}
        id="file-dropdown-btn"
        dropdownId="file-dropdown"
        icon="📁"
        label="File"
        title="File actions" />
      <${Dropdown} id="file-dropdown" anchorId="file-dropdown-btn">
        <${MenuRow} icon="📄" label="New" dropdownId="file-dropdown"
          title="Start a new map (discards the current one)"
          onClick=${() => mapRibbonBridge.fileNew()} />
        <${MenuRow} icon="🪟" label="New Window" dropdownId="file-dropdown"
          title="Open another KBot Studio in a new browser tab so you can work on two maps side by side"
          onClick=${() => mapRibbonBridge.fileNewWindow()} />
        <${MenuRow} icon="📂" label="Open" dropdownId="file-dropdown"
          title="Open an existing map from the loaded game data"
          onClick=${() => mapRibbonBridge.fileOpen()} />
        <${MenuRow} icon="💾" label="Save" dropdownId="file-dropdown"
          title="Save current map as .hpi"
          onClick=${() => mapRibbonBridge.fileSave()} />
        <${MenuRow} icon="📑" label="Save loose…" dropdownId="file-dropdown"
          title="Save loose .tnt + .ota files (no HPI wrapper)"
          onClick=${() => mapRibbonBridge.fileSaveLoose()} />
      <//>
    </div>
  `
}

function EditDropdown() {
  return html`
    <div class="ribbon-dropdown" id="edit-dropdown">
      <${RibbonDropdownButton}
        id="edit-dropdown-btn"
        dropdownId="edit-dropdown"
        icon="📋"
        label="Edit"
        title="Clipboard: copy, paste, and paste-special" />
      <${Dropdown} id="edit-dropdown" anchorId="edit-dropdown-btn">
        <${MenuRow} icon="✂" label="Cut" dropdownId="edit-dropdown"
          title="Copy the current Select-Terrain rectangle to the clipboard and clear the underlying tiles, heights and features."
          onClick=${() => mapRibbonBridge.editCut()} />
        <${MenuRow} icon="📋" label="Copy" dropdownId="edit-dropdown"
          title="Copy the current Select-Terrain rectangle to the clipboard.  Works across KBot Studio tabs / Chrome windows."
          onClick=${() => mapRibbonBridge.editCopy()} />
        <${MenuRow} icon="📌" label="Paste" dropdownId="edit-dropdown"
          title="Paste a previously-copied rectangle.  Tiles, heightmap cells and any features all come along."
          onClick=${() => mapRibbonBridge.editPaste()} />
        <${MenuSectionLabel}>Paste special<//>
        <${MenuRow} icon="🌳" label="Paste features only" dropdownId="edit-dropdown"
          title="Paste only the features from the clipboard rectangle — tiles and heightmap left as-is."
          onClick=${() => mapRibbonBridge.editPasteFeatures()} />
        <${MenuRow} icon="🖌" label="Paste tiles only" dropdownId="edit-dropdown"
          title="Paste only the tiles + heightmap from the clipboard rectangle — features dropped on the floor."
          onClick=${() => mapRibbonBridge.editPasteTiles()} />
        <${MenuSectionLabel}>Clear<//>
        <${MenuRow} icon="🧹" label="Clear region" dropdownId="edit-dropdown"
          title="Empty the current Select-Terrain rectangle — tiles, heights and features inside it are wiped.  Distinct from the Erase brush which paints cell-by-cell."
          onClick=${() => mapRibbonBridge.editClearRegion()} />
        <${MenuRow} icon="🌲" label="Clear features in selection" dropdownId="edit-dropdown"
          title="Remove features inside the current Select-Terrain rectangle.  Tiles and heights are left alone."
          onClick=${() => mapRibbonBridge.editClearFeaturesInSel()} />
        <${MenuRow} icon="🔥" label="Clear all features" dropdownId="edit-dropdown"
          title="Remove every feature on the map.  Tiles and heights are left alone."
          onClick=${() => mapRibbonBridge.editClearAllFeatures()} />
      <//>
    </div>
  `
}

// _SymmetryRow — the toggle-submenu row that lives at the bottom of
// the Mode dropdown.  Hover reveals the 4-option submenu (Off /
// Vertical / Horizontal / Both); clicking the row body toggles
// between Off and whatever the last non-Off pick was (mirrors the
// legacy refreshSymmetryRow behaviour).
function _SymmetryRow({ symmetry }) {
  const on = symmetry !== 'off'
  return html`
    <${MenuSubmenuRow}
      icon="⇆"
      label="Symmetry"
      currentLabel=${_SYM_LABELS[symmetry] || 'Off'}
      on=${on}
      onToggle=${(next) => {
        // Pre-React behaviour: clicking the row toggles between Off
        // and the last-selected axis.  When the user has never picked
        // anything, default to 'x' on first activation.
        if (next) mapRibbonBridge.setSymmetry(symmetry === 'off' ? 'x' : symmetry)
        else      mapRibbonBridge.setSymmetry('off')
      }}
      title="Symmetry — mirror painting across one or both axes.  Hover for options.">
      ${_SYM_OPTS.map(([key, ico, lbl, tip]) => html`
        <button key=${key}
                class=${'menu-row' + (symmetry === key ? ' active' : '')}
                title=${tip}
                onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.setSymmetry(key) }}>
          <span class="ico">${ico}</span><span>${lbl}</span>
        </button>
      `)}
    <//>
  `
}

function _VoidsBrushSubmenu({ size }) {
  return html`
    <${MenuSectionLabel}>Voids brush (attribute cells)<//>
    ${_VOIDS_SIZES.map((s) => html`
      <button key=${s}
              class=${'menu-row' + (size === s ? ' active' : '')}
              onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.setVoidsBrush(s) }}>
        <span class="ico">▪</span><span>${s}×${s}</span>
      </button>
    `)}
  `
}

function _EraseBrushSubmenu({ scope, size }) {
  return html`
    <${MenuSectionLabel}>Erase scope<//>
    <div class="inline-row" id="erase-scope-row">
      ${[
        ['all',      'All',      'Erase tiles and features'],
        ['terrain',  'Terrain',  'Erase only terrain tiles'],
        ['features', 'Features', 'Erase only placed features'],
      ].map(([key, label, tip]) => html`
        <button key=${key}
                class=${'menu-row scope-row' + (scope === key ? ' active' : '')}
                title=${tip}
                onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.setEraseScope(key) }}>
          ${label}
        </button>
      `)}
    </div>
    <${MenuSectionLabel}>Brush size<//>
    ${_ERASE_SIZES.map((s) => html`
      <button key=${s}
              class=${'menu-row' + (size === s ? ' active' : '')}
              onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.setEraseSize(s) }}>
        <span class="ico">▪</span><span>${s}×${s}</span>
      </button>
    `)}
  `
}

function _HmBrushSubmenu({ tool, radius, strength }) {
  return html`
    <${MenuSectionLabel}>Tool<//>
    <div class="inline-row" id="hm-tool-row">
      ${_HM_TOOLS.map(([key, label, tip]) => html`
        <button key=${key}
                class=${'menu-row scope-row' + (tool === key ? ' active' : '')}
                title=${tip}
                onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.setHmTool(key) }}>
          ${label}
        </button>
      `)}
    </div>
    <${MenuSectionLabel}>Radius (attribute cells)<//>
    ${_HM_RADII.map((r) => html`
      <button key=${r}
              class=${'menu-row' + (radius === r ? ' active' : '')}
              onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.setHmRadius(r) }}>
        <span class="ico">○</span><span>${r}</span>
      </button>
    `)}
    <${MenuSectionLabel}>Strength<//>
    ${_HM_STRENGTHS.map(([s, label]) => html`
      <button key=${s}
              class=${'menu-row' + (strength === s ? ' active' : '')}
              onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.setHmStrength(s) }}>
        <span class="ico">·</span><span>${label}</span>
      </button>
    `)}
  `
}

// _ModeRow — one row of the Mode dropdown.  If the mode has a sub
// (voids / erase / heightmap), render a custom hover-revealing
// submenu row that fires setMode on the row body AND keeps the
// submenu open while the cursor hovers it.  We deliberately do NOT
// reuse MenuSubmenuRow here — its built-in click handler insists on
// either toggling a boolean state OR rendering a check glyph, and
// the Mode menu rows need neither (clicks always commit the mode,
// the active row gets the standard `.active` class).  A small
// dedicated component is clearer than fighting through the toggle
// flag indirection.
function _ModeRowSubmenu({ entry, active, badgeLabel, dropdownId: _dropdownId, voidsBrushSize, eraseSize, eraseScope, hmTool, hmRadius, hmStrength }) {
  const rowRef = useRef(null)
  const subRef = useRef(null)
  const [open, setOpen] = useState(false)
  // mouseenter on the row opens the submenu; mouseleave (on either
  // the row OR the submenu) closes it after a short grace period so
  // the cursor can traverse the gap between them.
  useEffect(() => {
    const row = rowRef.current
    if (!row) return undefined
    let inRow = false, inSub = false
    const update = () => setOpen(inRow || inSub)
    const onRowEnter = () => { inRow = true;  update() }
    const onRowLeave = () => { inRow = false; setTimeout(update, 10) }
    const onSubEnter = () => { inSub = true;  update() }
    const onSubLeave = () => { inSub = false; setTimeout(update, 10) }
    row.addEventListener('mouseenter', onRowEnter)
    row.addEventListener('mouseleave', onRowLeave)
    const sub = subRef.current
    if (sub) {
      sub.addEventListener('mouseenter', onSubEnter)
      sub.addEventListener('mouseleave', onSubLeave)
    }
    return () => {
      row.removeEventListener('mouseenter', onRowEnter)
      row.removeEventListener('mouseleave', onRowLeave)
      if (sub) {
        sub.removeEventListener('mouseenter', onSubEnter)
        sub.removeEventListener('mouseleave', onSubLeave)
      }
    }
  }, [])
  const cls = [
    'menu-row', 'has-sub',
    open ? 'open' : '',
    active ? 'active' : '',
  ].filter(Boolean).join(' ')
  return html`
    <div ref=${rowRef} class=${cls} title=${entry.title}
         role="button"
         onClick=${(e) => {
           // Submenu children stopPropagation in their own click
           // handlers, so we only land here when the user actually
           // clicked the row body — that's our cue to commit the
           // mode without dismissing the dropdown.
           if (e.target.closest('.ribbon-submenu')) return
           e.stopPropagation()
           mapRibbonBridge.setMode(entry.key)
         }}>
      <span class="ico">${entry.icon}</span>
      <span>${entry.label}</span>
      ${entry.hotkey ? html`<kbd class="menu-row-hotkey">${entry.hotkey}</kbd>` : null}
      <span class="sub-current">${badgeLabel}</span>
      <span class="sub-chev">▸</span>
      <div ref=${subRef}
           class=${'ribbon-dropdown-popup ribbon-submenu' + (open ? '' : ' hidden')}>
        ${entry.sub === 'voids' ? html`<${_VoidsBrushSubmenu} size=${voidsBrushSize} />` : null}
        ${entry.sub === 'erase' ? html`<${_EraseBrushSubmenu} size=${eraseSize} scope=${eraseScope} />` : null}
        ${entry.sub === 'hm'    ? html`<${_HmBrushSubmenu} tool=${hmTool} radius=${hmRadius} strength=${hmStrength} />` : null}
      </div>
    </div>
  `
}

function _ModeRow({ entry, active, dropdownId }) {
  return html`
    <${MenuRow}
      icon=${entry.icon}
      label=${html`
        ${entry.label}
        ${entry.hotkey ? html`<kbd class="menu-row-hotkey">${entry.hotkey}</kbd>` : null}
      `}
      active=${active}
      title=${entry.title}
      dropdownId=${dropdownId}
      onClick=${() => mapRibbonBridge.setMode(entry.key)} />
  `
}

function ModeDropdown({ state: s }) {
  // Badge labels mirror the legacy sub-current-lbl text — show the
  // active brush size so the user knows what the next click will do
  // without expanding the submenu.
  const voidsBadge = `${s.voidsBrushSize}×${s.voidsBrushSize}`
  const eraseBadge = `${s.eraseSize}×${s.eraseSize}`
  const hmBadge    = `${(_HM_TOOLS.find((t) => t[0] === s.hmTool)?.[1]) || 'Raise'} · ${s.hmStrength}`
  return html`
    <div class="ribbon-dropdown" id="mode-dropdown">
      <${RibbonDropdownButton}
        id="mode-dropdown-btn"
        dropdownId="mode-dropdown"
        icon=${_modeBadgeIcon(s.mode)}
        label=${_modeBadgeLabel(s.mode)}
        title="Editor mode — choose what clicks on the canvas do" />
      <${Dropdown} id="mode-dropdown" anchorId="mode-dropdown-btn">
        ${_MODES.map((entry) => {
          const active = s.mode === entry.key
          if (!entry.sub) {
            return html`<${_ModeRow} key=${entry.key} entry=${entry}
              active=${active} dropdownId="mode-dropdown" />`
          }
          const badge = entry.sub === 'voids' ? voidsBadge
                       : entry.sub === 'erase' ? eraseBadge
                       : hmBadge
          return html`<${_ModeRowSubmenu} key=${entry.key} entry=${entry}
            active=${active}
            badgeLabel=${badge}
            dropdownId="mode-dropdown"
            voidsBrushSize=${s.voidsBrushSize}
            eraseSize=${s.eraseSize} eraseScope=${s.eraseScope}
            hmTool=${s.hmTool} hmRadius=${s.hmRadius} hmStrength=${s.hmStrength} />`
        })}
        <${_SymmetryRow} symmetry=${s.symmetry} />
      <//>
    </div>
  `
}

function ActionsDropdown({ state: s }) {
  return html`
    <div class="ribbon-dropdown" id="actions-dropdown">
      <${RibbonDropdownButton}
        id="actions-dropdown-btn"
        dropdownId="actions-dropdown"
        icon="↶"
        label="Editing Tools"
        title="Undo / redo + editing tools" />
      <${Dropdown} id="actions-dropdown" anchorId="actions-dropdown-btn">
        <${_UndoSubmenuRow} state=${s} />
        <${_RedoSubmenuRow} state=${s} />
        <${MenuSectionLabel}>Tools<//>
        <${MenuRow} icon="📐" label="Resize" dropdownId="actions-dropdown"
          title="Resize map dimensions"
          onClick=${() => mapRibbonBridge.openResize()} />
        <${MenuRow} icon="🎲" label="Scatter features…" dropdownId="actions-dropdown"
          title="Randomly scatter features across the map"
          onClick=${() => mapRibbonBridge.openScatter()} />
        <${MenuRow} icon="⛰" label="Export Heightmap" dropdownId="actions-dropdown"
          title="Export heightmap as 8-bit greyscale PNG"
          onClick=${() => mapRibbonBridge.exportHeightmap()} />
        <${MenuRow} icon="📥" label="Import Heightmap" dropdownId="actions-dropdown"
          title="Import heightmap from greyscale PNG (matched to current attr-cell resolution)"
          onClick=${() => mapRibbonBridge.importHeightmap()} />
      <//>
    </div>
  `
}

// _HoverSubmenuRow — generic "click the body to fire, hover to reveal
// a submenu" row.  Same hover mechanics as _ModeRowSubmenu, but
// without the brush-badge / sub-mode kinematics; used by Undo and
// Redo where clicking commits the action AND the hover reveals a
// multi-step jump list.
function _HoverSubmenuRow({ icon, label, hotkey, title, dropdownId, onClick, children }) {
  const rowRef = useRef(null)
  const subRef = useRef(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const row = rowRef.current
    if (!row) return undefined
    let inRow = false, inSub = false
    const update = () => setOpen(inRow || inSub)
    const onRowEnter = () => { inRow = true;  update() }
    const onRowLeave = () => { inRow = false; setTimeout(update, 10) }
    const onSubEnter = () => { inSub = true;  update() }
    const onSubLeave = () => { inSub = false; setTimeout(update, 10) }
    row.addEventListener('mouseenter', onRowEnter)
    row.addEventListener('mouseleave', onRowLeave)
    const sub = subRef.current
    if (sub) {
      sub.addEventListener('mouseenter', onSubEnter)
      sub.addEventListener('mouseleave', onSubLeave)
    }
    return () => {
      row.removeEventListener('mouseenter', onRowEnter)
      row.removeEventListener('mouseleave', onRowLeave)
      if (sub) {
        sub.removeEventListener('mouseenter', onSubEnter)
        sub.removeEventListener('mouseleave', onSubLeave)
      }
    }
  }, [])
  return html`
    <div ref=${rowRef}
         class=${'menu-row has-sub' + (open ? ' open' : '')}
         role="button"
         title=${title}
         onClick=${(e) => {
           if (e.target.closest('.ribbon-submenu')) return
           e.stopPropagation()
           if (onClick) onClick()
           if (dropdownId) closeDropdownById(dropdownId)
         }}>
      <span class="ico">${icon}</span>
      <span>${label}</span>
      ${hotkey ? html`<kbd class="menu-row-hotkey">${hotkey}</kbd>` : null}
      <span class="sub-chev">▸</span>
      <div ref=${subRef}
           class=${'ribbon-dropdown-popup ribbon-submenu' + (open ? '' : ' hidden')}>
        ${children}
      </div>
    </div>
  `
}

function _UndoSubmenuRow({ state: s }) {
  const enabled = !!s.undoEnabled
  const history = s.undoHistory || []
  if (!enabled) {
    return html`
      <button class="menu-row" disabled title="Nothing to undo">
        <span class="ico">↶</span><span>${s.undoLabel || 'Undo'}</span>
        <kbd class="menu-row-hotkey">⌘Z</kbd>
      </button>
    `
  }
  return html`
    <${_HoverSubmenuRow}
      icon="↶"
      label=${s.undoLabel}
      hotkey="⌘Z"
      title="Undo the most recent change.  Hover for a multi-step jump."
      dropdownId="actions-dropdown"
      onClick=${() => mapRibbonBridge.undo()}>
      <${MenuSectionLabel}>Next undo →<//>
      ${history.map((entry, idx) => html`
        <button key=${idx}
                class="menu-row"
                onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.jumpUndoTo(idx + 1) }}>
          <span class="ico">↶</span><span>${entry.label}</span>
        </button>
      `)}
    <//>
  `
}

function _RedoSubmenuRow({ state: s }) {
  const enabled = !!s.redoEnabled
  const history = s.redoHistory || []
  if (!enabled) {
    return html`
      <button class="menu-row" disabled title="Nothing to redo">
        <span class="ico">↷</span><span>${s.redoLabel || 'Redo'}</span>
        <kbd class="menu-row-hotkey">⇧⌘Z</kbd>
      </button>
    `
  }
  return html`
    <${_HoverSubmenuRow}
      icon="↷"
      label=${s.redoLabel}
      hotkey="⇧⌘Z"
      title="Redo the most recently undone change.  Hover for a multi-step jump."
      dropdownId="actions-dropdown"
      onClick=${() => mapRibbonBridge.redo()}>
      <${MenuSectionLabel}>Next redo →<//>
      ${history.map((entry, idx) => html`
        <button key=${idx}
                class="menu-row"
                onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.jumpRedoTo(idx + 1) }}>
          <span class="ico">↷</span><span>${entry.label}</span>
        </button>
      `)}
    <//>
  `
}

function ZoomButtons() {
  return html`
    <${RibbonButton} id="zoom-out" icon="－" title="Zoom out (scroll-wheel down)"
      onClick=${() => mapRibbonBridge.zoomOut()} />
    <${RibbonButton} id="zoom-in"  icon="＋" title="Zoom in (scroll-wheel up)"
      onClick=${() => mapRibbonBridge.zoomIn()} />
    <${RibbonButton} id="zoom-fit" label="Fit" title="Fit map to view"
      onClick=${() => mapRibbonBridge.zoomFit()} />
  `
}

function ViewDropdown({ state: s }) {
  return html`
    <div class="ribbon-dropdown" id="view-dropdown">
      <${RibbonDropdownButton}
        id="view-dropdown-btn"
        dropdownId="view-dropdown"
        icon="👁"
        label=${_displayLabel(s.viewMode)}
        title="Gridlines / animation / display mode" />
      <${Dropdown} id="view-dropdown" anchorId="view-dropdown-btn">
        <${MenuSectionLabel}>Display mode<//>
        <div class="inline-row" id="display-mode-group">
          ${_VIEW_DISPLAY.map(([key, ico, label]) => html`
            <button key=${key}
                    class=${'menu-row' + (s.viewMode === key ? ' active' : '')}
                    onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.setDisplayMode(key) }}>
              <span class="ico">${ico}</span><span>${label}</span>
            </button>
          `)}
        </div>
        <${MenuSectionLabel}>Overlays<//>
        <${MenuToggleRow} icon="⌗" label="Grid" on=${s.showGridlines}
          onChange=${() => mapRibbonBridge.toggleGridlines()} />
        <${MenuToggleRow} icon="▶" label="Animation" on=${s.animateFeatures}
          onChange=${() => mapRibbonBridge.toggleAnimate()} />
        <${MenuToggleRow} icon="🗺" label="Minimap" on=${s.showMinimap}
          onChange=${() => mapRibbonBridge.toggleMinimap()} />
        <${MenuToggleRow} icon="📷" label="Camera & Cursor" on=${s.showCameraInfo}
          onChange=${() => mapRibbonBridge.toggleCameraInfo()} />
        <${MenuToggleRow} icon="🚫" label="Voids" on=${s.showVoids}
          title="Show void / no-build cells in red.  Always on while Voids mode is active."
          onChange=${() => mapRibbonBridge.toggleVoids()} />
        <${MenuToggleRow} icon="〰" label="Show Contours" on=${s.showContours}
          title="Overlay height contour lines on the Map view.  Already always shown in Heightmap view."
          onChange=${() => mapRibbonBridge.toggleContours()} />
        <${MenuToggleRow} icon="🏗" label="Buildable Area" on=${s.showBuildable}
          title="Shade attribute cells that pass TA's build rules — not void, above sea level, slope within tolerance.  Blends with the void overlay when both are on."
          onChange=${() => mapRibbonBridge.toggleBuildable()} />
        <${MenuToggleRow} icon="🌳" label="Features" on=${s.showFeatures}
          title="Show placed features.  Forced on while Feature Select / Features modes are active."
          onChange=${() => mapRibbonBridge.toggleFeatures()} />
        <${MenuToggleRow} icon="🤖" label="Start Points" on=${s.showStartPositions}
          title="Show player start positions.  Forced on while Start Points mode is active."
          onChange=${() => mapRibbonBridge.toggleStartPos()} />
      <//>
    </div>
  `
}

function SchemaDropdown({ state: s }) {
  const list = s.schemaList || []
  const adds = s.schemaAddCounts || []
  return html`
    <div class="ribbon-dropdown" id="schema-dropdown" data-keep-compact>
      <${RibbonDropdownButton}
        id="schema-dropdown-btn"
        dropdownId="schema-dropdown"
        icon="🎲"
        label=${s.schemaName || 'Schema'}
        title="Active multiplayer schema — pick, add, or delete" />
      <${Dropdown} id="schema-dropdown" anchorId="schema-dropdown-btn">
        <${MenuSectionLabel}>Schemas<//>
        ${list.length === 0 ? html`
          <div class="menu-row" style="opacity:0.6; pointer-events:none">No schemas</div>
        ` : list.map((entry) => html`
          <div key=${entry.index} class="schema-row">
            <button class=${'menu-row schema-pick' + (entry.active ? ' active' : '')}
                    title=${entry.tooltip || ''}
                    onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.pickSchema(entry.index) }}>
              <span class="ico">${entry.active ? '✓' : '·'}</span><span>${entry.label}</span>
            </button>
            <button class="menu-row schema-edit"
                    title="Edit this schema's metal / energy / units / start positions"
                    onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.openSchemaEditor(entry.index) }}>
              <span class="ico">✎</span>
            </button>
            ${list.length > 1 ? html`
              <button class="menu-row schema-delete"
                      title="Delete this schema"
                      onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.deleteSchema(entry.index) }}>
                <span class="ico">✕</span>
              </button>
            ` : null}
          </div>
        `)}
        <${MenuSectionLabel}>Add<//>
        <div id="schema-add-grid" class="schema-add-grid">
          ${adds.map((a) => html`
            <button key=${a.count}
                    class="dice-tile"
                    title=${a.label2 || `Add a ${a.label} schema`}
                    onClick=${(e) => { e.stopPropagation(); mapRibbonBridge.addSchema(a.count) }}>
              <div class="dice-label">${a.label}</div>
            </button>
          `)}
        </div>
      <//>
    </div>
  `
}

function AdvancedDropdown() {
  return html`
    <div class="ribbon-dropdown" id="advanced-dropdown">
      <${RibbonDropdownButton}
        id="advanced-dropdown-btn"
        dropdownId="advanced-dropdown"
        icon="🛠"
        label="Advanced"
        title="Advanced tools — exports and diagnostics. More coming." />
      <${Dropdown} id="advanced-dropdown" anchorId="advanced-dropdown-btn">
        <${MenuSectionLabel}>Export<//>
        <${MenuRow} icon="🗺" label="Export Minimap" dropdownId="advanced-dropdown"
          title="Export minimap as PNG (252×252, aspect-fit)"
          onClick=${() => mapRibbonBridge.exportMinimap()} />
        <${MenuRow} icon="🖼" label="Export Full Render" dropdownId="advanced-dropdown"
          title="Render the map with feature sprites and numbered StartPos markers for the active schema — file can be very large for big maps"
          onClick=${() => mapRibbonBridge.exportFullRender()} />
        <${MenuRow} icon="🗾" label="Export Map Image" dropdownId="advanced-dropdown"
          title="Export the bare tile grid at 1:1 (32 px per tile), no features or markers — file can be very large for big maps"
          onClick=${() => mapRibbonBridge.exportMapImage()} />
        <${MenuRow} icon="🧱" label="Export Buildmap" dropdownId="advanced-dropdown"
          title="Export the per-cell buildability classification PNG (green=buildable, blue=water, yellow=cliff, red=feature, black=void)"
          onClick=${() => mapRibbonBridge.exportBuildmap()} />
        <${MenuRow} icon="⬛" label="Export Voidmap" dropdownId="advanced-dropdown"
          title="Export the engine-void mask PNG (cells with Feature == 0xFFFC)"
          onClick=${() => mapRibbonBridge.exportVoidmap()} />
        <${MenuSectionLabel}>Quality<//>
        <${MenuRow} icon="🧪" label="Quality Check…" dropdownId="advanced-dropdown"
          title="Run the Quality Checker without saving — inspect and optionally fix the current map"
          onClick=${() => mapRibbonBridge.runQualityCheck()} />
        <${MenuSectionLabel}>Diagnostics<//>
        <${MenuRow} icon="🔬" label="Developer" dropdownId="advanced-dropdown"
          title="Developer information"
          onClick=${() => mapRibbonBridge.openDeveloper()} />
      <//>
    </div>
  `
}

// ── Top-level ribbon ──────────────────────────────────────────────

export function MapRibbon() {
  const s = ribbonState.value
  return html`
    <${Ribbon} id="ribbon">
      <${RibbonSection} label="File"><${FileDropdown} /><//>
      <${RibbonSection} label="Edit"><${EditDropdown} /><//>
      <${RibbonSection} label="Mode"><${ModeDropdown} state=${s} /><//>
      <${RibbonSection} label="Actions"><${ActionsDropdown} state=${s} /><//>
      <${RibbonSection} label="Zoom"><${ZoomButtons} /><//>
      <${RibbonSection} label="View"><${ViewDropdown} state=${s} /><//>
      <${RibbonSection} id="schema-section" label="Map Settings">
        <div class="ribbon-group" id="map-settings-group">
          <${RibbonButton} id="btn-ota" icon="⚙" label="Properties"
            title="Edit map properties (OTA metadata) — mission name, planet, players, water flags"
            onClick=${() => mapRibbonBridge.openOTA()} />
          <${SchemaDropdown} state=${s} />
        </div>
      <//>
      <${RibbonSection} label="Configure" right=${true}>
        <${RibbonButton} id="btn-settings" icon="⚙" label="Settings"
          title="KBot Studio settings — zoom, brushes, heartbeat, panel defaults"
          onClick=${() => mapRibbonBridge.openSettings()} />
      <//>
      <${RibbonSection} label="Advanced"><${AdvancedDropdown} /><//>
      <${RibbonSection} label="Help">
        <${RibbonButton} id="btn-help" icon="❓" label="Help"
          title="Keyboard shortcuts and tips (?)"
          onClick=${() => mapRibbonBridge.openHelp()} />
      <//>
    <//>
  `
}

// closeMapRibbonDropdowns — host helper for "external" close triggers
// (e.g. switching tabs, opening a modal).  Routes through the shared
// closeAllDropdowns so unit-editor / sandbox dropdowns get dismissed
// in the same gesture if they happen to be open in a different tab.
export function closeMapRibbonDropdowns() {
  closeAllDropdowns()
}
