// open-map-dialog.js
//
// React-rendered Open Map picker.  Lists every TNT map the kbot
// server returns via /api/studio/maps with a minimap thumbnail +
// dimensions / planet / player-count meta line.  Returns the
// picked map record (so the host can route it through the existing
// confirmOpenMap → fetch /api/studio/load → openLoadedMap pipeline)
// or null on cancel.
//
// Shape mirrors open-unit-dialog: singleton signal carries the
// per-call state, the host pushes updates while it polls
// /api/studio/maps for the loading catalog.

import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'
import { PickerModal } from '/ui/pickers/picker-modal.js'

const _state = signal(null)

// openMapDialog — surface the picker and resolve with the picked
// map record (or null on cancel).  Caller pushes data + loading
// state via updateMapDialog() while async work runs.
export function openMapDialog({
  items = [],
  loading = false,
  query = '',
  selectedPath = null,
} = {}) {
  return new Promise((resolve) => {
    const prev = _state.value
    if (prev && typeof prev.onCancel === 'function') prev.onCancel()
    _state.value = {
      items, loading, query, selectedPath,
      onApply: (rec) => { _state.value = null; resolve(rec) },
      onCancel: () => { _state.value = null; resolve(null) },
    }
  })
}

export function updateMapDialog(patch) {
  const cur = _state.value
  if (!cur) return
  _state.value = { ...cur, ...patch }
}

export function closeMapDialog() {
  const cur = _state.value
  if (cur && typeof cur.onCancel === 'function') cur.onCancel()
  _state.value = null
}

export function OpenMapDialog() {
  const st = _state.value
  if (!st) return null
  const selected = st.selectedPath
    ? st.items.find((m) => m.path === st.selectedPath)
    : null
  const confirmDisabled = !selected
  const onSelect = (m) => {
    _state.value = { ..._state.value, selectedPath: m.path }
  }
  const onConfirm = () => {
    if (selected && st.onApply) st.onApply(selected)
  }
  const onCancel = () => { if (st.onCancel) st.onCancel() }
  // Card renderer — mirrors legacy renderOpenList: thumb + title +
  // meta string.  No chips; map records don't carry the FBI/3DO/COB
  // tri-state the unit picker has.
  const renderItem = (m) => {
    const cls = ['open-list-item', m.path === st.selectedPath ? 'selected' : '']
      .filter(Boolean).join(' ')
    const title = m.missionName || m.name
    const meta = [
      m.tileW && m.tileH ? `${m.tileW}×${m.tileH}` : null,
      m.planet || null,
      m.numPlayers ? `${m.numPlayers} players` : null,
    ].filter(Boolean).join(' · ')
    return html`
      <button type="button" class=${cls} key=${m.path}
              onClick=${() => onSelect(m)}
              onDblClick=${() => st.onApply && st.onApply(m)}>
        ${m.minimapUrl
          ? html`<img class="thumb" src=${m.minimapUrl} alt="" loading="lazy" />`
          : html`<div class="thumb"></div>`}
        <div class="title">${title}</div>
        <div class="meta">${meta}</div>
      </button>
    `
  }
  return html`
    <${PickerModal} open=${true}
                    title="Open an existing map"
                    sub="Pick a map from your kbot context.  Editing the loaded data is a work in progress — for now you can browse and re-stamp over it."
                    filterPlaceholder="Filter by name, planet, or player count"
                    filterValue=${st.query}
                    onFilterChange=${(q) => { _state.value = { ..._state.value, query: q } }}
                    loading=${st.loading}
                    emptyMessage=${st.loading ? 'Loading maps…' : 'No maps in this context match.'}
                    items=${_filteredItems(st)}
                    selectedKey=${st.selectedPath}
                    onSelect=${onSelect}
                    onConfirm=${onConfirm}
                    onCancel=${onCancel}
                    confirmDisabled=${confirmDisabled}
                    renderItem=${renderItem}
                    itemKey=${(m) => m.path} />
  `
}

function _filteredItems(st) {
  const q = (st.query || '').trim().toLowerCase()
  if (!q) return st.items
  return st.items.filter((m) => {
    const hay = `${m.name} ${m.missionName || ''} ${m.planet || ''} ${m.numPlayers || ''}`.toLowerCase()
    return hay.includes(q)
  })
}
