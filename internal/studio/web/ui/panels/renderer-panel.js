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
//
// Layout: rows are grouped into two AccordionSections — "Camera"
// (open by default; pose / FOV / tracking) and "Advanced" (closed
// by default; cull + LOD diagnostics and their toggles).  The live
// FPS reading sits in the panel header (right of the title) so the
// frame-rate stays visible even when both accordions are collapsed.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { FloatingPanel } from '@coreprime/kbot-ui/floating-panel'
import { AccordionSection } from '@coreprime/kbot-ui/accordion-section'
import { panelSignals } from '@coreprime/kbot-ui/panel-store'
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

// RendererFpsChip renders the live FPS readout that lives in the
// panel header.  Kept as its own component so the body's tick-driven
// re-render doesn't depend on the chip being present — and so the
// chip can re-render in step with the runtime without forcing the
// whole panel through the body's render tree.
function RendererFpsChip() {
  void runtimeTick.value
  const proxy = mv.value
  const r = proxy && proxy.renderer
  const fps = (r && typeof r.getFPS === 'function') ? r.getFPS() : 0
  const text = fps > 0 ? `${fps.toFixed(0)} fps` : '—'
  return html`<span class="mv-panel-fps-chip"
                    title="Smoothed frames-per-second sampled from the WebGL render loop.  Excludes paused or background-tab frames.">${text}</span>`
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
  const fovText = (cam.fov !== undefined) ? `${(cam.fov * 180 / Math.PI).toFixed(0)}°` : '—'
  const tracking = _liveTracking(proxy)
  const autoRotate = _liveAutoRotate(proxy)
  // Frustum-cull statistics — live read off the renderer's _cullStats
  // counters reset every draw().  `drew / culled / total` reads through
  // as e.g. "12 / 38 / 50" so the user can see at a glance how many
  // entities the camera frustum eliminated this frame.  Empty when no
  // multi-entity scene is active (unit editor: total=0, drew=0).
  const cullStats = (r && typeof r.getCullStats === 'function') ? r.getCullStats() : null
  const cullText = (cullStats && cullStats.total > 0)
    ? `${cullStats.drew} / ${cullStats.culled} / ${cullStats.total}`
    : '—'
  const cullEnabled = !!(r && r.cullEnabled)
  const shadowText = (cullStats && cullStats.total > 0)
    ? `${cullStats.shadowed} / ${cullStats.total}`
    : '—'
  const shadowLodEnabled = !!(r && r.shadowLodEnabled)
  // Phase 2 LOD distribution — "full / mid / far" entity counts this
  // frame.  Sum equals `drew` (only un-culled entities pick a tier).
  // At default unit-editor framing all entities sit in Full; zoom out
  // in a sandbox to watch the breakdown shift to Mid then Far.
  const lodText = (cullStats && cullStats.total > 0)
    ? `${cullStats.full} / ${cullStats.mid} / ${cullStats.far}`
    : '—'
  const lodEnabled = !!(r && r.lodEnabled)
  return html`
    <${AccordionSection} id="renderer-camera" title="Camera" defaultOpen=${true}>
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
    <//>
    <${AccordionSection} id="renderer-advanced" title="Advanced">
      <${Row} label="Cull" value=${cullText}
             title="Frustum cull breakdown — drew / culled / total entities this frame.  Higher 'culled' means more units fell outside the camera frustum and skipped their draw calls." />
      <${Row} label="Shadows" value=${shadowText}
             title="Shadow-LOD breakdown — entities that cast a shadow this frame / total entities.  As you zoom out, distant units drop their shadows to save the shadow pass." />
      <${Row} label="LOD" value=${lodText}
             title="LOD-tier breakdown — full / mid / far entities this frame.  Mid drops cosmetic flare/muzzle pieces; far collapses to a single impostor sprite.  Sum equals the entities that survived the frustum cull." />
      <${ToggleRow} label="Frustum cull" checked=${cullEnabled}
                   title="Skip entities outside the camera frustum.  Off → render every spawned unit regardless (for A/B verification)."
                   onChange=${(on) => { if (r && typeof r.setCullEnabled === 'function') r.setCullEnabled(on) }} />
      <${ToggleRow} label="Shadow LOD" checked=${shadowLodEnabled}
                   title="Hide shadows for distant units.  When on, units smaller than ~40 px on screen skip the shadow pass — saves the GPU one full geometry walk per far-away unit."
                   onChange=${(on) => { if (r && typeof r.setShadowLodEnabled === 'function') r.setShadowLodEnabled(on) }} />
      <${ToggleRow} label="Detail LOD" checked=${lodEnabled}
                   title="Hide cosmetic detail (flares, muzzles, exhausts) on distant units.  Off → every entity renders every piece regardless of zoom level (A/B verification)."
                   onChange=${(on) => { if (r && typeof r.setLodEnabled === 'function') r.setLodEnabled(on) }} />
    <//>
  `
}

export function RendererPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Renderer"
                     className="mv-renderer-panel"
                     headerExtras=${html`<${RendererFpsChip} />`}>
      <${RendererBody} />
    <//>
  `
}
