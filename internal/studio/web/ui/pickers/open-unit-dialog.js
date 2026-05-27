// open-unit-dialog.js
//
// React-rendered Open Unit picker.  Lists every units/*.fbi in the
// VFS plus any orphan object3d/*.3do without an FBI ref, with the
// FBI / 3DO / COB presence chips + build-picture thumbnail + a meta
// line (slug · side · category).  Selecting a row that has a 3DO
// enables the primary action; rows without a 3DO are dimmed and
// can't be selected.  Doubleclick on a viable row opens immediately.
//
// The dialog is driven by a singleton signal carrying the open
// state, items, filter, selection, and the per-call callbacks
// (onApply for confirm, onCancel for dismiss).  The host
// (studio.js) calls openUnitDialog({ ... }) to surface it and
// drives state mutations through the helpers exported below.

import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'
import { PickerModal } from '/ui/pickers/picker-modal.js'

// _state — singleton signal carrying the picker's full state and the
// callbacks for the current invocation.  Null when not open.  Shape:
//   { items, loading, query, selectedName, sandboxIntent,
//     onApply(name, opts), onCancel() }
// sandboxIntent: when true the confirm action returns the picked
// name for a sandbox spawn rather than opening the viewer (host
// distinguishes these flows itself; the dialog just hands back the
// pick).
const _state = signal(null)

// openUnitDialog — host-facing entry point.  Replaces any in-flight
// request (resolving the prior one as cancelled) and returns a
// Promise<string|null> with the picked unit name or null on cancel.
export function openUnitDialog({
  items = [],
  loading = false,
  query = '',
  selectedName = null,
  sandboxIntent = false,
}) {
  return new Promise((resolve) => {
    const prev = _state.value
    if (prev && typeof prev.onCancel === 'function') prev.onCancel()
    _state.value = {
      items, loading, query, selectedName, sandboxIntent,
      onApply: (name) => {
        _state.value = null
        resolve({ name, sandboxIntent })
      },
      onCancel: () => {
        _state.value = null
        resolve(null)
      },
    }
  })
}

// updateUnitDialog — host calls this after async work (fetchModels,
// poll, weapon-swap re-load) to push fresh data into the open
// dialog without forcing the user to close + reopen.  No-op when no
// dialog is open.
export function updateUnitDialog(patch) {
  const cur = _state.value
  if (!cur) return
  _state.value = { ...cur, ...patch }
}

// closeUnitDialog — programmatic dismiss (e.g. ESC pressed inside
// other UI, host-side teardown).  Resolves the in-flight promise
// as cancelled.
export function closeUnitDialog() {
  const cur = _state.value
  if (cur && typeof cur.onCancel === 'function') cur.onCancel()
  _state.value = null
}

// OpenUnitDialog — the visible component.  Reads the singleton
// signal; renders nothing when no request is in flight.
export function OpenUnitDialog() {
  const st = _state.value
  if (!st) return null
  const selected = st.selectedName
    ? st.items.find((m) => m.name === st.selectedName)
    : null
  const confirmDisabled = !selected || !selected.has3DO
  const onSelect = (m) => {
    if (!m.has3DO) return  // dimmed entries can't be selected
    _state.value = { ..._state.value, selectedName: m.name }
  }
  const onConfirm = () => {
    if (!confirmDisabled && st.onApply) st.onApply(st.selectedName)
  }
  const onCancel = () => { if (st.onCancel) st.onCancel() }
  // Card renderer — mirrors the legacy renderModelList layout so the
  // existing studio.css rules for .model-list-item / .model-chip /
  // .model-thumb apply unchanged.
  const renderItem = (m) => {
    const cls = [
      'open-list-item', 'model-list-item',
      !m.has3DO ? 'disabled-entry' : '',
      m.name === st.selectedName ? 'selected' : '',
    ].filter(Boolean).join(' ')
    const title = m.unitTitle || m.unitName || m.name
    const slug = m.unitName ? m.unitName.toUpperCase() : m.name.toUpperCase()
    const meta = [slug, m.side || null, m.category || null].filter(Boolean).join(' · ')
    const sub = m.description || ''
    return html`
      <button type="button" class=${cls} key=${m.name}
              onClick=${() => onSelect(m)}
              onDblClick=${() => { if (m.has3DO && st.onApply) st.onApply(m.name) }}>
        ${m.hasBuildPic ? html`
          <div class="thumb model-thumb">
            <img loading="lazy" alt=""
                 src=${`/api/studio/buildpic/${encodeURIComponent(m.name)}`} />
          </div>
        ` : html`
          <div class="thumb model-thumb model-thumb-empty"
               title="No build picture in this VFS"></div>
        `}
        <div class="title">${title}</div>
        <div class="meta">${meta}</div>
        ${sub ? html`<div class="meta">${sub}</div>` : null}
        <div class="model-chips">
          <span class=${'model-chip ' + (m.hasFBI ? 'on' : 'off')}
                title=${m.hasFBI
                  ? 'unit definition (FBI) found in the VFS'
                  : 'no FBI — this is an orphan 3DO (prop / feature / debug geometry)'}>FBI</span>
          <span class=${'model-chip ' + (m.has3DO ? 'on' : 'off')}
                title=${m.has3DO
                  ? 'unit geometry (3DO) found'
                  : 'no 3DO — this unit cannot be opened in the 3D viewer'}>3DO</span>
          <span class=${'model-chip ' + (m.hasCOB ? 'on' : 'off')}
                title=${m.hasCOB
                  ? 'animation script (COB) found'
                  : 'no COB — the unit will display statically with no animator'}>COB</span>
        </div>
      </button>
    `
  }
  return html`
    <${PickerModal} open=${true}
                    title="Open Unit"
                    sub="Pick a TA unit to view its 3D geometry, drive its COB animations and fire its weapons.  Orphan 3DOs (props / features) without an FBI definition also appear at the bottom of the list.  The coloured chips on each row show which of the FBI / 3DO / COB files for that unit were found in the loaded VFS."
                    filterPlaceholder="Filter by name, side, or category"
                    filterValue=${st.query}
                    onFilterChange=${(q) => { _state.value = { ..._state.value, query: q } }}
                    loading=${st.loading}
                    emptyMessage=${st.loading ? 'Loading units…' : 'No models match.'}
                    items=${_filteredItems(st)}
                    selectedKey=${st.selectedName}
                    onSelect=${onSelect}
                    onConfirm=${onConfirm}
                    onCancel=${onCancel}
                    confirmLabel=${st.sandboxIntent ? 'Place Unit' : 'Open selected'}
                    confirmDisabled=${confirmDisabled}
                    renderItem=${renderItem}
                    itemKey=${(m) => m.name} />
  `
}

// _filteredItems — applies the freeform substring filter to the
// item list.  Kept here (not in the picker-modal) because each
// picker filters over different fields.
function _filteredItems(st) {
  const q = (st.query || '').trim().toLowerCase()
  if (!q) return st.items
  return st.items.filter((m) => {
    const hay = `${m.name} ${m.unitName || ''} ${m.unitTitle || ''} ${m.side || ''} ${m.category || ''} ${m.description || ''}`.toLowerCase()
    return hay.includes(q)
  })
}
