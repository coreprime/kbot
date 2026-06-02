// script-commands-panel.js
//
// React-rendered Script Commands overlay — one button per COB entry
// point the loaded unit ships, plus an "Include Private" filter for
// the lowercase internal-helper convention TA scripts use.  Each
// button fires the matching script via the host bridge's runCobEntry;
// live disabled state mirrors whether that script currently has a
// running thread (so the user can't pile on duplicate invocations).
//
// Historically called "Actions" — renamed to "Script Commands" since
// the per-script firing buttons are unambiguously script triggers,
// not the user-facing unit commands (Move / Attack / Stop) the
// Controls panel owns.  The DOM id `mv-inspector-actions` is kept
// so persisted visibility prefs survive the rename, but every
// user-visible label + the React class name reflects the new title.
//
// Sandbox mode hides this panel entirely (managed by the host); the
// component still renders cleanly when given an empty selection so
// quick visibility flips don't tear down + rebuild the body.

import { htm as html } from '@kbot/ui/htm-bind'
import { FloatingPanel } from '@kbot/ui/floating-panel'
import { panelSignals } from '@kbot/ui/panel-store'
import { mv, runtimeTick, actionsIncludePrivate, setActionsIncludePrivate } from '/ui/common/inspector-store.js'
import { hostBridge } from '/ui/common/host-bridge.js'

// PANEL_ID — historical name retained so persisted visibility /
// position state from before the Actions → Script Commands rename
// keeps applying.  Touching the id would silently reset every user's
// panel layout for this overlay.
const PANEL_ID = 'mv-inspector-actions'

// First-char-isLowercase classifier — TA convention is CamelCase for
// public entry points (Create, Activate, FirePrimary) and lowercase
// for internal helpers (activatescr, initstate).  Same predicate
// the legacy renderer used so the visible set stays stable.
function _isPrivate(name) {
  const c = name.charAt(0)
  return c === c.toLowerCase() && c !== c.toUpperCase()
}

// _liveLifecycle — pulls the cob's lifecycle stage off the proxy
// (set by the host's tab + Create handling).  'unborn' or 'creating'
// means everything except Create is gated; runtimeTick re-fires us
// each publish so the gating updates without us subscribing to the
// cob object's internal mutations directly.
function _liveLifecycle(cob) { return cob && cob._lifecycle }

function ScriptCommandButton({ cob, name }) {
  const isPriv = _isPrivate(name)
  const lifecycle = _liveLifecycle(cob)
  const gated = lifecycle === 'unborn' || lifecycle === 'creating'
  const running = hostBridge.isCobScriptRunning(cob, name)
  const blockedByCreate = gated && !/^Create$/i.test(name)
  const disabled = running || blockedByCreate
  const title = running
    ? `${name} is already running`
    : blockedByCreate
      ? `Run Create first — it must finish before other scripts can fire`
      : (isPriv ? `Run ${name} (internal helper)` : `Run ${name}`)
  const className = isPriv ? 'mv-actions-btn private' : 'mv-actions-btn'
  return html`
    <button class=${className}
            disabled=${disabled}
            title=${title}
            onClick=${(e) => { e.stopPropagation(); hostBridge.runCobEntry(cob, name) }}>
      ${name}
    </button>
  `
}

function ScriptCommandsBody() {
  const { visible } = panelSignals(PANEL_ID)
  void runtimeTick.value  // subscribe so per-tick running flags re-render
  if (!visible.value) return null
  const proxy = mv.value
  const cob = proxy && proxy.cob
  if (!cob || !cob.unit) {
    return html`<div class="mv-inspector-empty">No COB loaded.</div>`
  }
  const includePriv = actionsIncludePrivate.value
  const names = (typeof cob.listScripts === 'function' ? cob.listScripts() : [])
    .filter((n) => includePriv || !_isPrivate(n))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  // Filter checkbox sits ABOVE the empty/list region so the user can
  // tick "Include Private" and the helpers appear without losing the
  // checkbox.  Stop the click from bubbling out — without this, the
  // panel header drag listener can grab the gesture and feel jumpy.
  return html`
    <label class="mv-actions-filter"
           onClick=${(e) => e.stopPropagation()}
           onPointerDown=${(e) => e.stopPropagation()}>
      <input type="checkbox"
             checked=${includePriv}
             onChange=${(e) => setActionsIncludePrivate(e.currentTarget.checked)} />
      <span>Include Private</span>
    </label>
    <div class="mv-actions-list">
      ${names.length === 0 ? html`
        <div class="mv-inspector-empty">
          ${includePriv ? 'COB has no scripts.' : 'Only private helpers — tick Include Private.'}
        </div>
      ` : names.map((n) => html`<${ScriptCommandButton} cob=${cob} name=${n} key=${n} />`)}
    </div>
  `
}

export function ScriptCommandsPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Script Commands">
      <${ScriptCommandsBody} />
    <//>
  `
}
