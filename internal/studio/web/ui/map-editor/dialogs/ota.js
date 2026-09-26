// ota.js
//
// "Map Properties" dialog — edits the per-map .ota fields the TA
// engine actually consumes at load time (mission name, planet, wind
// + tidal + gravity, sea level, lava world, etc.).  These live on
// state.ota and round-trip through the save / export endpoints.
//
// Saving edits a loaded map's .ota in place, so Apply only changes what
// the user changed: text is stored as the game reads it (trimmed), the
// fields the game reads as fractions keep their fractions, and text the
// game would read back differently (a ';', a '//' or '/*' comment start)
// is refused with a message instead of being saved.
//
// Two side-effects on Apply worth noting:
//   - state.planet mirrors state.ota.planet so the tile-set keeps
//     up with the dialog without forcing the user through the world
//     picker.
//   - state.name mirrors state.ota.missionName so the tab chip's
//     label refreshes alongside the file's mission name.
//
// Cross-module deps via hostCallbacks:
//   - renderCanvas()          — repaint after planet swap
//   - renderMapTabs()         — refresh tab chip after mission rename
//   - refreshSchemaSelector() — schemas inherit name styling

import { state, $, clamp, hostCallbacks } from '../../host-context.js'
import { beginTransaction, commitTransaction } from '../undo.js'
import { cleanOTAText, firstOTAValueError, parseOTANumber } from '../ota-state.js'

// setSelectValue selects `value`, adding it as an option first when the
// list lacks it (an .ota may name a planet the tileset table does not),
// so opening and applying the dialog never changes the value.
function setSelectValue(select, value) {
  if (!select) return
  const v = value ?? ''
  if (v !== '' && ![...select.options].some((o) => o.value === v)) {
    const opt = document.createElement('option')
    opt.value = v
    opt.textContent = v
    select.appendChild(opt)
  }
  select.value = v
}

// showDialogMessage fills (or hides, for '') a dialog's message line.
export function showDialogMessage(sel, text) {
  const el = $(sel)
  if (!el) return
  el.textContent = text
  el.classList.toggle('hidden', !text)
}

export function openOTADialog() {
  if (!state.ota) return
  $('#ota-mission-name').value = state.ota.missionName ?? ''
  setSelectValue($('#ota-planet'), state.ota.planet)
  $('#ota-mission-description').value = state.ota.missionDescription ?? ''
  $('#ota-numplayers').value = state.ota.numPlayers ?? ''
  $('#ota-size').value = state.ota.size ?? ''
  $('#ota-tidal').value = state.ota.tidalStrength ?? 0
  $('#ota-solar').value = state.ota.solarStrength ?? 0
  $('#ota-gravity').value = state.ota.gravity ?? 0
  $('#ota-min-wind').value = state.ota.minWindSpeed ?? 0
  $('#ota-max-wind').value = state.ota.maxWindSpeed ?? 0
  $('#ota-killmul').value = state.ota.killmul ?? 0
  $('#ota-lava').value = String(state.ota.lavaWorld || 0)
  $('#ota-sea-level').value = state.ota.seaLevel ?? 63
  $('#ota-impassible-water').value = String(state.ota.impassibleWater || 0)
  $('#ota-water-damage').value = String(state.ota.waterDoesDamage || 0)
  showDialogMessage('#ota-error', '')
  showDialogMessage('#ota-source-error', state.ota.error
    ? `This map's .ota could not be read (${state.ota.error}). Saving leaves the file unchanged.`
    : '')
  $('#ota-dialog').classList.remove('hidden')
}

export function closeOTADialog() { $('#ota-dialog').classList.add('hidden') }

export function wireOTADialog() {
  $('#ota-cancel').addEventListener('click', closeOTADialog)
  $('#ota-apply').addEventListener('click', applyOTADialog)
}

export function applyOTADialog() {
  const text = {
    missionName: cleanOTAText($('#ota-mission-name').value),
    missionDescription: cleanOTAText($('#ota-mission-description').value),
    numPlayers: cleanOTAText($('#ota-numplayers').value),
    size: cleanOTAText($('#ota-size').value),
  }
  const problem = firstOTAValueError({
    'Mission name': text.missionName,
    Description: text.missionDescription,
    'Players supported': text.numPlayers,
    Size: text.size,
  })
  if (problem) {
    showDialogMessage('#ota-error', problem)
    return
  }
  beginTransaction()
  Object.assign(state.ota, text)
  state.ota.planet = $('#ota-planet').value
  if (state.ota.planet) state.planet = state.ota.planet
  state.ota.tidalStrength = parseOTANumber($('#ota-tidal').value, true)
  state.ota.solarStrength = parseOTANumber($('#ota-solar').value)
  state.ota.gravity = parseOTANumber($('#ota-gravity').value)
  state.ota.minWindSpeed = parseOTANumber($('#ota-min-wind').value)
  state.ota.maxWindSpeed = parseOTANumber($('#ota-max-wind').value)
  state.ota.killmul = parseOTANumber($('#ota-killmul').value, true)
  state.ota.lavaWorld = parseOTANumber($('#ota-lava').value)
  state.ota.seaLevel = clamp(parseOTANumber($('#ota-sea-level').value), 0, 255)
  state.ota.impassibleWater = parseOTANumber($('#ota-impassible-water').value)
  state.ota.waterDoesDamage = parseOTANumber($('#ota-water-damage').value)
  commitTransaction('Edit map properties')
  state.name = state.ota.missionName || state.name
  hostCallbacks.renderMapTabs?.()
  hostCallbacks.refreshSchemaSelector?.()
  closeOTADialog()
  hostCallbacks.renderCanvas?.()
}
