// ota.js
//
// "Map Properties" dialog — edits the per-map .ota fields the TA
// engine actually consumes at load time (mission name, planet, wind
// + tidal + gravity, sea level, lava world, etc.).  These live on
// state.ota and round-trip through the save / export endpoints.
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

export function openOTADialog() {
  if (!state.ota) return
  $('#ota-mission-name').value = state.ota.missionName
  $('#ota-planet').value = state.ota.planet
  $('#ota-mission-description').value = state.ota.missionDescription
  $('#ota-numplayers').value = state.ota.numPlayers
  $('#ota-size').value = state.ota.size
  $('#ota-tidal').value = state.ota.tidalStrength
  $('#ota-solar').value = state.ota.solarStrength
  $('#ota-gravity').value = state.ota.gravity
  $('#ota-min-wind').value = state.ota.minWindSpeed
  $('#ota-max-wind').value = state.ota.maxWindSpeed
  $('#ota-killmul').value = state.ota.killmul
  $('#ota-lava').value = String(state.ota.lavaWorld || 0)
  $('#ota-sea-level').value = state.ota.seaLevel ?? 63
  $('#ota-impassible-water').value = String(state.ota.impassibleWater || 0)
  $('#ota-water-damage').value = String(state.ota.waterDoesDamage || 0)
  $('#ota-dialog').classList.remove('hidden')
}

export function closeOTADialog() { $('#ota-dialog').classList.add('hidden') }

export function wireOTADialog() {
  $('#ota-cancel').addEventListener('click', closeOTADialog)
  $('#ota-apply').addEventListener('click', applyOTADialog)
}

export function applyOTADialog() {
  beginTransaction()
  state.ota.missionName = $('#ota-mission-name').value.trim() || state.name
  state.ota.planet = $('#ota-planet').value
  state.planet = state.ota.planet
  state.ota.missionDescription = $('#ota-mission-description').value
  state.ota.numPlayers = $('#ota-numplayers').value || '2'
  state.ota.size = $('#ota-size').value
  state.ota.tidalStrength = parseInt($('#ota-tidal').value, 10) || 0
  state.ota.solarStrength = parseInt($('#ota-solar').value, 10) || 0
  state.ota.gravity = parseInt($('#ota-gravity').value, 10) || 0
  state.ota.minWindSpeed = parseInt($('#ota-min-wind').value, 10) || 0
  state.ota.maxWindSpeed = parseInt($('#ota-max-wind').value, 10) || 0
  state.ota.killmul = parseInt($('#ota-killmul').value, 10) || 0
  state.ota.lavaWorld = parseInt($('#ota-lava').value, 10) || 0
  state.ota.seaLevel = clamp(parseInt($('#ota-sea-level').value, 10) || 0, 0, 255)
  state.ota.impassibleWater = parseInt($('#ota-impassible-water').value, 10) || 0
  state.ota.waterDoesDamage = parseInt($('#ota-water-damage').value, 10) || 0
  commitTransaction('Edit map properties')
  state.name = state.ota.missionName
  hostCallbacks.renderMapTabs?.()
  hostCallbacks.refreshSchemaSelector?.()
  closeOTADialog()
  hostCallbacks.renderCanvas?.()
}
