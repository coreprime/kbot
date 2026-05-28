// accordion-section.js
//
// Single shared accordion-section component used by inspector panels
// to group related rows under a collapsible header.  Matches the
// visual treatment used by the Runtime panel's per-unit groups —
// purple-tinted header bar, chevron on the left, label + optional
// count on the right — so panels using this component feel like
// the same family of UI.
//
// Usage:
//
//   import { AccordionSection } from '/ui/common/accordion-section.js'
//
//   <${AccordionSection} id="camera" title="Camera" defaultOpen=${true}>
//     ...rows...
//   <//>
//
// Collapse state lives in a module-level signal keyed by `id` so the
// section remembers its open/closed across re-renders.  The first
// render seeds the state from `defaultOpen` (closed by default
// otherwise).  Use distinct `id` values across the app so two
// panels with a "Camera" section don't share toggle state.

import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'

// _state — Set of section ids that are currently OPEN.  A section is
// open iff its id is in the set.  Module-level so it survives
// component re-renders within the same page session; not persisted
// across reloads (kept intentionally light — these are UI nice-to-
// have toggles, not user settings).
const _openSections = signal(new Set())
// _seeded — Set of section ids whose initial defaultOpen has been
// applied.  Without this we'd re-seed on every render, which would
// stomp the user's explicit toggle the moment they collapsed a
// section that defaultOpen=true.
const _seeded = new Set()

function _isOpen(id) {
  return _openSections.value.has(id)
}

function _toggle(id) {
  const next = new Set(_openSections.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  _openSections.value = next
}

// _stopProp — drag-suppression for clicks inside a FloatingPanel
// header.  The header drag listener gets pointerdown events; we
// don't want collapsing a section to also start a panel drag.
const _stopProp = (e) => e.stopPropagation()

export function AccordionSection({ id, title, defaultOpen = false, count, children }) {
  // Seed once per id — only first render applies defaultOpen so
  // subsequent renders respect any user toggle.
  if (!_seeded.has(id)) {
    _seeded.add(id)
    if (defaultOpen) {
      const next = new Set(_openSections.value)
      next.add(id)
      _openSections.value = next
    }
  }
  const open = _isOpen(id)
  return html`
    <div class="mv-accordion-section">
      <div class=${`mv-accordion-header${open ? ' is-open' : ''}`}
           onClick=${(e) => { _stopProp(e); _toggle(id) }}
           onPointerDown=${_stopProp}
           onMouseDown=${_stopProp}>
        <span class="mv-accordion-chev">${open ? '−' : '+'}</span>
        <span class="mv-accordion-title">${title}</span>
        ${count != null ? html`<span class="mv-accordion-count">${count}</span>` : null}
      </div>
      ${open ? html`<div class="mv-accordion-body">${children}</div>` : null}
    </div>
  `
}
