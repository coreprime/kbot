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
// Cross-module deps via hostCallbacks:
//   - refreshSchemaSelector() — rerender the dropdown after rename

import { state, $, hostCallbacks } from '../../host-context.js'
import { beginTransaction, commitTransaction } from '../undo.js'

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
  beginTransaction()
  const s = state.ota.schemas[idx]
  s.name = $('#se-name').value.trim() || 'Default'
  s.type = $('#se-type').value.trim() || 'Network 1'
  s.aiProfile = $('#se-ai-profile').value
  s.surfaceMetal = parseInt($('#se-surface-metal').value, 10) || 0
  s.mohoMetal = parseInt($('#se-moho-metal').value, 10) || 0
  s.humanMetal = parseInt($('#se-human-metal').value, 10) || 0
  s.computerMetal = parseInt($('#se-computer-metal').value, 10) || 0
  s.humanEnergy = parseInt($('#se-human-energy').value, 10) || 0
  s.computerEnergy = parseInt($('#se-computer-energy').value, 10) || 0
  s.meteorWeapon = $('#se-meteor-weapon').value.trim()
  s.meteorRadius = parseInt($('#se-meteor-radius').value, 10) || 0
  s.meteorDensity = parseInt($('#se-meteor-density').value, 10) || 0
  s.meteorDuration = parseInt($('#se-meteor-duration').value, 10) || 0
  s.meteorInterval = parseInt($('#se-meteor-interval').value, 10) || 0
  commitTransaction(`Edit schema: ${s.name}`)
  hostCallbacks.refreshSchemaSelector?.()
  closeSchemaEditor()
}
