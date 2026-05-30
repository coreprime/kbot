// ribbon.js
//
// Reusable building blocks for the studio's top-of-viewer ribbons,
// the various dropdown menus that hang off them, and the per-row
// menu variants (regular click, toggle, hover-submenu, slider).
//
// All variants share the same CSS classes the legacy vanilla
// ribbon uses (`.ribbon`, `.ribbon-section`, `.tool-btn`,
// `.ribbon-dropdown-popup`, `.menu-row`, ...) so the existing
// studio.css rules apply unchanged — these components are a
// drop-in renderer for the same markup tree.
//
// Dropdown open-state is module-scoped so opening one dropdown
// auto-closes any other that was open (matches the legacy
// wireModelRibbonDropdown behaviour).  Outside-click dismissal is
// handled centrally; individual rows decide whether to keep the
// dropdown open (toggle rows, sliders, submenu rows) or close it
// (plain action rows) via the `closesDropdown` prop.

import { signal } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'

// _openDropdown — id of the dropdown currently showing its popup,
// or null when none.  Single-slot signal so the Dropdown component
// renders its popup only while it owns the slot, and opening another
// dropdown closes the previous one without an extra coordination
// channel.
const _openDropdown = signal(null)

// closeAllDropdowns — host helper for external close-everything
// triggers (e.g. switching tabs, opening a modal).  Idempotent.
export function closeAllDropdowns() {
  if (_openDropdown.value !== null) _openDropdown.value = null
}

// ── Ribbon container ─────────────────────────────────────────────

// Ribbon — flex container that hosts ribbon sections side-by-side.
// `id` is optional; pass when the host needs to scope CSS / querying.
// `align` — 'start' (default) or 'space-between' for ribbons that
// have a right-aligned tail group.
export function Ribbon({ id = null, align = 'start', className = '', children }) {
  const cls = ['ribbon', className].filter(Boolean).join(' ')
  const style = align === 'space-between' ? 'justify-content: space-between' : null
  return html`<div id=${id} class=${cls} style=${style}>${children}</div>`
}

// RibbonSection — a labelled group within the ribbon.  Header label is
// optional; some ribbons (sandbox, runtime) omit it on the rightmost
// section.  `right` flips the section to the right side of a
// space-between Ribbon (`ribbon-section-right` modifier class).
export function RibbonSection({ id = null, label = null, right = false, className = '', children }) {
  const cls = ['ribbon-section', right ? 'ribbon-section-right' : '', className]
    .filter(Boolean).join(' ')
  return html`
    <div id=${id} class=${cls}>
      ${label ? html`<div class="ribbon-label">${label}</div>` : null}
      <div class="ribbon-group">${children}</div>
    </div>
  `
}

// ── Ribbon buttons ──────────────────────────────────────────────

// RibbonButton — single tool button (icon + label).  Use for plain
// action buttons that fire a one-shot callback.
//   id      — DOM id when the host needs to find it externally
//   icon    — emoji / single char in the .ico slot
//   label   — text in the .lbl slot
//   active  — true to render with the `.active` class + data-on="1"
//             (for toggle-style buttons that live directly on the ribbon)
//   title   — tooltip
//   onClick — click callback
//   disabled — true to grey out + suppress click
export function RibbonButton({
  id = null, icon, label, active = false, title = null,
  disabled = false, onClick, className = '',
}) {
  const cls = ['tool-btn', active ? 'active' : '', className].filter(Boolean).join(' ')
  return html`
    <button id=${id}
            class=${cls}
            data-on=${active ? '1' : '0'}
            title=${title}
            disabled=${disabled || null}
            onClick=${onClick}>
      ${icon ? html`<span class="ico">${icon}</span>` : null}
      ${label ? html`<span class="lbl">${label}</span>` : null}
    </button>
  `
}

// RibbonDropdownButton — a tool button that opens a Dropdown popup
// beneath it.  Renders the chevron + (optionally) the current
// selection summary (a small label/icon pair the closed dropdown
// shows so the user sees what's active without opening it).
//
// `dropdownId` — the matching <${Dropdown} id=...> open-state key.
// Clicks toggle the open state via the shared signal so only one
// dropdown is open at a time.
export function RibbonDropdownButton({
  id = null, dropdownId, icon, label, currentLabel = null, currentIcon = null,
  title = null, className = '', noChevron = false,
}) {
  const isOpen = _openDropdown.value === dropdownId
  const cls = ['tool-btn', 'ribbon-dropdown-btn', isOpen ? 'active' : '', className]
    .filter(Boolean).join(' ')
  return html`
    <button id=${id}
            class=${cls}
            title=${title}
            onClick=${(e) => {
              e.stopPropagation()
              _openDropdown.value = isOpen ? null : dropdownId
            }}>
      ${icon ? html`<span class="ico">${icon}</span>` : null}
      ${label ? html`<span class="lbl">${label}</span>` : null}
      ${currentIcon ? html`<span class="ico">${currentIcon}</span>` : null}
      ${currentLabel ? html`<span class="env-current-lbl">${currentLabel}</span>` : null}
      ${noChevron ? null : html`<span class="chev-down">▾</span>`}
    </button>
  `
}

// ── Dropdown popup ─────────────────────────────────────────────

// Dropdown — the popup container that hangs off a RibbonDropdownButton
// (matched by `id`).  Open state is the singleton signal so opening
// another dropdown closes this one automatically.  Outside-click +
// Esc dismiss are wired here so individual menu rows don't have to.
//
//   id            — must match RibbonDropdownButton's `dropdownId`
//   anchorId      — id of the trigger button used to position the
//                   popup directly below it (defaults to the button
//                   with id `${id}-btn`)
//   className     — extra classes for variant styling
//   children      — menu rows
export function Dropdown({ id, anchorId = null, className = '', children }) {
  const isOpen = _openDropdown.value === id
  const popupRef = useRef(null)
  // Position the popup under its trigger button each time it opens.
  // useLayoutEffect (not useEffect) runs synchronously AFTER the DOM
  // mutation but BEFORE the browser paints — without it the popup
  // would show one frame at its CSS-default `top: 0; left: 0` (the
  // top-left corner) before the effect ran and moved it under the
  // button, which read as a flicker.
  //
  // Horizontal anchoring: default to the button's left edge.  Right-
  // aligned trigger buttons (e.g. the sandbox ribbon's right-side
  // "Panels" / "Developer Tools" dropdown) sit near `window.innerWidth`,
  // and naively left-aligning a 220px-wide popup there pushes the
  // right edge off-screen.  Clamp the left coordinate so the popup's
  // right edge stays inside the viewport with a small margin — when
  // the button is too close to the right edge for the popup to fit
  // flush-left, the popup slides leftwards instead.  Also clamp to
  // `>= margin` so a narrow viewport doesn't yank the popup off the
  // LEFT edge.
  useLayoutEffect(() => {
    if (!isOpen) return undefined
    const btn = document.getElementById(anchorId || `${id}-btn`)
    const popup = popupRef.current
    if (!btn || !popup) return undefined
    const r = btn.getBoundingClientRect()
    popup.style.top = `${r.bottom + 4}px`
    const MARGIN = 4
    const w = popup.offsetWidth
    const max = Math.max(MARGIN, window.innerWidth - w - MARGIN)
    const left = Math.min(Math.max(r.left, MARGIN), max)
    popup.style.left = `${left}px`
    return undefined
  }, [isOpen, id, anchorId])
  // Outside-click dismissal — bound at the document level while open.
  useEffect(() => {
    if (!isOpen) return undefined
    const onDocClick = (e) => {
      const popup = popupRef.current
      const btn = document.getElementById(anchorId || `${id}-btn`)
      if (popup && popup.contains(e.target)) return
      if (btn && btn.contains(e.target)) return
      _openDropdown.value = null
    }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); _openDropdown.value = null }
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen, id, anchorId])
  if (!isOpen) return null
  const cls = ['ribbon-dropdown-popup', className].filter(Boolean).join(' ')
  return html`
    <div id=${`${id}-popup`} ref=${popupRef} class=${cls}>
      ${children}
    </div>
  `
}

// closeDropdownById — host helper for actions that need to dismiss
// the popup after handling (e.g. a Mode row click that picks the
// mode AND should close the menu).
export function closeDropdownById(id) {
  if (_openDropdown.value === id) _openDropdown.value = null
}

// ── Menu rows ─────────────────────────────────────────────────

// MenuSectionLabel — decorative divider with a label.  Pure CSS.
export function MenuSectionLabel({ children }) {
  return html`<div class="menu-section-label">${children}</div>`
}

// MenuRow — a click row.  Fires `onClick`, then optionally closes the
// containing dropdown (via `closesDropdown` + `dropdownId` props —
// caller passes both so the row knows which dropdown is its parent).
//
//   active — true to render with `.active` class (e.g. selected mode)
//   sub    — optional secondary label (small text in `.sub-current` slot
//            used by Camera dropdown rows that show "(current)")
export function MenuRow({
  icon, label, sub = null, active = false, title = null,
  closesDropdown = true, dropdownId = null, onClick, className = '',
}) {
  const cls = ['menu-row', active ? 'active' : '', className].filter(Boolean).join(' ')
  return html`
    <button class=${cls}
            title=${title}
            onClick=${(e) => {
              e.stopPropagation()
              if (onClick) onClick(e)
              if (closesDropdown && dropdownId) closeDropdownById(dropdownId)
            }}>
      ${icon ? html`<span class="ico">${icon}</span>` : null}
      ${label ? html`<span>${label}</span>` : null}
      ${sub ? html`<span class="sub-current">${sub}</span>` : null}
    </button>
  `
}

// MenuToggleRow — toggle row with check glyph + data-on attribute.
// Click flips the state via `onChange(nextOn)`; the row does NOT
// close the dropdown (toggle rows are sticky controls the user
// often flips repeatedly).
export function MenuToggleRow({
  icon, label, on = false, title = null,
  onChange, disabled = false, className = '',
}) {
  const cls = [
    'menu-row', 'toggle-row',
    on ? 'active' : '',
    disabled ? 'disabled-locked' : '',
    className,
  ].filter(Boolean).join(' ')
  return html`
    <button class=${cls}
            data-on=${on ? '1' : '0'}
            title=${title}
            disabled=${disabled || null}
            aria-disabled=${disabled ? 'true' : null}
            onClick=${(e) => {
              e.stopPropagation()
              if (disabled) return
              if (onChange) onChange(!on)
            }}>
      ${icon ? html`<span class="ico">${icon}</span>` : null}
      ${label ? html`<span>${label}</span>` : null}
      <span class="menu-check">✓</span>
    </button>
  `
}

// MenuSubmenuRow — a row that opens a hover-revealed submenu.
// Click on the row body fires the optional toggle callback; hover
// reveals the submenu (rendered as children).  Closing the submenu
// is automatic on mouseleave of both the row + the submenu.
//
//   on            — when set, the row is treated as a toggle (data-on,
//                   .active class) and `onToggle(next)` fires on click
//   children      — the submenu contents (rendered inside .ribbon-submenu)
//   onClose       — optional callback fired when the submenu closes
//                   (handles the "revert preview on dismiss" case for
//                   the environment / team pickers)
export function MenuSubmenuRow({
  icon, label, currentLabel = null, currentIcon = null,
  on = null, onToggle = null, title = null,
  onClose = null, className = '', children,
}) {
  const [openSubmenu, setOpenSubmenu] = useState(false)
  const rowRef = useRef(null)
  const subRef = useRef(null)
  // mouseenter on the row opens the submenu; mouseleave (on either the
  // row OR the submenu) closes it.  Tracked with a single hover-counter
  // so moving cursor between row and submenu doesn't briefly hide it.
  useEffect(() => {
    const row = rowRef.current
    if (!row) return undefined
    let inRow = false
    let inSub = false
    const update = () => {
      const shouldOpen = inRow || inSub
      setOpenSubmenu((prev) => {
        if (prev && !shouldOpen && onClose) onClose()
        return shouldOpen
      })
    }
    const onRowEnter = () => { inRow = true; update() }
    const onRowLeave = () => { inRow = false; setTimeout(update, 10) }
    row.addEventListener('mouseenter', onRowEnter)
    row.addEventListener('mouseleave', onRowLeave)
    let onSubEnter, onSubLeave
    const sub = subRef.current
    if (sub) {
      onSubEnter = () => { inSub = true; update() }
      onSubLeave = () => { inSub = false; setTimeout(update, 10) }
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
  }, [onClose])
  // Toggle behaviour piggy-backs on the row click — same pattern the
  // legacy wireToggleSubmenu shipped.  Clicks on form controls inside
  // the row (slider thumbs etc.) skip the toggle.
  const onRowClick = (e) => {
    if (e.target.closest('input, select, textarea, button')) return
    e.stopPropagation()
    if (on !== null && onToggle) onToggle(!on)
  }
  const isToggle = on !== null
  const cls = [
    'menu-row', 'menu-row-submenu',
    isToggle ? 'menu-row-toggle-submenu' : '',
    isToggle && on ? 'active' : '',
    openSubmenu ? 'open' : '',
    className,
  ].filter(Boolean).join(' ')
  return html`
    <div ref=${rowRef}
         class=${cls}
         data-on=${isToggle ? (on ? '1' : '0') : null}
         role="button"
         title=${title}
         onClick=${onRowClick}>
      ${icon ? html`<span class="ico">${icon}</span>` : null}
      ${label ? html`<span class="lbl">${label}</span>` : null}
      ${currentIcon ? html`<span class="ico">${currentIcon}</span>` : null}
      ${currentLabel ? html`<span class="env-current-lbl">${currentLabel}</span>` : null}
      ${/* No check glyph: a pop-out row's on/off is shown by the row's
           .active highlight, and the (enlarged) chevron sits in the
           same right-hand column the plain toggle rows' checks use so
           everything lines up vertically. */ ''}
      <span class="chev-right">▸</span>
      <div ref=${subRef} class=${'ribbon-submenu' + (openSubmenu ? '' : ' hidden')}>
        ${children}
      </div>
    </div>
  `
}

// MenuSliderRow — slider with inline value label.  Slider value is
// always controlled by the caller — pass `value`, `onChange(v)` to
// own the state.  `format(v)` converts the slider value to a display
// string (defaults to `${v}`).
//
// Click + pointerdown are stopped from propagating so dragging the
// slider doesn't trigger the parent row's toggle (matches the
// legacy wireSliderInput behaviour).
export function MenuSliderRow({
  icon, label,
  min = 0, max = 100, step = 1, value,
  onChange, format = null,
  title = null, className = '',
}) {
  const displayed = format ? format(value) : `${value}`
  return html`
    <div class=${'menu-row menu-row-slider ' + className} title=${title}
         onClick=${(e) => e.stopPropagation()}>
      ${icon ? html`<span class="ico">${icon}</span>` : null}
      ${label ? html`<span>${label}</span>` : null}
      <input type="range"
             min=${min} max=${max} step=${step}
             value=${value}
             onInput=${(e) => {
               if (onChange) onChange(+e.currentTarget.value)
             }}
             onClick=${(e) => e.stopPropagation()}
             onPointerDown=${(e) => e.stopPropagation()} />
      <span class="menu-row-value">${displayed}</span>
    </div>
  `
}
