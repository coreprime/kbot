// renderer-panel.js
//
// React-rendered Renderer overlay (historically the Camera panel —
// DOM id is mv-inspector-camera so saved layout positions don't get
// orphaned; user-facing label has always been "Renderer").  Surfaces
// the orbit camera pose, the WebGL frame rate, and two toggles for
// Tracking + Auto-Rotate that route through the host bridge into
// whichever view (sandbox or unit editor) currently owns the canvas.
//
// Subscribes to runtimeTick so per-tick live values (FPS, camera
// yaw/pitch as they animate, tracking changes from a T-key press)
// re-render in step with the rest of the inspector suite.

import { htm as html } from '/ui/common/htm-bind.js'
import { FloatingPanel } from '/ui/common/floating-panel.js'
import { panelSignals } from '/ui/common/panel-store.js'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'
import { hostBridge } from '/ui/common/host-bridge.js'

const PANEL_ID = 'mv-inspector-camera'

const fmtVec = (a, p = 1) => Array.isArray(a)
  ? `(${a.map((v) => v.toFixed(p)).join(', ')})`
  : (a == null ? '—' : a.toFixed(p))
const fmtDeg = (rad) => `${(rad * 180 / Math.PI).toFixed(1)}°`

// Read the live tracking state straight off the camera (the camera
// is the single source of truth that both view types maintain).
// The render isn't subscribed to camera.trackedTarget changes
// directly — runtimeTick is what makes us re-read each publish.
function _liveTracking(proxy) {
  const cam = proxy && proxy.camera
  return !!(cam && cam.trackedTarget)
}

function _liveAutoRotate(proxy) {
  const r = proxy && proxy.renderer
  return !!(r && r.autoRotate)
}

function Row({ label, value, title }) {
  return html`
    <div class="dev-stats-row" title=${title || ''}>
      <span class="dev-stats-label">${label}</span>
      <span class="dev-stats-value">${value}</span>
    </div>
  `
}

function ToggleRow({ label, checked, title, onChange }) {
  return html`
    <label class="dev-stats-row mv-ci-track-row" title=${title || ''}>
      <span class="dev-stats-label">${label}</span>
      <input type="checkbox" class="mv-ci-track-cb"
             checked=${checked}
             onChange=${(e) => onChange(e.currentTarget.checked)}
             onPointerDown=${(e) => e.stopPropagation()}
             onMouseDown=${(e) => e.stopPropagation()} />
    </label>
  `
}

function RendererBody() {
  const { visible } = panelSignals(PANEL_ID)
  // Tick read — re-renders every publish so the live values stay
  // fresh.  The void-ref pattern keeps the linter happy about
  // "computed but unused" while still subscribing.
  void runtimeTick.value
  if (!visible.value) return null
  const proxy = mv.value
  const cam = proxy && proxy.camera
  if (!cam) {
    return html`<div class="mv-inspector-empty">No camera available.</div>`
  }
  const r = proxy.renderer
  const fps = (r && typeof r.getFPS === 'function') ? r.getFPS() : 0
  const fpsText = fps > 0 ? `${fps.toFixed(0)} fps` : '—'
  const fovText = (cam.fov !== undefined) ? `${(cam.fov * 180 / Math.PI).toFixed(0)}°` : '—'
  const tracking = _liveTracking(proxy)
  const autoRotate = _liveAutoRotate(proxy)
  return html`
    <${Row} label="FPS" value=${fpsText}
           title="Smoothed frames-per-second sampled from the WebGL render loop.  Excludes paused or background-tab frames." />
    <${Row} label="Position" value=${fmtVec(cam.eye)} />
    <${Row} label="Target"   value=${fmtVec(cam.target)} />
    <${Row} label="Yaw"      value=${fmtDeg(cam.yaw)} />
    <${Row} label="Pitch"    value=${fmtDeg(cam.pitch)} />
    <${Row} label="Distance" value=${`${cam.distance.toFixed(1)} wu`} />
    <${Row} label="FOV"      value=${fovText} />
    <${ToggleRow} label="Auto-Rotate" checked=${autoRotate}
                 title="Spin the camera around the scene.  Stops automatically on any user gesture (drag, wheel, pan)."
                 onChange=${(on) => hostBridge.setAutoRotate(on)} />
    <${ToggleRow} label="Tracking" checked=${tracking}
                 title="Track the unit's position with the camera.  Toggle with the T key.  Shift-pan clears this automatically."
                 onChange=${(on) => hostBridge.setTracking(on)} />
    ${tracking ? html`
      <${Row} label="Following" value=${cam.trackedName || 'Unit'} />
    ` : null}
  `
}

export function RendererPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Renderer">
      <${RendererBody} />
    <//>
  `
}
