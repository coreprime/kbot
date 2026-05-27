// picker-modal.js
//
// Shared chrome for "picker" modals (Open Unit, Open Map, Weapon
// picker, future Asset picker, ...).  Each picker shows the same
// shape: title + sub + filter input + a scrollable card grid + a
// Cancel / Confirm action row, with arrow + Enter keyboard
// navigation on the card grid.  This component owns those shared
// pieces; each concrete picker just provides its own card renderer
// + the list of items + the apply callback.
//
// Composes DialogModal for the outer chrome, so Esc-to-cancel,
// autofocus, and backdrop styling stay consistent with the other
// dialogs.

import { useEffect, useRef } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'
import { DialogModal } from '/ui/dialogs/dialog-modal.js'

// PickerModal — props:
//   open               — boolean
//   title              — header text
//   sub                — secondary paragraph
//   cardClass          — extra class added to the dialog card
//                        (defaults to "dialog-card-wide dialog-card-xwide"
//                        to match the existing pickers' sizing)
//   filterPlaceholder  — placeholder for the filter input
//   filterValue        — controlled filter query string
//   onFilterChange     — fires on every keystroke in the filter input
//   loading            — when true the list shows a "Loading…" hint
//                        (skeleton lives in the renderItem callback)
//   emptyMessage       — shown when filtered items is empty + not loading
//   items              — array of items to display.  The component
//                        doesn't care about the shape; the parent's
//                        renderItem renders each one.
//   selectedKey        — the key of the currently-selected item (used
//                        by the parent's renderItem to mark .selected)
//   onSelect           — fired when the user clicks (selects) a card.
//                        Receives (item).
//   onConfirm          — fired when the user clicks Confirm or hits
//                        Enter while an item is selected.
//   onCancel           — fired when the user hits Esc / Cancel button.
//   confirmLabel       — label on the primary action (defaults "Open
//                        selected").
//   confirmDisabled    — when true, the primary action button is
//                        disabled (use this when selectedKey is null
//                        OR when the selected item isn't viable, e.g.
//                        "this model has no 3DO").
//   renderItem         — (item) => html`...`  Parent owns card markup.
//   itemKey            — (item) => string.  Used for arrow-key nav
//                        (matches selectedKey to find current index).
//   gridCols           — number of columns for arrow-key nav (default
//                        4 — matches `.open-list` grid).  Down/Up
//                        moves +/- gridCols, Left/Right moves +/- 1.
export function PickerModal({
  open,
  title,
  sub,
  cardClass = 'dialog-card-wide dialog-card-xwide',
  filterPlaceholder = 'Filter…',
  filterValue,
  onFilterChange,
  loading = false,
  emptyMessage = 'No matches.',
  items = [],
  selectedKey = null,
  onSelect,
  onConfirm,
  onCancel,
  confirmLabel = 'Open selected',
  confirmDisabled = false,
  renderItem,
  itemKey,
  gridCols = 4,
}) {
  const filterRef = useRef(null)
  // Autofocus the filter input the moment the dialog opens — typing
  // narrows the list right away, matching the legacy flow.
  useEffect(() => {
    if (open && filterRef.current) {
      // rAF so the DOM has actually been committed visible before we
      // try to claim focus (Chrome silently ignores focus on a
      // display:none ancestor).
      requestAnimationFrame(() => filterRef.current && filterRef.current.focus())
    }
  }, [open])
  // Arrow-key + Enter navigation, bound to the list while it (or any
  // of its descendants) holds focus.  Click on a card flows through
  // onSelect → re-render with the new selectedKey.
  const currentIdx = () => {
    if (selectedKey == null || !itemKey) return -1
    return items.findIndex((it) => itemKey(it) === selectedKey)
  }
  const moveSelection = (delta) => {
    if (items.length === 0) return
    const cur = currentIdx()
    let next = cur < 0 ? 0 : cur + delta
    next = ((next % items.length) + items.length) % items.length
    if (onSelect) onSelect(items[next])
  }
  const onListKey = (e) => {
    if (e.key === 'Enter') {
      if (!confirmDisabled && onConfirm) { e.preventDefault(); onConfirm() }
      return
    }
    if (e.key === 'ArrowDown')      { e.preventDefault(); moveSelection(+gridCols) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); moveSelection(-gridCols) }
    else if (e.key === 'ArrowRight'){ e.preventDefault(); moveSelection(+1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); moveSelection(-1) }
    else if (e.key === 'Home')      { e.preventDefault(); if (items[0] && onSelect) onSelect(items[0]) }
    else if (e.key === 'End')       { e.preventDefault(); if (items[items.length - 1] && onSelect) onSelect(items[items.length - 1]) }
  }
  // Filter Enter also confirms — if the user typed a query then hit
  // Enter without ever leaving the filter input, we still want to
  // open the selected (or single-match) item.
  const onFilterKey = (e) => {
    if (e.key === 'Enter') {
      if (!confirmDisabled && onConfirm) { e.preventDefault(); onConfirm() }
    }
  }
  const actions = [
    { label: 'Cancel', onClick: () => onCancel && onCancel() },
    {
      label: confirmLabel,
      primary: true,
      disabled: !!confirmDisabled,
      onClick: () => !confirmDisabled && onConfirm && onConfirm(),
    },
  ]
  return html`
    <${DialogModal} open=${open} title=${title} sub=${sub}
                    cardClass=${cardClass}
                    onCancel=${onCancel}
                    actions=${actions}
                    autofocusActionLabel="__never__">
      <div class="open-filter">
        <input ref=${filterRef}
               type="search"
               placeholder=${filterPlaceholder}
               value=${filterValue || ''}
               onInput=${(e) => onFilterChange && onFilterChange(e.currentTarget.value)}
               onKeyDown=${onFilterKey}
               autocomplete="off"
               autocorrect="off"
               autocapitalize="off"
               spellcheck=${false} />
      </div>
      <div class="open-list"
           tabindex="0"
           role="listbox"
           onKeyDown=${onListKey}>
        ${loading && items.length === 0
          ? html`<div class="loading">Loading…</div>`
          : items.length === 0
            ? html`<div class="loading">${emptyMessage}</div>`
            : items.map((it) => renderItem ? renderItem(it) : null)}
      </div>
    <//>
  `
}
