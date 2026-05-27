// panel-layout.js
//
// Drag + collapse + persist layout for the legacy floating panels
// (dev stats, camera info, etc.) that aren't yet React-managed.
//
// Three responsibilities:
//   - makePanelDraggable(panel, header) — attach a mousedown handler
//     to a panel's header so the user can drag it around inside
//     `.canvas-wrap`, clamped to the wrap's bounds.
//   - persistPanelLayout / persistPanelCollapsed — snapshot the
//     panel's position + collapsed state into state.panelLayout and
//     flush through to persistPrefs().
//   - applyPanelLayout — at boot, walk every saved entry and restore
//     positions / collapse states.  Skips ids the React panel-store
//     owns (map-stats-panel, minimap-panel, camera-info-panel) so
//     the two systems don't trample each other.
//
// Lives in /ui/common/ because both the map editor's dev stats panel
// and the unit editor's floating inspector panels need the same
// drag-and-persist behaviour.

import { state, $, clamp } from '../host-context.js'
import { persistPrefs } from './prefs.js'

// React-managed floating panels own their position via the shared
// panel-store + FloatingPanel's useLayoutEffect — skip them in
// applyPanelLayout so the legacy panelLayout map doesn't trample
// on the panel-store's restored coordinates.
//
// The set is populated at boot by the React mount layer
// (registerReactPanels), not hard-coded here — common/ shouldn't
// know which view owns which panel.  Each view's mount function
// declares the ids it manages at React-mount time; this module
// just consults the registry when restoring legacy layouts.
const _reactManaged = new Set()

export function registerReactPanels(ids) {
  if (!ids) return
  for (const id of ids) {
    if (id) _reactManaged.add(id)
  }
}

export function isReactManagedPanel(id) {
  return _reactManaged.has(id)
}

// makePanelDraggable wires header → window mouse listeners so the
// panel follows the cursor while clamped inside the canvas wrap.
// Used for both the dev-stats panel and the camera-info panel —
// both share the same DOM shape (header bar + grip handle).
export function makePanelDraggable(panel, header) {
  if (!panel || !header) return
  let dragOffset = null
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return
    e.preventDefault()
    const rect = panel.getBoundingClientRect()
    dragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    header.classList.add('dragging')
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragOffset) return
    const wrap = $('.canvas-wrap')
    if (!wrap) return
    const wr = wrap.getBoundingClientRect()
    const w = panel.offsetWidth || 216
    const h = panel.offsetHeight || 100
    const left = clamp(e.clientX - dragOffset.dx - wr.left, 4, Math.max(4, wr.width - w - 4))
    const top = clamp(e.clientY - dragOffset.dy - wr.top, 4, Math.max(4, wr.height - h - 4))
    panel.style.left = left + 'px'
    panel.style.top = top + 'px'
    panel.style.right = 'auto'
    panel.style.bottom = 'auto'
  })
  window.addEventListener('mouseup', () => {
    if (dragOffset) {
      dragOffset = null
      header.classList.remove('dragging')
      // Save the final position so the panel reopens in the same
      // spot on the next session.
      persistPanelLayout(panel)
    }
  })
}

// persistPanelLayout snapshots the panel's current position into
// the shared panelLayout map, then writes prefs.  Vertical position
// is stored as a viewport-height fraction so a wider/taller window
// on the next launch still puts the panel roughly where the user
// expects.  Horizontal position is stored as a px offset from
// whichever edge the panel is closer to.
export function persistPanelLayout(panel) {
  if (!panel || !panel.id) return
  const wrap = $('.canvas-wrap')
  if (!wrap) return
  const wr = wrap.getBoundingClientRect()
  const pr = panel.getBoundingClientRect()
  if (wr.height <= 0 || wr.width <= 0) return
  const top = pr.top - wr.top
  const leftDist = pr.left - wr.left
  const rightDist = wr.right - pr.right
  const hSide = leftDist <= rightDist ? 'left' : 'right'
  const hOffset = hSide === 'left' ? Math.round(leftDist) : Math.round(rightDist)
  const vRatio = clamp(top / wr.height, 0, 1)
  state.panelLayout = state.panelLayout || {}
  const cur = state.panelLayout[panel.id] || {}
  state.panelLayout[panel.id] = {
    vRatio,
    hSide,
    hOffset,
    collapsed: !!cur.collapsed,
  }
  persistPrefs()
}

// persistPanelCollapsed updates only the collapsed flag for a
// panel (called from collapse-toggle handlers) without touching
// position.
export function persistPanelCollapsed(panelId, collapsed) {
  if (!panelId) return
  state.panelLayout = state.panelLayout || {}
  const cur = state.panelLayout[panelId] || {}
  state.panelLayout[panelId] = { ...cur, collapsed: !!collapsed }
  persistPrefs()
}

// applyPanelLayout positions and (un)collapses every panel that
// has a saved layout entry.  Called once at the end of
// finishEditorBoot so the canvas-wrap dimensions are settled
// before we read them.
export function applyPanelLayout() {
  const map = state.panelLayout || {}
  const wrap = $('.canvas-wrap')
  if (!wrap) return
  const wr = wrap.getBoundingClientRect()
  for (const id of Object.keys(map)) {
    if (_reactManaged.has(id)) continue
    const panel = document.getElementById(id)
    if (!panel) continue
    const saved = map[id]
    if (saved.collapsed) panel.classList.add('collapsed')
    else panel.classList.remove('collapsed')
    // Reflect the collapse state on the matching toggle button
    // label, if there is one (dev-stats / camera-info follow the
    // +/− pattern).
    const toggle = panel.querySelector('.minimap-toggle')
    if (toggle) toggle.textContent = saved.collapsed ? '+' : '−'
    if (typeof saved.vRatio === 'number' && wr.height > 0) {
      const top = clamp(saved.vRatio * wr.height, 4, Math.max(4, wr.height - panel.offsetHeight - 4))
      panel.style.top = top + 'px'
      panel.style.bottom = 'auto'
    }
    if (typeof saved.hOffset === 'number') {
      if (saved.hSide === 'right') {
        panel.style.right = saved.hOffset + 'px'
        panel.style.left = 'auto'
      } else {
        panel.style.left = saved.hOffset + 'px'
        panel.style.right = 'auto'
      }
    }
  }
}
