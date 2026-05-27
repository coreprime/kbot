// keyboard.js
//
// The map editor's global keyboard handler.  Owns the document-level
// keydown / keyup wiring that drives every editor hotkey:
//
//   - Escape         — closes any open dialog first (OTA, Resize,
//                      Developer, Help, Settings, Open Map, Schema
//                      Editor), then dismisses the open ribbon
//                      dropdown if one's up, otherwise clears the
//                      transient tool state (placement ghost,
//                      terrain clipboard, ruler, selections) and
//                      drops the user back into Select.
//   - ?              — opens the help cheat-sheet.
//   - Space (hold)   — engages the pan hotkey (mirrored on keyup).
//   - Ctrl/Cmd Z/Y   — undo / redo.
//   - Ctrl/Cmd A     — select all content into a Select-Area
//                      clipboard.
//   - Ctrl/Cmd C/X/V — copy / cut / paste through the system
//                      clipboard.
//   - V              — toggle the Voids view-menu flag.
//   - P/T/F/G/K/S/X/D/H/B/R — mode switches (Paint, Select-Terrain,
//                      Features-or-Flip-H, Flip-V, Picker, Start
//                      Points, Erase, Voids, Heightmap, Fill,
//                      Ruler).  F and G defer to flipActive when a
//                      section is currently in play so the user can
//                      flip without leaving the workflow.
//   - Q / E          — rotate the active subject (placement preview,
//                      terrain clipboard, or pre-selected section)
//                      counter-clockwise / clockwise.
//   - Shift+Up/Down  — zoom in / out at the keyboard.
//   - Arrow keys     — when a section is the active selection,
//                      Left / Right page through sectionsList;
//                      otherwise the arrows start a continuous pan
//                      that ramps from 1× to the accel multiplier
//                      while held.
//   - PageUp/Down    — zoom in / out (same step as the toolbar).
//   - Home           — fit zoom.
//   - Delete /
//     Backspace      — handleDeleteKey dispatch (picker selection,
//                      single feature, terrain clipboard discard,
//                      or active start-position removal).
//
// Cross-module deps that come back through hostCallbacks rather than
// direct imports — these still live in studio.js this round:
//   - pageSectionSibling(direction)  — paged-arrow shortcut still
//                                       lives studio-side because it
//                                       hangs off selectSection.
//
// Everything else (dialog closers, ribbon-popup hide, undo / redo,
// clipboard, zoom + pan, mode + view toggles, rotation + flip,
// delete dispatch, …) is reached through direct imports against the
// modules each piece lives in.

import { $, $$, state, hostCallbacks } from '../host-context.js'
import { undo, redo } from './undo.js'
import {
  cutSelection,
  copyToClipboard,
  pasteFromClipboard,
  cancelTerrainClipboard,
} from './clipboard.js'
import { setVoidsVisible } from './view-toggles.js'
import {
  setZoom,
  fitZoom,
  startMapPan,
  stopMapPan,
  stopAllMapPan,
} from './zoom-pan.js'
import { getSpacePanHotkey, setSpacePanHotkey } from './cursor.js'
import { renderCanvas } from './canvas/render.js'
import {
  setMode,
  rotateActive,
  flipActive,
  handleDeleteKey,
  selectAllContent,
  cancelPlacement,
  clearStampSelection,
} from './mode.js'
import { closeOTADialog } from './dialogs/ota.js'
import { closeResizeDialog } from './dialogs/resize.js'
import { closeDeveloperDialog } from './dev-stats.js'
import { closeSchemaEditor } from './dialogs/schema-editor.js'
import { openHelpDialog, closeHelpDialog } from '../dialogs/help.js'
import { closeSettingsDialog } from '../dialogs/settings.js'
import { closeOpenDialog } from '../pickers/open-map.js'

export function wireKeyboard() {
  // Capture phase so we catch Q/E during an HTML5 drag (the dragged
  // node sits inside the drawer item and could otherwise stop the
  // event from reaching the document listener in some browsers).
  document.addEventListener('keydown', (e) => {
    // Escape must close an open dialog *before* the text-input guard
    // below kicks in — dialogs auto-focus their first input on open, so
    // letting the guard run first would swallow Escape and leave the
    // dialog stranded until the user clicked out of the input.
    if (e.key === 'Escape') {
      const ota = $('#ota-dialog')
      if (ota && !ota.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeOTADialog(); return }
      const resize = $('#resize-dialog')
      if (resize && !resize.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeResizeDialog(); return }
      const dev = $('#developer-dialog')
      if (dev && !dev.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeDeveloperDialog(); return }
      const help = $('#help-dialog')
      if (help && !help.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeHelpDialog(); return }
      const settings = $('#settings-dialog')
      if (settings && !settings.classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeSettingsDialog(); return }
      const openMap = $('#open-dialog')
      if (openMap && !openMap.classList.contains('hidden')) {
        // closeOpenDialog handles "back to welcome vs. stay on editor"
        // routing via openMapSource, matching the Cancel button.
        e.preventDefault(); e.stopPropagation(); closeOpenDialog(); return
      }
    }
    // Don't intercept other shortcuts while the user is typing into a
    // text input — but checkbox / radio / file <input>s and <select>
    // dropdowns shouldn't swallow our shortcuts (the schema-select used
    // to steal focus and block Q/E rotation).
    const t = e.target
    if (t instanceof HTMLTextAreaElement) return
    if (t instanceof HTMLInputElement) {
      const typ = (t.type || '').toLowerCase()
      if (typ === '' || /^(text|search|number|password|email|url|tel)$/.test(typ)) return
    }
    // `?` (shift+/) opens the help cheat-sheet from anywhere outside
    // a text input.  Symbol comparison handles both US and non-US
    // layouts where Shift+/ produces different keys.
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      openHelpDialog()
      return
    }
    if (e.key === ' ' && !getSpacePanHotkey()) {
      setSpacePanHotkey(true)
      document.body.style.cursor = 'grab'
      e.preventDefault()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault()
      redo()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      selectAllContent()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      // Copy the current Select-Terrain rectangle (or already-lifted
      // terrainClipboard) to the system clipboard.  The OS clipboard
      // is what makes this work across Chrome windows.
      e.preventDefault()
      copyToClipboard()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'x' || e.key === 'X')) {
      // Cut = copy + clear region.  Same selection rule as Copy
      // (rectSelection or already-lifted terrainClipboard).
      e.preventDefault()
      cutSelection()
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      // Paste a KBot Studio rectangle from the system clipboard,
      // staged as a follow-the-cursor terrainClipboard.
      e.preventDefault()
      pasteFromClipboard()
    }
    else if (e.key === 'v' || e.key === 'V') setVoidsVisible(!state.showVoids)
    else if (e.key === 'p' || e.key === 'P') setMode('paint')
    else if (e.key === 't' || e.key === 'T') setMode('select-terrain')
    else if (e.key === 'f' || e.key === 'F') {
      // While a section is being placed (or pre-selected from the
      // drawer), F flips horizontally rather than jumping to Features
      // mode — matches Q/E's "act on what's in play" semantics.  No
      // active placement → original mode-switch.
      if (state.placement || state.selected?.type === 'section') flipActive('h')
      else setMode('select-features')
    }
    else if (e.key === 'g' || e.key === 'G') {
      if (state.placement || state.selected?.type === 'section') flipActive('v')
    }
    else if (e.key === 'k' || e.key === 'K') setMode('picker')
    else if (e.key === 's' || e.key === 'S') {
      // Cmd/Ctrl+S would conflict with save shortcuts; without
      // modifiers, plain S switches to Start Points.
      if (!e.ctrlKey && !e.metaKey) setMode('start-points')
    }
    else if (e.key === 'x' || e.key === 'X') setMode('erase')
    else if (e.key === 'd' || e.key === 'D') setMode('voids')
    else if (e.key === 'h' || e.key === 'H') setMode('heightmap')
    else if (e.key === 'b' || e.key === 'B') setMode('fill')
    else if (e.key === 'r' || e.key === 'R') setMode('ruler')
    else if (e.key === 'q' || e.key === 'Q') rotateActive(-1)
    else if (e.key === 'e' || e.key === 'E') rotateActive(1)
    // Shift + Up/Down: zoom in / out at the keyboard.  Handled
    // *before* the bare-arrow pan branch so the modifier wins.
    else if (e.shiftKey && e.key === 'ArrowUp') {
      e.preventDefault()
      setZoom(state.zoom * (state.settings?.zoomStep || 1.25))
    }
    else if (e.shiftKey && e.key === 'ArrowDown') {
      e.preventDefault()
      setZoom(state.zoom / (state.settings?.zoomStep || 1.25))
    }
    // Arrow keys: page through drawer sections when a section is
    // the active selection, otherwise start a continuous pan that
    // ramps from 1× to MAP_PAN_ACCEL_MAX_MULT over
    // MAP_PAN_ACCEL_TIME_MS while held.  The repeat-flag check
    // ignores the OS auto-repeat — the rAF loop drives motion.
    else if (e.key === 'ArrowLeft' && hostCallbacks.pageSectionSibling?.(-1)) { e.preventDefault() }
    else if (e.key === 'ArrowRight' && hostCallbacks.pageSectionSibling?.(1)) { e.preventDefault() }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); if (!e.repeat) startMapPan('ArrowLeft',  -1,  0) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (!e.repeat) startMapPan('ArrowRight',  1,  0) }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); if (!e.repeat) startMapPan('ArrowUp',     0, -1) }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); if (!e.repeat) startMapPan('ArrowDown',   0,  1) }
    // Page Up / Page Down zoom in / out.  Same step as the toolbar
    // buttons so the keyboard + mouse paths stay in sync.
    else if (e.key === 'PageUp') {
      e.preventDefault()
      setZoom(state.zoom * (state.settings?.zoomStep || 1.25))
    }
    else if (e.key === 'PageDown') {
      e.preventDefault()
      setZoom(state.zoom / (state.settings?.zoomStep || 1.25))
    }
    // Home: fit the entire map to the viewport.
    else if (e.key === 'Home') { e.preventDefault(); fitZoom() }
    else if (e.key === 'Escape') {
      // If the schema-edit dialog is open, Esc cancels it.  Done
      // before the menu / mode-reset paths so editing a schema and
      // pressing Esc behaves like the dialog's Cancel button.
      if (!$('#schema-edit-dialog')?.classList.contains('hidden')) {
        closeSchemaEditor()
        e.preventDefault()
        return
      }
      // If a ribbon dropdown or hover submenu is open, the first
      // Escape press just closes it.  Saves the user from having to
      // mouse away to dismiss, and avoids triggering the mode-reset
      // path below by accident while they were exploring a menu.
      const openPopup = document.querySelector('.ribbon-dropdown-popup:not(.hidden)')
      if (openPopup) {
        document.querySelectorAll('.ribbon-dropdown-popup:not(.hidden)').forEach((el) => el.classList.add('hidden'))
        e.preventDefault()
        return
      }
      // Clear whatever transient state is active first, then drop the
      // user back into Select mode — that's the "neutral" mode that
      // lets them re-orient before picking a new tool.
      if (state.placement) cancelPlacement()
      if (state.terrainClipboard) cancelTerrainClipboard()
      if (state.ruler) { state.ruler = null; renderCanvas() }
      if (state.selectedFeatures.size > 0) state.selectedFeatures.clear()
      if (state.selectedFeature >= 0) state.selectedFeature = -1
      if (state.selected?.type === 'feature') clearStampSelection()
      // Leaving Heightmap mode → drop back to the plain Map view so
      // the editor isn't left in greyscale / blended once the user
      // has finished sculpting.
      const leavingHeightmap = state.mode === 'heightmap'
      if (state.mode !== 'select-terrain') setMode('select-terrain')
      else renderCanvas()
      if (leavingHeightmap && state.viewMode !== 'map') {
        state.viewMode = 'map'
        $$('#display-mode-group .menu-row').forEach((r) => r.classList.toggle('active', r.dataset.display === 'map'))
        const lbl = $('#view-current-lbl')
        if (lbl) lbl.textContent = 'Map'
        renderCanvas()
      }
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      handleDeleteKey()
    }
  }, { capture: true })
  document.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      setSpacePanHotkey(false)
    }
    // Stop the held-key pan when the user lets go.  Each direction
    // tracks its own held state, so releasing one of two pressed
    // arrows keeps the other one going.
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      stopMapPan(e.key)
    }
  })
  // Window-blur safety net — if the user alt-tabs while holding an
  // arrow, we never see the keyup and would scroll forever.
  window.addEventListener('blur', stopAllMapPan)
}
