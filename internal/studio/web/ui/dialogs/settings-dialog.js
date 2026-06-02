// settings-dialog.js
//
// React-rendered Settings dialog.  Three tabs (General, Map Editor,
// Unit Editor) with form fields backed by the host's state.settings +
// state.show* flags + the force-target-ground localStorage key.  The
// host calls openSettingsDialog({...}) with the initial values + an
// onApply(values) callback that persists to its own state and flushes
// the downstream effects (renderCanvas, syncDomFromPrefs, etc.).
//
// Modal chrome composes the shared DialogModal.  Field state lives in
// the component itself so typing into a number input doesn't round-
// trip through the host — Apply lifts the form's current values back
// to the host in one shot.

import { signal } from '@preact/signals'
import { useState, useEffect } from 'preact/hooks'
import { htm as html } from '@kbot/ui/htm-bind'
import { DialogModal } from '@kbot/ui/dialog-modal'

// _state — singleton request bag.  Carries the initial values, the
// world preset options for the Unit Editor tab's environment picker,
// and the onApply / onCancel callbacks.  Null when not open.
const _state = signal(null)

// openSettingsDialog — host entry point.  Returns a Promise<boolean>
// resolved with `true` if the user clicked Apply, `false` otherwise.
// The actual settings payload is delivered to the host via opts.onApply
// at apply time so the host can integrate with its own state shape.
export function openSettingsDialog({
  initial = {},
  envOptions = [],
  defaultTab = 'general',
  onApply,
  onReset,
} = {}) {
  return new Promise((resolve) => {
    const prev = _state.value
    if (prev && typeof prev.resolve === 'function') prev.resolve(false)
    _state.value = {
      initial, envOptions, defaultTab, onApply, onReset,
      resolve: (ok) => {
        _state.value = null
        resolve(!!ok)
      },
    }
  })
}

export function closeSettingsDialog() {
  const cur = _state.value
  if (cur && typeof cur.resolve === 'function') cur.resolve(false)
  _state.value = null
}

// SettingsDialog — the visible component.  Renders nothing when no
// request is in flight.
export function SettingsDialog() {
  const req = _state.value
  if (!req) return null
  return html`<${_Body} req=${req} />`
}

// _Body — split out so the component re-mounts (and re-reads initial
// values into local state) whenever a fresh openSettingsDialog call
// lands with a new request.  Without this the form would stay frozen
// on the FIRST initial values across opens.
function _Body({ req }) {
  const [tab, setTab] = useState(req.defaultTab || 'general')
  const [vals, setVals] = useState(() => ({ ...req.initial }))
  useEffect(() => { setVals({ ...req.initial }); setTab(req.defaultTab || 'general') }, [req])
  const set = (key, v) => setVals((cur) => ({ ...cur, [key]: v }))
  const onCancel = () => req.resolve(false)
  const onApply = () => {
    if (typeof req.onApply === 'function') req.onApply(vals)
    req.resolve(true)
  }
  const onReset = () => {
    if (typeof req.onReset === 'function') {
      const next = req.onReset()
      if (next && typeof next === 'object') setVals(next)
    }
  }
  const actions = [
    { label: 'Reset',  onClick: onReset },
    { label: 'Cancel', onClick: onCancel },
    { label: 'Apply',  primary: true, onClick: onApply },
  ]
  return html`
    <${DialogModal} open=${true}
                    title="Settings"
                    cardClass="dialog-card-wide"
                    onCancel=${onCancel}
                    actions=${actions}
                    autofocusActionLabel="Apply">
      <div class="settings-tabs" role="tablist">
        <button class=${'settings-tab' + (tab === 'general' ? ' active' : '')}
                role="tab" aria-selected=${tab === 'general' ? 'true' : 'false'}
                onClick=${() => setTab('general')}>General</button>
        <button class=${'settings-tab' + (tab === 'map' ? ' active' : '')}
                role="tab" aria-selected=${tab === 'map' ? 'true' : 'false'}
                onClick=${() => setTab('map')}>Map Editor</button>
        <button class=${'settings-tab' + (tab === 'unit' ? ' active' : '')}
                role="tab" aria-selected=${tab === 'unit' ? 'true' : 'false'}
                onClick=${() => setTab('unit')}>Unit Editor</button>
      </div>
      ${tab === 'general' ? html`<${_GeneralTab} vals=${vals} set=${set} />` : null}
      ${tab === 'map' ? html`<${_MapTab} vals=${vals} set=${set} />` : null}
      ${tab === 'unit' ? html`<${_UnitTab} vals=${vals} set=${set} envOptions=${req.envOptions} />` : null}
    <//>
  `
}

function _NumberField({ label, value, onChange, min, max, step, help }) {
  return html`
    <label class="field">
      <span>${label}</span>
      <input type="number" value=${value} min=${min} max=${max} step=${step}
             onInput=${(e) => onChange(parseFloat(e.currentTarget.value))} />
      ${help ? html`<p class="field-help">${help}</p>` : null}
    </label>
  `
}

function _CheckRow({ label, checked, onChange }) {
  return html`
    <label class="checkbox-row">
      <input type="checkbox" checked=${!!checked}
             onChange=${(e) => onChange(e.currentTarget.checked)} />
      <span>${label}</span>
    </label>
  `
}

function _GeneralTab({ vals, set }) {
  return html`
    <div class="settings-tab-body active" data-settings-tab-body="general">
      <div class="settings-grid">
        <section class="settings-section">
          <h2>Heartbeat</h2>
          <${_NumberField} label="Idle poll interval (ms)"
                           value=${vals.heartbeatIdleMs ?? 5000}
                           min=${500} max=${60000} step=${500}
                           onChange=${(v) => set('heartbeatIdleMs', v)} />
          <${_NumberField} label="Reconnect retry interval (ms)"
                           value=${vals.heartbeatReconnectMs ?? 1000}
                           min=${200} max=${10000} step=${100}
                           onChange=${(v) => set('heartbeatReconnectMs', v)}
                           help="Once the studio loses contact with the kbot server, it polls more aggressively.  Both intervals take effect on the next tick." />
        </section>
      </div>
    </div>
  `
}

function _MapTab({ vals, set }) {
  return html`
    <div class="settings-tab-body active" data-settings-tab-body="map">
      <div class="settings-grid">
        <section class="settings-section">
          <h2>Zoom</h2>
          <${_NumberField} label="Zoom step (per +/− press)"
                           value=${vals.zoomStep ?? 1.25}
                           min=${1.05} max=${2} step=${0.05}
                           onChange=${(v) => set('zoomStep', v)}
                           help="Each click of the Zoom + or − button multiplies / divides the zoom by this factor.  Default 1.25." />
        </section>
        <section class="settings-section">
          <h2>Brush defaults</h2>
          <${_NumberField} label="Erase brush size (tiles)"
                           value=${vals.defaultEraseSize ?? 1}
                           min=${1} max=${16} step=${1}
                           onChange=${(v) => set('defaultEraseSize', v)} />
          <${_NumberField} label="Voids brush size (attr cells)"
                           value=${vals.defaultVoidsSize ?? 1}
                           min=${1} max=${32} step=${1}
                           onChange=${(v) => set('defaultVoidsSize', v)} />
          <${_NumberField} label="Heightmap brush radius (attr cells)"
                           value=${vals.defaultHmRadius ?? 4}
                           min=${1} max=${32} step=${1}
                           onChange=${(v) => set('defaultHmRadius', v)} />
          <${_NumberField} label="Heightmap brush strength"
                           value=${vals.defaultHmStrength ?? 4}
                           min=${1} max=${32} step=${1}
                           onChange=${(v) => set('defaultHmStrength', v)} />
        </section>
        <section class="settings-section">
          <h2>Panel visibility defaults</h2>
          <${_CheckRow} label="Minimap"          checked=${vals.showMinimap}        onChange=${(v) => set('showMinimap', v)} />
          <${_CheckRow} label="Camera & Cursor"  checked=${vals.showCameraInfo}     onChange=${(v) => set('showCameraInfo', v)} />
          <${_CheckRow} label="Gridlines"        checked=${vals.showGridlines}      onChange=${(v) => set('showGridlines', v)} />
          <${_CheckRow} label="Animate features" checked=${vals.animateFeatures}    onChange=${(v) => set('animateFeatures', v)} />
          <${_CheckRow} label="Show voids overlay"  checked=${vals.showVoids}     onChange=${(v) => set('showVoids', v)} />
          <${_CheckRow} label="Show contour lines"  checked=${vals.showContours}  onChange=${(v) => set('showContours', v)} />
          <${_CheckRow} label="Show buildable area" checked=${vals.showBuildable} onChange=${(v) => set('showBuildable', v)} />
          <${_CheckRow} label="Show features"       checked=${vals.showFeatures}  onChange=${(v) => set('showFeatures', v)} />
          <${_CheckRow} label="Show start positions" checked=${vals.showStartPositions} onChange=${(v) => set('showStartPositions', v)} />
        </section>
      </div>
    </div>
  `
}

function _UnitTab({ vals, set, envOptions }) {
  return html`
    <div class="settings-tab-body active" data-settings-tab-body="unit">
      <div class="settings-grid">
        <section class="settings-section">
          <h2>Defaults for new units</h2>
          <label class="field">
            <span>Environment preset</span>
            <select value=${vals.unitDefaultEnv ?? 'greenworld'}
                    onChange=${(e) => set('unitDefaultEnv', e.currentTarget.value)}>
              ${(envOptions && envOptions.length > 0)
                ? envOptions.map((o) => html`<option key=${o.key} value=${o.key}>${o.label || o.key}</option>`)
                : html`<option value="greenworld">greenworld</option>`}
            </select>
          </label>
          <${_CheckRow} label="Reflections"               checked=${vals.unitDefaultReflections !== false}      onChange=${(v) => set('unitDefaultReflections', v)} />
          <${_CheckRow} label="Bobbing / Swaying"         checked=${vals.unitDefaultBob !== false}              onChange=${(v) => set('unitDefaultBob', v)} />
          <${_CheckRow} label="Water reflections on hull" checked=${vals.unitDefaultWaterReflections !== false} onChange=${(v) => set('unitDefaultWaterReflections', v)} />
          <${_CheckRow} label="Specular highlights"       checked=${vals.unitDefaultSpecular !== false}         onChange=${(v) => set('unitDefaultSpecular', v)} />
          <${_CheckRow} label="God beams"                 checked=${vals.unitDefaultGodBeams !== false}         onChange=${(v) => set('unitDefaultGodBeams', v)} />
        </section>
        <section class="settings-section">
          <h2>Gestures</h2>
          <${_CheckRow} label="Shift-click ground forces target (Sandbox)"
                        checked=${vals.forceTargetGround}
                        onChange=${(v) => set('forceTargetGround', v)} />
          <p class="field-help">When off, shift-click selects instead of force-targeting.  Lives in localStorage so it persists per browser.</p>
        </section>
      </div>
    </div>
  `
}
