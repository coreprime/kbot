// schema-editor.js
//
// Per-schema editor — the gear icon on each schema row in the
// schema-dropdown opens this dialog so the user can tweak the
// economy / AI / meteor-shower fields without leaving the editor.
//
// schemaBeingEdited holds the index of the schema currently bound
// to the dialog so Apply writes back to the right slot.  Stored on
// _state instead of as a module-level `let` so the export surface
// stays purely functional (and the value isn't a stale closure if
// Open is called twice without an Apply in between).
//
// Apply stores what the game reads: text trimmed, the meteor density,
// duration and interval as fractions, and refuses text the game would read
// back differently (see ota-state.js), so a save that edits the .ota in
// place changes only what the user changed.
//
// Cross-module deps via hostCallbacks:
//   - refreshSchemaSelector() — rerender the dropdown after rename

import { state, $, hostCallbacks } from '../../host-context.js'
import { beginTransaction, commitTransaction } from '../undo.js'
import { cleanOTAText, firstOTAValueError, parseOTANumber } from '../ota-state.js'
import { showDialogMessage } from './ota.js'

const _state = { schemaBeingEdited: -1 }

export function openSchemaEditor(index) {
  if (!state.ota || !state.ota.schemas[index]) return
  _state.schemaBeingEdited = index
  const s = state.ota.schemas[index]
  $('#se-name').value = s.name || ''
  $('#se-type').value = s.type || ''
  $('#se-ai-profile').value = s.aiProfile || ''
  $('#se-surface-metal').value = s.surfaceMetal || 0
  $('#se-moho-metal').value = s.mohoMetal || 0
  $('#se-human-metal').value = s.humanMetal || 0
  $('#se-computer-metal').value = s.computerMetal || 0
  $('#se-human-energy').value = s.humanEnergy || 0
  $('#se-computer-energy').value = s.computerEnergy || 0
  $('#se-meteor-weapon').value = s.meteorWeapon || ''
  $('#se-meteor-radius').value = s.meteorRadius || 0
  $('#se-meteor-density').value = s.meteorDensity || 0
  $('#se-meteor-duration').value = s.meteorDuration || 0
  $('#se-meteor-interval').value = s.meteorInterval || 0
  showDialogMessage('#se-error', '')
  // Close the schema dropdown so it doesn't sit on top of the dialog.
  $('#schema-dropdown-popup')?.classList.add('hidden')
  $('#schema-edit-dialog').classList.remove('hidden')
}

export function closeSchemaEditor() {
  $('#schema-edit-dialog').classList.add('hidden')
  _state.schemaBeingEdited = -1
}

export function wireSchemaEditor() {
  $('#se-cancel')?.addEventListener('click', closeSchemaEditor)
  $('#se-apply')?.addEventListener('click', applySchemaEditor)
}

export function applySchemaEditor() {
  const idx = _state.schemaBeingEdited
  if (idx < 0 || !state.ota?.schemas[idx]) {
    closeSchemaEditor()
    return
  }
  const text = {
    type: cleanOTAText($('#se-type').value),
    aiProfile: cleanOTAText($('#se-ai-profile').value),
    meteorWeapon: cleanOTAText($('#se-meteor-weapon').value),
  }
  const problem = firstOTAValueError({
    Type: text.type,
    'AI profile': text.aiProfile,
    'Meteor weapon': text.meteorWeapon,
  })
  if (problem) {
    showDialogMessage('#se-error', problem)
    return
  }
  beginTransaction()
  const s = state.ota.schemas[idx]
  // The name only labels the schema in the editor; the file numbers
  // schemas Schema 0, Schema 1, ... by their order.
  s.name = $('#se-name').value.trim() || s.name || 'Default'
  Object.assign(s, text)
  s.surfaceMetal = parseOTANumber($('#se-surface-metal').value)
  s.mohoMetal = parseOTANumber($('#se-moho-metal').value)
  s.humanMetal = parseOTANumber($('#se-human-metal').value)
  s.computerMetal = parseOTANumber($('#se-computer-metal').value)
  s.humanEnergy = parseOTANumber($('#se-human-energy').value)
  s.computerEnergy = parseOTANumber($('#se-computer-energy').value)
  s.meteorRadius = parseOTANumber($('#se-meteor-radius').value)
  s.meteorDensity = parseOTANumber($('#se-meteor-density').value, true)
  s.meteorDuration = parseOTANumber($('#se-meteor-duration').value, true)
  s.meteorInterval = parseOTANumber($('#se-meteor-interval').value, true)
  commitTransaction(`Edit schema: ${s.name}`)
  hostCallbacks.refreshSchemaSelector?.()
  closeSchemaEditor()
}
