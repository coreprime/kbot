// undo.js
//
// Map editor undo / redo + transaction wrapper.  History snapshots
// the parts of state the user can mutate: tile stamps, attribute
// heights, voids, feature placements, plus the map dimensions in
// case a resize happened.  Tile entries are shared by reference
// between snapshots because tiles are always *replaced*, never
// mutated in place; feature entries are deep-cloned because
// drag-move edits ax/ay directly.
//
// Begin/commit/abort are re-entrant for the outer wrapper only —
// nested calls layer onto the outermost transaction.  A commit that
// produces no diff doesn't push an entry, so repeated no-op edits
// don't flood the history.
//
// External callbacks (renderCanvas, refreshSchemaSelector, ...)  are
// looked up via hostCallbacks rather than imported directly, so this
// module stays free of cycles during the studio.js extraction.

import { state, activeMap, setStatus, $, clamp, hostCallbacks } from '../host-context.js'
import { UNDO_MAX, HISTORY_FLYOUT_N } from './constants.js'

export const undoStack = []
export const redoStack = []
let pendingTransaction = null

// captureSnapshot freezes the per-map editable state at a single
// instant.  Tile entries share refs (immutable by convention),
// feature entries are cloned (mutable in place), OTA is deep-cloned
// because schemas / start positions get mutated.
export function captureSnapshot() {
  return {
    tiles: state.tiles.slice(),
    heights: state.heights.slice(),
    voids: state.voids.slice(),
    features: state.features.map((f) => ({ ...f })),
    tileW: state.tileW,
    tileH: state.tileH,
    name: state.name,
    planet: state.planet,
    activeSchema: state.activeSchema,
    ota: cloneOTA(state.ota),
  }
}

// cloneOTA deep-clones the OTA state.  Required for undo snapshots —
// captureSnapshot freezes a moment in time, and the OTA object's
// schemas + startPositions are mutated in place by the editor, so a
// shallow copy would let the snapshot drift.
export function cloneOTA(ota) {
  if (!ota) return null
  return {
    ...ota,
    schemas: (ota.schemas || []).map((s) => ({
      ...s,
      startPositions: (s.startPositions || []).map((sp) => ({ ...sp })),
    })),
  }
}

export function restoreSnapshot(snap) {
  hostCallbacks.invalidateMinimapBase?.()
  state.tiles = snap.tiles.slice()
  state.heights = snap.heights.slice()
  state.voids = (snap.voids || []).slice()
  state.features = snap.features.map((f) => ({ ...f }))
  if (snap.tileW !== state.tileW || snap.tileH !== state.tileH) {
    state.tileW = snap.tileW
    state.tileH = snap.tileH
    // Undo across a resize: rebuild the canvas stack at the restored
    // dimensions.  EditorView's destroy+mount path handles all the GL
    // teardown that the old in-place resize code used to do by hand.
    hostCallbacks.recreateEditorView?.()
  }
  if (snap.ota) {
    state.ota = cloneOTA(snap.ota)
    state.activeSchema = clamp(snap.activeSchema || 0, 0, state.ota.schemas.length - 1)
    hostCallbacks.refreshSchemaSelector?.()
  }
  if (typeof snap.name === 'string') state.name = snap.name
  if (typeof snap.planet === 'string') state.planet = snap.planet
  hostCallbacks.renderMapTabs?.()
}

// beginTransaction snapshots the current state before the caller
// mutates it.  Re-entrant — nested begins are ignored so callers can
// layer.
export function beginTransaction() {
  if (pendingTransaction) return
  pendingTransaction = captureSnapshot()
}

// commitTransaction pushes a {before, after} pair onto the undo
// stack if the snapshots differ.  Clears the redo stack — any
// in-progress alternate future is invalidated by the new edit.
export function commitTransaction(label) {
  if (!pendingTransaction) return
  const before = pendingTransaction
  pendingTransaction = null
  const after = captureSnapshot()
  if (snapshotsEqual(before, after)) return
  undoStack.push({ before, after, label: label || 'Edit' })
  while (undoStack.length > UNDO_MAX) undoStack.shift()
  redoStack.length = 0
  updateUndoButtons()
  // The active tab now diverges from its last saved state; the tab
  // chip's close button will pop the unsaved-changes prompt.
  const m = activeMap()
  if (m) m.dirty = true
  hostCallbacks.renderMapTabs?.()
  // Any committed edit can change the tile data → the cached
  // minimap base needs to be rebuilt on the next render.
  hostCallbacks.invalidateMinimapBase?.()
}

export function abortTransaction() {
  pendingTransaction = null
}

export function hasPendingTransaction() { return pendingTransaction !== null }

// Cross-module accessors for the tab-swap snapshot path in
// studio.js.  The per-tab MapDoc stores its own undo / redo /
// pendingTransaction trio; on tab switch the host snapshots the
// outgoing tab's state and restores the incoming tab's via these
// accessors.
export function getPendingTransaction() { return pendingTransaction }
export function setPendingTransaction(v) { pendingTransaction = v }

function snapshotsEqual(a, b) {
  if (a.tileW !== b.tileW || a.tileH !== b.tileH) return false
  if (a.tiles.length !== b.tiles.length) return false
  if (a.features.length !== b.features.length) return false
  for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) return false
  for (let i = 0; i < a.heights.length; i++) if (a.heights[i] !== b.heights[i]) return false
  // Features are deep-cloned, so reference equality won't work —
  // compare by structural fingerprint.
  for (let i = 0; i < a.features.length; i++) {
    const af = a.features[i], bf = b.features[i]
    if (af.name !== bf.name || af.ax !== bf.ax || af.ay !== bf.ay) return false
  }
  if (a.name !== b.name || a.planet !== b.planet) return false
  if (a.activeSchema !== b.activeSchema) return false
  // OTA: deep-clone makes reference equality useless.  Stringify is
  // a simple and correct enough comparison since the shape is small.
  if (otaSignature(a.ota) !== otaSignature(b.ota)) return false
  return true
}

function otaSignature(o) { return o ? JSON.stringify(o) : '' }

export function undo() {
  if (undoStack.length === 0) return
  hostCallbacks.cancelPlacement?.()
  if (state.terrainClipboard) state.terrainClipboard = null
  state.selectedFeature = -1
  const entry = undoStack.pop()
  redoStack.push(entry)
  restoreSnapshot(entry.before)
  hostCallbacks.renderCanvas?.()
  updateUndoButtons()
  setStatus(`Undone: ${entry.label}`)
}

export function redo() {
  if (redoStack.length === 0) return
  hostCallbacks.cancelPlacement?.()
  state.selectedFeature = -1
  const entry = redoStack.pop()
  undoStack.push(entry)
  restoreSnapshot(entry.after)
  hostCallbacks.renderCanvas?.()
  updateUndoButtons()
  setStatus(`Redone: ${entry.label}`)
}

export function updateUndoButtons() {
  // Legacy template DOM still has these ids — the queries no-op
  // when the elements aren't in the live tree.  The canonical undo
  // / redo enabled flags flow through publishMapRibbonState into
  // the React ribbon's Editing Tools dropdown.
  const u = $('#btn-undo')
  const r = $('#btn-redo')
  if (u) {
    u.disabled = undoStack.length === 0
    u.title = undoStack.length ? `Undo: ${undoStack[undoStack.length - 1].label} (Ctrl+Z)` : 'Nothing to undo'
  }
  if (r) {
    r.disabled = redoStack.length === 0
    r.title = redoStack.length ? `Redo: ${redoStack[redoStack.length - 1].label} (Ctrl+Shift+Z)` : 'Nothing to redo'
  }
  refreshHistoryFlyouts()
  hostCallbacks.publishMapRibbonState?.()
}

// refreshHistoryFlyouts populates the undo / redo hover flyouts
// with the next HISTORY_FLYOUT_N labels from each stack.  Top of
// undoStack is the next undo (LIFO), top of redoStack is the next
// redo.
export function refreshHistoryFlyouts() {
  const fillList = (containerId, source, emptyText) => {
    const el = $('#' + containerId)
    if (!el) return
    el.innerHTML = ''
    if (source.length === 0) {
      const row = document.createElement('div')
      row.className = 'menu-row history-empty'
      row.textContent = emptyText
      el.appendChild(row)
      return
    }
    // Walk back from the top of the stack so the first row is the
    // very next action that would fire.
    const start = source.length - 1
    const end = Math.max(-1, start - HISTORY_FLYOUT_N)
    for (let i = start; i > end; i--) {
      const row = document.createElement('div')
      row.className = 'menu-row history-row'
      const step = document.createElement('span')
      step.className = 'history-step'
      step.textContent = String(start - i + 1)
      const label = document.createElement('span')
      label.textContent = source[i].label
      row.appendChild(step)
      row.appendChild(label)
      el.appendChild(row)
    }
  }
  fillList('undo-history-list', undoStack, 'Nothing to undo')
  fillList('redo-history-list', redoStack, 'Nothing to redo')
}
