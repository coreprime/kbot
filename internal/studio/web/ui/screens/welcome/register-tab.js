// register-tab.js
//
// Registers the 'welcome' tab type. Like the Files tab it's a 2D Preact
// surface with no GL stage, so its lifecycle is just reveal/hide — the
// welcome card body is mounted once at boot by mountWelcomeScreen().

import { registerTabType } from '../../tab-registry.js'
import { activateWelcomeTab, deactivateWelcomeTab } from './tab.js'

class WelcomeTabInstance {
  constructor(spec) {
    this.spec = spec || {}
    this._tabRef = null
  }

  attachTabRef(tab) {
    this._tabRef = tab
    tab.name = 'Welcome'
    tab.displayName = 'Welcome'
  }

  displayName() { return 'Welcome' }
  dirty() { return false }

  statusBar() {
    return {
      title: 'Welcome', meta: '', hints: '',
      status: this._tabRef?._status != null ? this._tabRef._status : '',
    }
  }

  async activate(_ctx) { activateWelcomeTab() }
  deactivate(_ctx) { deactivateWelcomeTab() }
  async canClose(_ctx) { return true }
  dispose(_ctx) { deactivateWelcomeTab() }
}

export function registerWelcomeTabType() {
  registerTabType({
    typeId: 'welcome',
    label: 'Welcome',
    glyph: '🏠',
    create(spec) { return new WelcomeTabInstance(spec) },
  })
}
