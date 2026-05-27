// picker.js
//
// Picker-mode mouse handlers — feature selection via click + rect
// sweep.  Click toggles single-select on the topmost feature;
// Shift+click toggles in/out of the multi-select set; click+drag
// on empty space sweeps out a rectangle and selects every feature
// whose anchor falls inside.  Delete (handled elsewhere) removes
// every selected feature in one undo step.
//
// pickerDragStart records the rectangle origin + the additive
// flag (shift-held) for the duration of a sweep.  resetPickerDrag
// lets the studio.js abortTransientGestureState helper clear it
// during mode swaps without needing to reach module-internal
// state.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas() — schedule a repaint after every selection
//     change (highlight + rect outline).

import { state, setStatus, hostCallbacks } from '../../host-context.js'
import { pickCell, findFeatureAt } from '../mouse-coords.js'
import { normalizedRect } from '../helpers.js'

let pickerDragStart = null // { tx, ty, additive } while sweeping a rect

export function resetPickerDrag() {
  pickerDragStart = null
}

export function onPickerMouseDown(e) {
  const { tx, ty } = pickCell(e)
  if (tx < 0 || tx >= state.tileW || ty < 0 || ty >= state.tileH) return
  const hit = findFeatureAt(e)
  if (hit >= 0) {
    if (e.shiftKey) {
      // Toggle this feature in the selection set.
      if (state.selectedFeatures.has(hit)) state.selectedFeatures.delete(hit)
      else state.selectedFeatures.add(hit)
    } else {
      state.selectedFeatures.clear()
      state.selectedFeatures.add(hit)
    }
    hostCallbacks.renderCanvas?.()
    return
  }
  // Empty cell — start a rectangle sweep.  Shift makes it
  // additive so the user can build up the selection across
  // multiple sweeps.
  pickerDragStart = { tx, ty, additive: e.shiftKey }
  if (!e.shiftKey) state.selectedFeatures.clear()
  state.pickerRect = { x: tx, y: ty, w: 1, h: 1 }
  hostCallbacks.renderCanvas?.()
}

export function onPickerMouseMove(e) {
  if (!pickerDragStart) return
  const { tx, ty } = pickCell(e)
  state.pickerRect = {
    x: pickerDragStart.tx,
    y: pickerDragStart.ty,
    w: (tx - pickerDragStart.tx) + (tx >= pickerDragStart.tx ? 1 : -1),
    h: (ty - pickerDragStart.ty) + (ty >= pickerDragStart.ty ? 1 : -1),
  }
  hostCallbacks.renderCanvas?.()
}

export function onPickerMouseUp(_e) {
  if (!pickerDragStart || !state.pickerRect) {
    pickerDragStart = null
    return
  }
  const r = normalizedRect(state.pickerRect)
  state.pickerRect = null
  const additive = pickerDragStart.additive
  pickerDragStart = null
  // Empty rect (just a click that started but didn't move) —
  // nothing to do.
  if (r.w <= 0 || r.h <= 0) { hostCallbacks.renderCanvas?.(); return }
  if (!additive) state.selectedFeatures.clear()
  // Features are anchored at (ax, ay) in attribute coords.  Test
  // against the rectangle in attribute space (×2).
  const minAX = r.x * 2, maxAX = (r.x + r.w) * 2
  const minAY = r.y * 2, maxAY = (r.y + r.h) * 2
  for (let i = 0; i < state.features.length; i++) {
    const f = state.features[i]
    if (f.ax >= minAX && f.ax < maxAX && f.ay >= minAY && f.ay < maxAY) {
      state.selectedFeatures.add(i)
    }
  }
  hostCallbacks.renderCanvas?.()
  if (state.selectedFeatures.size > 0) {
    setStatus(`${state.selectedFeatures.size} feature${state.selectedFeatures.size === 1 ? '' : 's'} selected — Delete to remove, Shift+drag to add more.`)
  }
}
