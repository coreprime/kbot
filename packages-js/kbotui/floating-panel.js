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

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { htm as html } from './htm-bind.js'
import {
  panelSignals,
  setPanelPos,
  setPanelCollapsed,
  setPanelVisible,
  setPanelSize,
  setSidebarCollapsed,
  sectionSignals,
  setSectionCollapsed,
} from './panel-store.js'

// _headerHeight — read the live header element height so the clamp
// rule honours whatever vertical padding the CSS applies.  Falls
// back to 32 px when the header isn't laid out yet (mid-mount).
// headerSelector defaults to the unit-editor's `.mv-inspector-header`
// but map-editor panels (.minimap, .dev-stats) override it via the
// FloatingPanel headerClass prop.
function _headerHeight(panelEl, headerSelector = '.mv-inspector-header') {
  const hdr = panelEl && panelEl.querySelector(headerSelector)
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

// Bring-to-front stacking.  Every floating panel's CSS-default z-index
// lives in the 40-65 band (mv-inspector 50, sandbox-panel / renderer
// 60); dropdowns sit at 1500 and modals at 5000+.  We hand out an
// ever-increasing inline z-index starting just above that band so an
// interacted-with panel rises over its peers without ever climbing
// into the dropdown / modal range.  Session-only — not persisted, and
// shared across the unit viewer, sandbox, and map editor since they
// all render through this one component.
let _panelZTop = 100
function _bringPanelToFront(el) {
  if (!el) return
  el.style.zIndex = String(++_panelZTop)
}

// rescuePanelIntoStage — public helper hosts call after a window /
// stage resize.  Reads each registered panel's DOM rect and writes
// back a clamped position so a layout saved at a larger viewport
// doesn't strand a panel off-screen.  Bottom is intentionally
// unbounded — the title bar has to stay reachable, the body can
// overflow.
export function rescuePanelIntoStage(panelId, opts = {}) {
  const panelEl = document.getElementById(panelId)
  if (!panelEl || panelEl.classList.contains('hidden')) return
  const stageSelector  = opts.stageSelector  || '.model-viewer-stage'
  const headerSelector = opts.headerSelector || '.mv-inspector-header'
  const stage = document.querySelector(stageSelector)
  if (!stage) return
  const sr = stage.getBoundingClientRect()
  const pr = panelEl.getBoundingClientRect()
  const w = pr.width || panelEl.offsetWidth || 220
  const left = pr.left - sr.left
  const top  = pr.top  - sr.top
  const headerH = _headerHeight(panelEl, headerSelector)
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
//   rootClass   — base class for the outer <aside> (default
//                 'mv-inspector').  Map editor panels override with
//                 their own existing class (.minimap, .dev-stats) so
//                 studio.css's per-id positioning + chrome rules keep
//                 applying after the React migration.
//   headerClass / bodyClass — matching base classes for the header bar
//                 and body wrapper.  Defaults pair with the unit-
//                 editor's `mv-inspector-header` / `mv-inspector-body`.
//   stageSelector — the CSS selector used to clamp drag + rescue
//                 positions (default `.model-viewer-stage`).  Map
//                 editor panels pass `.canvas-wrap`.
//   gripGlyph   — first glyph in the header (defaults to the unit-
//                 editor's `⠿` grip).  Set to '' to suppress.
//   noCollapse / noClose — flip OFF the matching header buttons (the
//                 minimap keeps its imperative behaviour; some map
//                 panels (Stats) only ship a Collapse, not a Close).
//   headerExtras — JSX rendered between the title and the standard
//                 button group.  Use for custom controls that should
//                 live in the header chrome — the debugger's search
//                 input, a settings cog, an indicator chip.
//   headerActions — JSX (typically <button>s) rendered between the
//                 extras and the standard collapse/close pair.  Use
//                 for panel-specific actions like minimize.
//   sidebar      — JSX rendered into a right-side pane next to the
//                 body.  When provided the body switches to a
//                 horizontal flex layout (body | sidebar) and the
//                 panel-store gains a `sidebarCollapsed` signal
//                 (toggled via setSidebarCollapsed) that hides the
//                 sidebar pane without disturbing the body.
//   sidebarDefaultCollapsed — initial sidebar state when nothing's
//                 persisted yet.
//   sidebarClass — CSS class for the sidebar wrapper (default
//                 'mv-panel-sidebar').
//   resizable    — render eight resize handles + persist the user-
//                 chosen size in panel-store.  Use for debug panels
//                 where a one-size body doesn't fit every workflow.
//   defaultSize  — initial `{ width, height }` when nothing is
//                 persisted.  Without this the panel uses whatever
//                 size the stylesheet hands it.
//   minSize      — minimum size the resize handles will allow
//                 (default `{ width: 240, height: 160 }`).
export function FloatingPanel({
  id, title, defaultPos = null, onClose = null, className = '', children,
  rootClass = 'mv-inspector',
  headerClass = 'mv-inspector-header',
  bodyClass = 'mv-inspector-body',
  stageSelector = '.model-viewer-stage',
  gripGlyph = '⠿',
  noCollapse = false,
  noClose = false,
  headerExtras = null,
  headerActions = null,
  sidebar = null,
  sidebarDefaultCollapsed = false,
  sidebarClass = 'mv-panel-sidebar',
  resizable = false,
  defaultSize = null,
  minSize = null,
  minimizable = false,
}) {
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
  const persistedSize = sig.size.value
  const sidebarOff = sig.sidebarCollapsed.value
  // First-render sidebar default — the signal seeds false, so we
  // seed it from the prop once on mount when the caller asked for
  // a different default.  Repeated re-mounts of the same panel id
  // keep the user's choice.
  const sidebarSeededRef = useRef(false)
  if (!sidebarSeededRef.current && sidebarDefaultCollapsed && !sidebarOff) {
    setSidebarCollapsed(id, true)
    sidebarSeededRef.current = true
  }
  // Local minimized state — a header-actions consumer (debugger) can
  // flip this to collapse the body to just the header bar without
  // hiding the panel completely.  Persisting isn't worth the
  // complexity; minimize is a transient "get this out of my way for
  // a few seconds" gesture.
  const [minimized, setMinimized] = useState(false)

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

  // Apply the persisted (or default) size when resizable.  Same
  // layout-effect pattern as position so the first paint already
  // has the right dimensions; otherwise a saved 900×600 debugger
  // briefly flashes at the CSS default before the JS resize lands.
  useLayoutEffect(() => {
    if (!resizable) return
    const el = panelRef.current
    if (!el) return
    const s = persistedSize || defaultSize
    if (s && typeof s.width === 'number' && typeof s.height === 'number') {
      el.style.width = s.width + 'px'
      el.style.height = s.height + 'px'
    }
  }, [persistedSize, defaultSize, resizable])

  // 8-direction resize.  Each handle's data-resize encodes which
  // sides the drag moves (n/s/e/w).  Capture the starting rect +
  // pointer; per-frame apply deltas; clamp to a sensible minimum.
  // On mouseup commit the final size to panel-store so it persists
  // across reloads.  Mirrors the legacy debugger's resize behaviour
  // — the difference is the size is now a panel-store concern, not
  // an imperative inline-style write the next render would clobber.
  useEffect(() => {
    if (!resizable) return
    const panelEl = panelRef.current
    if (!panelEl) return
    const minW = (minSize && minSize.width)  || 240
    const minH = (minSize && minSize.height) || 160
    let rzStart = null
    const onDown = (e) => {
      const handle = e.target.closest('.mv-panel-resize')
      if (!handle || !panelEl.contains(handle)) return
      e.preventDefault(); e.stopPropagation()
      const r = panelEl.getBoundingClientRect()
      rzStart = {
        dir: handle.dataset.resize || 'se',
        x: e.clientX, y: e.clientY,
        left: r.left, top: r.top, w: r.width, h: r.height,
      }
    }
    const onMove = (e) => {
      if (!rzStart) return
      const dx = e.clientX - rzStart.x
      const dy = e.clientY - rzStart.y
      let { left, top, w, h } = rzStart
      if (rzStart.dir.includes('e')) w = Math.max(minW, rzStart.w + dx)
      if (rzStart.dir.includes('s')) h = Math.max(minH, rzStart.h + dy)
      if (rzStart.dir.includes('w')) {
        const newW = Math.max(minW, rzStart.w - dx)
        left = rzStart.left + (rzStart.w - newW)
        w = newW
      }
      if (rzStart.dir.includes('n')) {
        const newH = Math.max(minH, rzStart.h - dy)
        top = rzStart.top + (rzStart.h - newH)
        h = newH
      }
      panelEl.style.width = w + 'px'
      panelEl.style.height = h + 'px'
      if (rzStart.dir.includes('w')) {
        panelEl.style.left = left + 'px'
        panelEl.style.right = 'auto'
      }
      if (rzStart.dir.includes('n')) {
        panelEl.style.top = top + 'px'
        panelEl.style.bottom = 'auto'
      }
    }
    const onUp = () => {
      if (!rzStart) return
      const w = panelEl.offsetWidth
      const h = panelEl.offsetHeight
      const movedLeft = rzStart.dir.includes('w')
      const movedTop  = rzStart.dir.includes('n')
      if (movedLeft || movedTop) {
        const left = parseInt(panelEl.style.left, 10) || 0
        const top  = parseInt(panelEl.style.top,  10) || 0
        setPanelPos(id, { top, left })
      }
      setPanelSize(id, { width: w, height: h })
      rzStart = null
    }
    panelEl.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      panelEl.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [id, resizable, minSize])

  // Bring-to-front — any mousedown anywhere in the panel raises it
  // above its peers.  Capture phase so it fires even on children that
  // stopPropagation their own mousedown (header buttons, slider thumbs)
  // and before the drag/resize handlers below run.  Bumps an inline
  // z-index, which the position layout-effect never touches, so it
  // survives re-renders for the life of the mounted panel.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return undefined
    const onDown = () => _bringPanelToFront(el)
    el.addEventListener('mousedown', onDown, true)
    return () => el.removeEventListener('mousedown', onDown, true)
  }, [])

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
      const stage = document.querySelector(stageSelector)
      if (!stage) return
      const sr = stage.getBoundingClientRect()
      const w = panelEl.offsetWidth || 220
      const headerH = _headerHeight(panelEl, `.${headerClass}`)
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
  }, [id, stageSelector, headerClass])

  // Post-mount rescue clamp — once the panel has rendered we know
  // its real width + header height, so any persisted position that
  // ended up off-screen (smaller viewport on this load) is pulled
  // back inside the stage.  Two RAFs deep matches the vanilla path.
  useEffect(() => {
    if (!visible) return
    let raf2 = 0
    const opts = { stageSelector, headerSelector: `.${headerClass}` }
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => rescuePanelIntoStage(id, opts))
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [id, visible, stageSelector, headerClass])

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

  // Classlist for the root element — combines the configurable base
  // class (defaults to `.mv-inspector` for unit-editor panels; map-
  // editor panels pass their own `.minimap` / `.dev-stats` class so
  // studio.css's per-id positioning rules keep applying) with the
  // dynamic visibility + collapsed flags.  The legacy wireMvInspector
  // uses the same class names; everything in studio.css applies as-is.
  const rootClassMerged = [
    rootClass,
    visible ? '' : 'hidden',
    collapsed ? 'collapsed' : '',
    minimized ? 'minimized' : '',
    sidebar && sidebarOff ? 'sidebar-collapsed' : '',
    sidebar ? 'has-sidebar' : '',
    resizable ? 'resizable' : '',
    className,
  ].filter(Boolean).join(' ')

  // Build the 8 resize handles when resizable.  Kept inline so we
  // don't ship the markup for panels that don't opt in.
  const resizeHandles = resizable ? html`
    <span class="mv-panel-resize mv-panel-resize-n"  data-resize="n" />
    <span class="mv-panel-resize mv-panel-resize-s"  data-resize="s" />
    <span class="mv-panel-resize mv-panel-resize-e"  data-resize="e" />
    <span class="mv-panel-resize mv-panel-resize-w"  data-resize="w" />
    <span class="mv-panel-resize mv-panel-resize-nw" data-resize="nw" />
    <span class="mv-panel-resize mv-panel-resize-ne" data-resize="ne" />
    <span class="mv-panel-resize mv-panel-resize-sw" data-resize="sw" />
    <span class="mv-panel-resize mv-panel-resize-se" data-resize="se" />
  ` : null

  // Sidebar toggle button — only rendered when a sidebar pane is
  // provided.  Glyph mirrors the legacy debugger's vars-side toggle
  // so the muscle memory of long-time users carries over.
  const sidebarToggle = sidebar ? html`
    <button class="minimap-toggle mv-panel-sidebar-toggle"
            title=${sidebarOff
              ? 'Show the side panel again.'
              : 'Hide the side panel (click again to bring it back).'}
            onClick=${(e) => { e.stopPropagation(); setSidebarCollapsed(id, !sidebarOff) }}
            onPointerDown=${handlePointerDownStop}
            onMouseDown=${handlePointerDownStop}>
      ${sidebarOff ? '▭' : '▮'}
    </button>
  ` : null

  return html`
    <aside ref=${panelRef} id=${id} class=${rootClassMerged}
           title=${`Drag this header to move the ${title} overlay`}>
      <div ref=${headerRef} class=${headerClass} id=${`${id}-header`}>
        ${gripGlyph ? html`<span class="minimap-grip" title="Drag to move this panel">${gripGlyph}</span>` : null}
        <span class="mv-panel-title">${title}</span>
        ${headerExtras}
        ${headerActions}
        ${minimizable ? html`
          <button class="minimap-toggle mv-panel-minimize"
                  title=${minimized
                    ? 'Restore the panel body.'
                    : 'Minimize the panel to its header bar (state preserved).'}
                  onClick=${(e) => { e.stopPropagation(); setMinimized(!minimized) }}
                  onPointerDown=${handlePointerDownStop}
                  onMouseDown=${handlePointerDownStop}>
            ${minimized ? '▢' : '_'}
          </button>
        ` : null}
        ${sidebarToggle}
        ${noCollapse ? null : html`
          <button class="minimap-toggle mv-inspector-toggle"
                  title=${collapsed
                    ? 'Expand this panel back to its full height.'
                    : 'Collapse this panel to a thin header bar (click again to expand).'}
                  onClick=${handleCollapseClick}
                  onPointerDown=${handlePointerDownStop}
                  onMouseDown=${handlePointerDownStop}>
            ${collapsed ? '+' : '−'}
          </button>
        `}
        ${noClose ? null : html`
          <button class="minimap-toggle mv-inspector-close"
                  title="Close this panel (re-open later from the View menu)."
                  onClick=${handleCloseClick}
                  onPointerDown=${handlePointerDownStop}
                  onMouseDown=${handlePointerDownStop}>
            ×
          </button>
        `}
      </div>
      ${sidebar ? html`
        <div class="mv-panel-row">
          <div class=${bodyClass} id=${`${id}-body`}>
            ${children}
          </div>
          <aside class=${`${sidebarClass}${sidebarOff ? ' collapsed' : ''}`}>
            ${sidebar}
          </aside>
        </div>
      ` : html`
        <div class=${bodyClass} id=${`${id}-body`}>
          ${children}
        </div>
      `}
      ${resizeHandles}
    </aside>
  `
}

// CollapsibleSection — small reusable wrapper that pairs a header
// row with caret + label + an arbitrary action slot (extras) with
// a collapsible body.  When `panelId` + `sectionKey` are provided,
// the collapse state is persisted via the panel-store's section
// registry; otherwise the component manages its own local state.
//
// Props:
//   title        — string or JSX shown in the header.
//   children     — body content rendered when expanded.
//   panelId      — owning panel's id; pairs with sectionKey for
//                  persistence.  Omit for ephemeral sections.
//   sectionKey   — short identifier unique within the panel
//                  (e.g. 'locals', 'globals', 'stack').
//   defaultCollapsed — initial state when nothing is persisted.
//   className    — extra classes on the section root.
//   bodyClass    — class on the body wrapper (defaults to
//                  'mv-collapsible-body').  Override when the section
//                  needs a custom layout (e.g. inline-flex pill row).
//   extras       — JSX rendered between the title and the caret —
//                  good for inline action buttons like "Clear".
export function CollapsibleSection({
  title, children, panelId = null, sectionKey = null,
  defaultCollapsed = false, className = '',
  bodyClass = 'mv-collapsible-body', extras = null,
}) {
  const persisted = (panelId && sectionKey)
    ? sectionSignals(panelId, sectionKey, { defaultCollapsed })
    : null
  const [localCollapsed, setLocalCollapsed] = useState(!!defaultCollapsed)
  const collapsedNow = persisted ? persisted.collapsed.value : localCollapsed
  const onToggle = (e) => {
    e.stopPropagation()
    if (persisted) setSectionCollapsed(panelId, sectionKey, !collapsedNow)
    else setLocalCollapsed(!collapsedNow)
  }
  const rootCls = ['mv-collapsible', collapsedNow ? 'collapsed' : '', className].filter(Boolean).join(' ')
  return html`
    <div class=${rootCls} data-section-key=${sectionKey || ''}>
      <div class="mv-collapsible-header" onClick=${onToggle}>
        <span class="mv-collapsible-caret">${collapsedNow ? '▸' : '▾'}</span>
        <span class="mv-collapsible-title">${title}</span>
        ${extras ? html`<span class="mv-collapsible-extras" onClick=${(e) => e.stopPropagation()}>${extras}</span>` : null}
      </div>
      ${collapsedNow ? null : html`<div class=${bodyClass}>${children}</div>`}
    </div>
  `
}
