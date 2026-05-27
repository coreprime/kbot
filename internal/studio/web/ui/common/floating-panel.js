// floating-panel.js
//
// Preact component that owns the floating-panel chrome shared by
// every inspector overlay in the studio: draggable header with
// grip + title + collapse + close buttons, persisted position +
// collapsed state via panel-store, drag-and-resize clamping that
// keeps the title bar inside the canvas stage at all times while
// allowing the body to overflow the bottom of the viewport.
//
// Designed as a drop-in replacement for the vanilla wireMvInspector
// path — same DOM shape (.mv-inspector > .mv-inspector-header +
// body slot) so the existing CSS in studio.css applies unchanged,
// same ids so any external code that querySelector's a panel id
// still finds it.  Hosts that want React panels render <FloatingPanel
// id="..." title="..."> children </FloatingPanel> into a mount root
// inside .model-viewer-stage; hosts with vanilla panels keep working
// because the chrome behaviour (drag clamp, post-restore clamp) is
// duplicated between this component and the legacy JS — both go
// through the same panel-store so the persisted state stays
// consistent across the migration.

import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'
import { panelSignals, setPanelPos, setPanelCollapsed, setPanelVisible } from '/ui/common/panel-store.js'

// _headerHeight — read the live header element height so the clamp
// rule honours whatever vertical padding the CSS applies.  Falls
// back to 32 px when the header isn't laid out yet (mid-mount).
function _headerHeight(panelEl) {
  const hdr = panelEl && panelEl.querySelector('.mv-inspector-header')
  if (hdr) {
    const h = hdr.offsetHeight || hdr.getBoundingClientRect().height
    if (h > 0) return h
  }
  return 32
}

// _clamp helper — duplicated tiny utility instead of pulling one in
// from studio.js so the ui module stays self-contained.
function _clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v)
}

// rescuePanelIntoStage — public helper hosts call after a window /
// stage resize.  Reads each registered panel's DOM rect and writes
// back a clamped position so a layout saved at a larger viewport
// doesn't strand a panel off-screen.  Bottom is intentionally
// unbounded — the title bar has to stay reachable, the body can
// overflow.
export function rescuePanelIntoStage(panelId) {
  const panelEl = document.getElementById(panelId)
  if (!panelEl || panelEl.classList.contains('hidden')) return
  const stage = document.querySelector('.model-viewer-stage')
  if (!stage) return
  const sr = stage.getBoundingClientRect()
  const pr = panelEl.getBoundingClientRect()
  const w = pr.width || panelEl.offsetWidth || 220
  const left = pr.left - sr.left
  const top  = pr.top  - sr.top
  const headerH = _headerHeight(panelEl)
  const maxLeft = Math.max(0, sr.width  - w)
  const maxTop  = Math.max(0, sr.height - headerH)
  const clLeft = _clamp(left, 0, maxLeft)
  const clTop  = _clamp(top,  0, maxTop)
  if (clLeft === left && clTop === top) return  // already inside
  setPanelPos(panelId, { top: clTop, left: clLeft })
}

// FloatingPanel — the component.  Props:
//   id          — DOM id for the outer .mv-inspector element.  Used
//                 by the panel-store key + by external code that
//                 querySelector's the panel.
//   title       — text shown in the header.
//   defaultPos  — initial { top, left } when no persisted value
//                 exists.  When omitted the panel uses whatever the
//                 stylesheet has for that id (right/bottom anchored
//                 defaults survive until the user drags).
//   onClose     — optional callback fired when the X button is hit.
//                 Defaults to flipping the panel-store's visible
//                 signal off.
//   children    — body content rendered inside .mv-inspector-body.
//   className   — extra classes merged onto the root element.
export function FloatingPanel({ id, title, defaultPos = null, onClose = null, className = '', children }) {
  const panelRef = useRef(null)
  const headerRef = useRef(null)
  const sig = panelSignals(id, { defaultVisible: true })

  // Subscribe explicitly so we re-render when the signals change.
  // useSignals() would auto-subscribe but we don't want to pull the
  // entire preact-signals devtools surface in.  Manual reads inside
  // the render path (sig.pos.value etc.) register the subscription.
  const pos = sig.pos.value
  const collapsed = sig.collapsed.value
  const visible = sig.visible.value

  // Apply the persisted position via inline styles whenever the
  // signal changes.  Layout effect (vs effect) so the position is
  // in place BEFORE the first paint — no flicker of the CSS-default
  // anchor before the JS-assigned one lands.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const p = pos || defaultPos
    if (p && typeof p.top === 'number' && typeof p.left === 'number') {
      el.style.top = p.top + 'px'
      el.style.left = p.left + 'px'
      // CSS may have right/bottom defaults for the right-column
      // anchored panels.  Once a position is pinned we have to
      // unstick those edges so the panel doesn't snap back.
      el.style.right = 'auto'
      el.style.bottom = 'auto'
      el.style.transform = 'none'
    }
  }, [pos, defaultPos])

  // Drag handler — wired imperatively so a fast-moving cursor that
  // escapes the header (or even the panel) still drives the move.
  // window listeners with a captured dragOff state mirror the legacy
  // implementation's behaviour exactly.
  useEffect(() => {
    const headerEl = headerRef.current
    const panelEl = panelRef.current
    if (!headerEl || !panelEl) return
    let dragOff = null
    const onDown = (e) => {
      // Clicks on the header buttons (collapse / close) are NOT drag
      // starts — let them bubble to their own handlers.
      if (e.target.closest('button')) return
      e.preventDefault()
      const r = panelEl.getBoundingClientRect()
      dragOff = { dx: e.clientX - r.left, dy: e.clientY - r.top }
      headerEl.classList.add('dragging')
    }
    const onMove = (e) => {
      if (!dragOff) return
      const stage = document.querySelector('.model-viewer-stage')
      if (!stage) return
      const sr = stage.getBoundingClientRect()
      const w = panelEl.offsetWidth || 220
      const headerH = _headerHeight(panelEl)
      const nextLeft = _clamp(e.clientX - dragOff.dx - sr.left, 4, Math.max(4, sr.width - w - 4))
      const nextTop  = _clamp(e.clientY - dragOff.dy - sr.top,  4, Math.max(4, sr.height - headerH - 4))
      // Write straight into the DOM during the drag for jitter-free
      // tracking — the signal commit happens on mouseup so a 60 Hz
      // drag doesn't fire 60 Hz of persistPrefs writes.
      panelEl.style.left = nextLeft + 'px'
      panelEl.style.top = nextTop + 'px'
      panelEl.style.right = 'auto'
      panelEl.style.bottom = 'auto'
      panelEl.style.transform = 'none'
    }
    const onUp = () => {
      if (!dragOff) return
      dragOff = null
      headerEl.classList.remove('dragging')
      const left = parseInt(panelEl.style.left, 10) || 0
      const top  = parseInt(panelEl.style.top,  10) || 0
      setPanelPos(id, { top, left })
    }
    headerEl.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      headerEl.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [id])

  // Post-mount rescue clamp — once the panel has rendered we know
  // its real width + header height, so any persisted position that
  // ended up off-screen (smaller viewport on this load) is pulled
  // back inside the stage.  Two RAFs deep matches the vanilla path.
  useEffect(() => {
    if (!visible) return
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => rescuePanelIntoStage(id))
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [id, visible])

  const handleCollapseClick = (e) => {
    e.stopPropagation()
    setPanelCollapsed(id, !collapsed)
  }
  const handleCloseClick = (e) => {
    e.stopPropagation()
    if (onClose) onClose()
    else setPanelVisible(id, false)
  }
  const handlePointerDownStop = (e) => e.stopPropagation()

  // Classlist for the root element — combines the static .mv-inspector
  // (so the stylesheet picks it up) with the dynamic visibility +
  // collapsed flags.  The legacy wireMvInspector uses the same class
  // names; everything in studio.css applies as-is.
  const rootClass = [
    'mv-inspector',
    visible ? '' : 'hidden',
    collapsed ? 'collapsed' : '',
    className,
  ].filter(Boolean).join(' ')

  return html`
    <aside ref=${panelRef} id=${id} class=${rootClass}
           title=${`Drag this header to move the ${title} overlay`}>
      <div ref=${headerRef} class="mv-inspector-header" id=${`${id}-header`}>
        <span class="minimap-grip" title="Drag to move this panel">⠿</span>
        <span>${title}</span>
        <button class="minimap-toggle mv-inspector-toggle"
                title=${collapsed
                  ? 'Expand this panel back to its full height.'
                  : 'Collapse this panel to a thin header bar (click again to expand).'}
                onClick=${handleCollapseClick}
                onPointerDown=${handlePointerDownStop}
                onMouseDown=${handlePointerDownStop}>
          ${collapsed ? '+' : '−'}
        </button>
        <button class="minimap-toggle mv-inspector-close"
                title="Close this panel (re-open later from the View menu or the sandbox Developer Tools dropdown)."
                onClick=${handleCloseClick}
                onPointerDown=${handlePointerDownStop}
                onMouseDown=${handlePointerDownStop}>
          ×
        </button>
      </div>
      <div class="mv-inspector-body" id=${`${id}-body`}>
        ${children}
      </div>
    </aside>
  `
}
