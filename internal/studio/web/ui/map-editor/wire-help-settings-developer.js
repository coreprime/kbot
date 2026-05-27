// wire-help-settings-developer.js
//
// Boot-time wiring for the legacy ribbon's Help / Settings / Developer
// trio.  Lives in /ui/map-editor/ because the Developer dialog is owned
// by the map-editor's dev-stats subsystem; bundling all three buttons
// here keeps the wire chain in one place and the file in the right
// section per the "common never imports from sections" rule.
//
// Wired once from studio.js' boot block — needed from the moment the
// page loads (a user might open straight into a 3DO model without ever
// touching the map editor), but the ribbon DOM IDs that own these
// buttons are part of the map-editor's legacy template so this is the
// honest home for the wiring.

import { $, $$ } from '../host-context.js'
import { openDeveloperDialog, closeDeveloperDialog } from './dev-stats.js'
import { openHelpDialog, closeHelpDialog } from '../dialogs/help.js'
import { openSettingsDialog } from '../dialogs/settings.js'

export function wireDeveloperDialog() {
  $('#btn-developer')?.addEventListener('click', openDeveloperDialog)
  $('#dev-dialog-close')?.addEventListener('click', closeDeveloperDialog)
  $('#btn-help')?.addEventListener('click', openHelpDialog)
  $('#help-close')?.addEventListener('click', closeHelpDialog)
  // Help dialog tab strip — same DOM pattern as the welcome tabs.
  $$('#help-dialog .help-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.helpTab
      $$('#help-dialog .help-tab').forEach((t) => {
        const on = t.dataset.helpTab === key
        t.classList.toggle('active', on)
        t.setAttribute('aria-selected', on ? 'true' : 'false')
      })
      $$('#help-dialog .help-tab-body').forEach((b) => {
        b.classList.toggle('active', b.dataset.helpTabBody === key)
      })
    })
  })
  $('#btn-settings')?.addEventListener('click', openSettingsDialog)
  // Apply / Reset / Escape are handled by the React Settings dialog
  // itself (see /ui/dialogs/settings-dialog.js).  The legacy static
  // #settings-apply / #settings-reset / #settings-cancel buttons in
  // the static HTML are no longer driven.
  // Settings dialog tab strip is React-managed now.
  $$('#developer-dialog .dev-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.devTab
      $$('#developer-dialog .dev-tab').forEach((t) => t.classList.toggle('active', t === tab))
      $$('#developer-dialog .dev-tab-body').forEach((b) => b.classList.toggle('active', b.dataset.devTabBody === key))
    })
  })
}
