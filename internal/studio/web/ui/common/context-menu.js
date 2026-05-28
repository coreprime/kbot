// context-menu.js
//
// Generic right-click context menu primitive.  Exposes an imperative
// `openContextMenu({ x, y, items })` that pops a small floating menu
// at the cursor position and returns a Promise resolving to the id of
// the chosen item (or null if the user dismissed it).  Designed so a
// canvas / list / panel can wire a `contextmenu` handler directly:
//
//   canvas.addEventListener('contextmenu', async (e) => {
//     e.preventDefault()
//     const choice = await openContextMenu({
//       x: e.clientX, y: e.clientY,
//       items: [
//         { id: 'split-h', label: 'Split Horizontal', hint: 'Ctrl+H' },
//         { id: 'split-v', label: 'Split Vertical',   hint: 'Ctrl+V' },
//         { divider: true },
//         { id: 'close',   label: 'Close Panel', disabled: someGuard },
//       ],
//     })
//     if (choice) doSomethingWith(choice)
//   })
//
// Imperative (not declarative) because the natural caller is a DOM
// event handler that already has the click coordinates in hand — a
// declarative <ContextMenu open=${...} x=${...}> would force every
// caller to plumb open / position state through their component, which
// is mostly busywork for a UI element that's transient by design.
//
// Lifecycle model — mirrors confirm-dialog.js: one module-level signal
// carries the current request, one singleton React tree mounted at the
// end of <body> renders the menu, and `openContextMenu()` swaps the
// signal value to trigger a re-render.  Only one menu can be open at a
// time; opening a second resolves the first as cancelled (null) before
// showing the new one.

import { render } from 'preact'
import { signal } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'

// _request — the active menu request, or null when nothing is open.
// Shape: { x, y, items, anchorClass, resolve }.  Signal-driven so the
// component re-renders the moment openContextMenu() flips it.
const _request = signal(null)

// _mountIfNeeded — lazy first-call mount.  The mount node sits at the
// end of <body> so the menu stacks above every editor element without
// fighting a parent's overflow:hidden / transform stacking context.
// Idempotent — re-renders into the same root on subsequent calls.
let _mountedRoot = null
function _mountIfNeeded() {
  if (_mountedRoot) return
  _mountedRoot = document.createElement('div')
  _mountedRoot.id = 'mv-ctxmenu-mount'
  // display:contents — the mount wrapper shouldn't introduce layout;
  // the menu inside is position:fixed and owns its own coordinates.
  _mountedRoot.style.cssText = 'display:contents'
  document.body.appendChild(_mountedRoot)
  render(html`<${ContextMenuHost} />`, _mountedRoot)
}

// openContextMenu — the public API.  Returns Promise<string|null>:
//   - resolves to the chosen item's id when the user clicks a row
//   - resolves to null on outside click, Escape, window blur, scroll,
//     or when a second openContextMenu() supersedes this one
// items is an array of either action items ({ id, label, disabled?,
// hint? }) or dividers ({ divider: true }).  anchorClass (optional)
// is appended to the root element so a caller can target a specific
// instance from CSS (e.g. wider rows for a deeply-nested submenu use
// case).  The function never throws — invalid coordinates clamp
// silently and an empty items array still opens and dismisses cleanly.
export function openContextMenu({ x, y, items, anchorClass = '' } = {}) {
  _mountIfNeeded()
  return new Promise((resolve) => {
    const prev = _request.value
    if (prev && typeof prev.resolve === 'function') prev.resolve(null)
    _request.value = {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      items: Array.isArray(items) ? items : [],
      anchorClass: anchorClass || '',
      resolve,
    }
  })
}

// closeContextMenu — public helper for the rare caller that needs to
// dismiss the menu programmatically (e.g. the underlying data the menu
// was acting on just got deleted).  Resolves the in-flight Promise as
// null and clears the request.  No-op when nothing is open.
export function closeContextMenu() {
  const cur = _request.value
  if (!cur) return
  if (typeof cur.resolve === 'function') cur.resolve(null)
  _request.value = null
}

// _firstEnabledIndex — find the first item that isn't a divider and
// isn't disabled, for keyboard nav seeding.  Returns -1 when the menu
// has nothing the user could pick.
function _firstEnabledIndex(items) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it && !it.divider && !it.disabled) return i
  }
  return -1
}

// _nextEnabledIndex — wraps Up/Down navigation past dividers and
// disabled rows.  step is +1 for Down, -1 for Up.  When no row is
// pickable (every entry disabled / divider) returns the input index
// unchanged so the highlight doesn't fly off into nothingness.
function _nextEnabledIndex(items, from, step) {
  if (!items.length) return -1
  let i = from
  for (let guard = 0; guard < items.length; guard++) {
    i = (i + step + items.length) % items.length
    const it = items[i]
    if (it && !it.divider && !it.disabled) return i
  }
  return from
}

// ContextMenuHost — the singleton component that watches _request and
// renders a <ContextMenu> when a request is in flight.  Splitting host
// vs. menu lets us key the inner component on the request itself so
// the highlight / position state resets cleanly between successive
// openContextMenu() calls (otherwise a stale `highlight` index from
// the previous menu would survive into the next one).
function ContextMenuHost() {
  const req = _request.value
  if (!req) return null
  return html`<${ContextMenu} key=${req} req=${req} />`
}

// ContextMenu — the visible menu.  Owns the highlight index for
// keyboard nav and the post-mount clamp that keeps the menu inside
// the viewport.  Dismissal listeners (outside click, Escape, blur,
// scroll) attach on mount and detach on unmount so a closed menu
// never leaves listeners on the document.
function ContextMenu({ req }) {
  const rootRef = useRef(null)
  const [highlight, setHighlight] = useState(() => _firstEnabledIndex(req.items))
  // Clamp result — the cursor position is the *requested* origin, but
  // we may have to nudge the menu up / left so it fits inside the
  // viewport.  Seeded with the raw coords; useLayoutEffect below reads
  // the menu's measured size and rewrites these before the first paint
  // so the user never sees the menu briefly hanging off-screen.
  const [pos, setPos] = useState({ left: req.x, top: req.y })

  const finish = (result) => {
    const cur = _request.value
    if (!cur || cur !== req) return
    cur.resolve(result)
    _request.value = null
  }

  // Viewport clamp.  Read the menu's measured size after layout, then
  // shift left/up by however much it would otherwise spill past the
  // right / bottom edges.  An 8 px margin keeps the menu off the
  // viewport edge — easier to grab the corner of an item, easier to
  // see the focus ring.  Layout-effect (vs. effect) so the rewrite
  // happens BEFORE the first paint — no visible flash at the wrong
  // position even on slow machines.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const r = el.getBoundingClientRect()
    const margin = 8
    let left = req.x
    let top = req.y
    if (left + r.width + margin > vw) left = Math.max(margin, vw - r.width - margin)
    if (top + r.height + margin > vh) top = Math.max(margin, vh - r.height - margin)
    if (left !== pos.left || top !== pos.top) setPos({ left, top })
    // Intentionally don't depend on `pos` — we only want to clamp once
    // per request (the menu size is fixed by its items).  Re-running
    // on every setPos would loop.
  }, [req])

  // Dismissal — outside click, Escape, window blur, page scroll.
  // We listen on the document at capture phase so a click on a panel
  // header (which has its own pointerdown handler that starts a drag)
  // still dismisses the menu first.  The capture-phase listener fires
  // before bubble-phase handlers anywhere in the tree.
  useEffect(() => {
    const onPointerDown = (e) => {
      const el = rootRef.current
      if (el && el.contains(e.target)) return  // inside menu — let it click
      finish(null)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        finish(null)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation()
        setHighlight((h) => _nextEnabledIndex(req.items, h, +1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        setHighlight((h) => _nextEnabledIndex(req.items, h, -1))
      } else if (e.key === 'Enter') {
        const it = req.items[highlight]
        if (it && !it.divider && !it.disabled) {
          e.preventDefault(); e.stopPropagation()
          finish(it.id)
        }
      }
    }
    // Scroll / blur — both close the menu unconditionally.  A scroll
    // would move the underlying context out from under the cursor
    // (the right-click target the user picked the menu for is no
    // longer where they thought it was), and a blur means the user
    // tabbed away / opened a devtools window — either way they're
    // not interacting with the menu anymore.
    const onScroll = () => finish(null)
    const onBlur = () => finish(null)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
    }
    // `highlight` deliberately included so Enter sees the latest value.
  }, [req, highlight])

  const rootCls = ['mv-ctxmenu', req.anchorClass].filter(Boolean).join(' ')
  return html`
    <div ref=${rootRef} class=${rootCls}
         style=${`left:${pos.left}px;top:${pos.top}px`}
         role="menu"
         onContextMenu=${(e) => e.preventDefault()}>
      ${req.items.map((it, i) => {
        if (!it) return null
        if (it.divider) {
          return html`<div class="mv-ctxmenu-divider" key=${`d${i}`} />`
        }
        const cls = [
          'mv-ctxmenu-item',
          it.disabled ? 'is-disabled' : '',
          i === highlight ? 'is-active' : '',
        ].filter(Boolean).join(' ')
        const onClick = (e) => {
          if (it.disabled) return
          e.preventDefault(); e.stopPropagation()
          finish(it.id)
        }
        // pointerenter (not mouseover) so the highlight follows the
        // cursor without flicker on rows with child spans.  Disabled
        // rows still get highlighted on hover — gives the user a
        // visual confirmation that yes, they found the row, it just
        // isn't pickable right now.
        const onEnter = () => setHighlight(i)
        return html`
          <div class=${cls} key=${it.id || `i${i}`}
               role="menuitem"
               aria-disabled=${it.disabled ? 'true' : 'false'}
               onClick=${onClick}
               onPointerEnter=${onEnter}>
            <span class="mv-ctxmenu-label">${it.label}</span>
            ${it.hint ? html`<span class="mv-ctxmenu-hint">${it.hint}</span>` : null}
          </div>
        `
      })}
    </div>
  `
}
