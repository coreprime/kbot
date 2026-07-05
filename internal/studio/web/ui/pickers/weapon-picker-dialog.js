// weapon-picker-dialog.js
//
// React-rendered Change Weapon picker.  Lists every TDF weapon
// section the kbot server returns via /api/studio/weapons with the
// same key stats the active Weapons panel surfaces — range,
// velocity, reload, burst, model, plus a colour swatch and chips
// for the beam/smoke/cmd-fire/tracks/ballistic/self-prop flags.
// The currently-installed weapon for the active slot is marked
// "(current)" and highlighted via `.active`.
//
// Resolves with the picked weapon name (uppercased TDF section
// key) or null on cancel.  Host (studio.js) handles the
// /api/studio/unit/{name}?weaponN=... override + Weapons panel
// re-render after Apply.

import { signal } from '@preact/signals'
import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { PickerModal } from '@coreprime/kbot-ui/picker-modal'

const _state = signal(null)

// openWeaponPicker — surface the picker.  Resolves with the picked
// weapon name or null on cancel.  paletteColor is an optional
// callback (idx) → [r,g,b] (0..1) for the colour swatch; when omitted
// the swatch is a muted empty tile.
export function openWeaponPicker({
  items = [],
  loading = false,
  query = '',
  currentName = '',
  slotLabel = '',
  paletteColor = null,
} = {}) {
  return new Promise((resolve) => {
    const prev = _state.value
    if (prev && typeof prev.onCancel === 'function') prev.onCancel()
    _state.value = {
      items, loading, query, selectedName: null,
      currentName, slotLabel, paletteColor,
      onApply: (name) => { _state.value = null; resolve(name) },
      onCancel: () => { _state.value = null; resolve(null) },
    }
  })
}

export function updateWeaponPicker(patch) {
  const cur = _state.value
  if (!cur) return
  _state.value = { ...cur, ...patch }
}

export function closeWeaponPicker() {
  const cur = _state.value
  if (cur && typeof cur.onCancel === 'function') cur.onCancel()
  _state.value = null
}

export function WeaponPickerDialog() {
  const st = _state.value
  if (!st) return null
  const confirmDisabled = !st.selectedName
  const onSelect = (w) => {
    _state.value = { ..._state.value, selectedName: w.name }
  }
  const onConfirm = () => {
    if (st.selectedName && st.onApply) st.onApply(st.selectedName)
  }
  const onCancel = () => { if (st.onCancel) st.onCancel() }
  const fmt = (v, unit) => (v == null || v === 0)
    ? '—'
    : `${(+v).toFixed(2).replace(/\.?0+$/, '')}${unit ? ' ' + unit : ''}`
  const renderItem = (w) => {
    const isCurrent = w.name === st.currentName
    const isSelected = w.name === st.selectedName
    const cls = [
      'open-list-item', 'weapon-list-item',
      isCurrent ? 'active' : '',
      isSelected ? 'selected' : '',
    ].filter(Boolean).join(' ')
    // Colour swatch — uses host-supplied paletteColor() callback so
    // the picker doesn't need a direct reference to the live viewer.
    const swatchStyle = (w.colorIdx > 0 && st.paletteColor)
      ? (() => {
          const c = st.paletteColor(w.colorIdx)
          if (!c) return null
          return `background: rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`
        })()
      : null
    const flags = []
    if (w.beamWeapon)  flags.push('beam')
    if (w.smokeTrail)  flags.push('smoke')
    if (w.selfProp)    flags.push('self-prop')
    if (w.tracks)      flags.push('tracks')
    if (w.ballistic)   flags.push('ballistic')
    if (w.commandFire) flags.push('cmd-fire')
    return html`
      <button type="button" class=${cls} key=${w.name}
              onClick=${() => onSelect(w)}
              onDblClick=${() => st.onApply && st.onApply(w.name)}>
        <div class=${swatchStyle ? 'thumb weapon-thumb' : 'thumb weapon-thumb weapon-thumb-empty'}
             style=${swatchStyle || null}></div>
        <div class="title">${w.name}${isCurrent ? '  (current)' : ''}</div>
        <div class="meta">
          Reload ${fmt(w.reloadSec, 's')} · Range ${fmt(w.rangeWU, 'wu')} · Velocity ${fmt(w.velocityWU, 'wu/s')}
        </div>
        <div class="meta">
          ${(w.burst > 1) ? `Burst ${w.burst}×${fmt(w.burstRateSec, 's')}` : 'Single shot'} · Model ${w.model || '—'}
        </div>
        ${flags.length > 0 ? html`
          <div class="model-chips">
            ${flags.map((f) => html`<span class="model-chip on" key=${f}>${f}</span>`)}
          </div>
        ` : null}
      </button>
    `
  }
  return html`
    <${PickerModal} open=${true}
                    title=${`Change Weapon${st.slotLabel ? ' — ' + st.slotLabel : ''}`}
                    sub="Pick a different weapon for this slot.  The change is live in the studio session only — the underlying FBI on disk is not modified.  Hit 'Reload Unit' to revert to the on-disk definition."
                    filterPlaceholder="Filter by name, model, or sound"
                    filterValue=${st.query}
                    onFilterChange=${(q) => { _state.value = { ..._state.value, query: q } }}
                    loading=${st.loading}
                    emptyMessage=${st.loading
                      ? 'Loading weapons…'
                      : (st.items.length === 0 ? 'No weapons found in this VFS.' : 'No weapons match the filter.')}
                    items=${_filteredItems(st)}
                    selectedKey=${st.selectedName}
                    onSelect=${onSelect}
                    onConfirm=${onConfirm}
                    onCancel=${onCancel}
                    confirmLabel="Apply"
                    confirmDisabled=${confirmDisabled}
                    renderItem=${renderItem}
                    itemKey=${(w) => w.name} />
  `
}

function _filteredItems(st) {
  const q = (st.query || '').trim().toLowerCase()
  if (!q) return st.items
  return st.items.filter((w) => (
    `${w.name} ${w.model || ''} ${w.soundStart || ''}`.toLowerCase().includes(q)
  ))
}
