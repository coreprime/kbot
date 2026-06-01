// register-tab.js
//
// Registers the 'files' tab type with the central tab registry.  The
// Files tab is a 2D HTML/Preact surface (no GL stage), so its lifecycle
// is simpler than the map/unit/sandbox tabs: activate reveals the
// overlay, deactivate hides it, and there's nothing to dispose because
// the mounted browser tree is reused across the tab's lifetime.

import { registerTabType } from '../tab-registry.js'
import { activateFilesTab, deactivateFilesTab } from './tab.js'

class FilesTabInstance {
  constructor(spec) {
    this.spec = spec || {}
    this._tabRef = null
  }

  attachTabRef(tab) {
    this._tabRef = tab
    tab.name = 'Files'
    tab.displayName = 'Files'
  }

  displayName() { return 'Files' }
  dirty() { return false }

  async activate(_ctx) { await activateFilesTab() }
  deactivate(_ctx) { deactivateFilesTab() }
  async canClose(_ctx) { return true }
  dispose(_ctx) { deactivateFilesTab() }
}

export function registerFilesTabType() {
  registerTabType({
    typeId: 'files',
    label: 'Files',
    glyph: '🗂',
    create(spec) { return new FilesTabInstance(spec) },
  })
}
