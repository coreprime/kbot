// movement-panel.js
//
// Per-unit movement telemetry overlay — like the cockpit dashboard of a
// car or aircraft.  Shows
//   * Speed (current / max / acceleration ramp)
//   * Heading dial — top-down compass with a needle on the unit's yaw
//                    and a "bearing" tick for the move/attack target.
//   * Attitude indicator — cockpit-style artificial horizon for pitch +
//                          yaw (mostly informative for aircraft).
//   * Movement Phase — Idle / Moving toward / Attack ▸ approach |
//                      egress | strafe / Bombing the line.
//
// Multi-unit / no-unit selection matches the Unit Ports panel: the empty
// state mirrors that panel's wording so the read-only inspectors feel
// uniform.  Body subscribes to runtimeTick so the dials redraw on every
// refresh-tick publish (4 Hz).

import { htm as html } from '/ui/common/htm-bind.js'
import { FloatingPanel } from '/ui/common/floating-panel.js'
import { panelSignals, registerPanel } from '/ui/common/panel-store.js'
import { mv, sandboxActive, sandboxSelSize, runtimeTick } from '/ui/common/inspector-store.js'

const PANEL_ID = 'mv-inspector-movement'

// Default closed — the dials are visual and best opened when the user
// actively wants to watch a unit's flight envelope.  Pre-register so the
// FIRST visibility read returns false; persistence wins on later loads.
registerPanel(PANEL_ID, { defaultVisible: false })

// emptyMessage — same pattern as Unit Ports.  Returns null when there's
// a single focused unit with motion data, otherwise the message to show.
function emptyMessage() {
  const motion = mv.value && mv.value.unitMotion
  if (motion) return null
  if (sandboxActive.value) {
    return sandboxSelSize.value > 1
      ? 'Multiple units selected, movement unavailable.'
      : 'No Unit Selected'
  }
  return 'No COB loaded.'
}

// ── Visual helpers ─────────────────────────────────────────────────

// Compass dial.  Top-down view, north is +Z away from camera, east is
// +X.  The unit's heading needle is the bold one; an optional dotted
// bearing tick shows the direction of the active move/attack target so
// the user sees how far off the unit currently is.
function CompassDial({ headingDeg, bearingDeg }) {
  // SVG coordinate frame: y grows DOWN, so a heading of 0° (toward +Z
  // away from camera) renders as a needle pointing UP from the centre.
  // x grows right and matches the world +X axis directly.
  const cx = 48, cy = 48, r = 36
  const cardinals = [
    { label: 'N', deg: 0   },
    { label: 'E', deg: 90  },
    { label: 'S', deg: 180 },
    { label: 'W', deg: 270 },
  ]
  // Needle endpoint at the heading angle.  -90° rotation aligns 0° with
  // "up" in screen space; then sin/cos give the SVG-space delta.
  const rad = (deg) => (deg - 90) * Math.PI / 180
  const needleEnd = (deg, len) => {
    const a = rad(deg)
    return { x: cx + Math.cos(a) * len, y: cy + Math.sin(a) * len }
  }
  // Heading reads forward = +Z at angle 0 = SVG-up.  Our world heading
  // is atan2(sin h, cos h) measured CW from +Z (north), so heading 0 =
  // forward toward camera away.  +π/2 = +X (east).  SVG rotation needs
  // the same convention — we pass headingDeg straight in.
  const ne = needleEnd(headingDeg, r - 4)
  const tickEnd = bearingDeg == null ? null : needleEnd(bearingDeg, r - 6)
  return html`
    <svg class="mv-mov-dial" viewBox="0 0 96 96" width="96" height="96"
         title=${`Heading: ${headingDeg.toFixed(0)}° ${bearingDeg != null ? `· Bearing: ${bearingDeg.toFixed(0)}°` : ''}`}>
      <circle cx=${cx} cy=${cy} r=${r}
              fill="none" stroke="#3a3" stroke-width="1.5" />
      <!-- inner ring -->
      <circle cx=${cx} cy=${cy} r=${r - 8}
              fill="none" stroke="#2a4a2a" stroke-width="0.5" />
      <!-- cardinal labels -->
      ${cardinals.map((c) => {
        const p = needleEnd(c.deg, r + 4)
        return html`
          <text x=${p.x} y=${p.y + 4} text-anchor="middle"
                font-size="9" fill="#9c9" font-family="monospace">${c.label}</text>
        `
      })}
      <!-- target bearing tick (dotted line) -->
      ${tickEnd ? html`
        <line x1=${cx} y1=${cy} x2=${tickEnd.x} y2=${tickEnd.y}
              stroke="#ffb84a" stroke-width="1.5" stroke-dasharray="3 2" />
      ` : null}
      <!-- heading needle -->
      <line x1=${cx} y1=${cy} x2=${ne.x} y2=${ne.y}
            stroke="#7f7" stroke-width="2.2" stroke-linecap="round" />
      <circle cx=${cx} cy=${cy} r="2.5" fill="#7f7" />
    </svg>
  `
}

// Attitude indicator.  Two-tone horizon — sky above (blue) / ground
// below (brown) — rolls and pitches under a fixed centre marker.  Pitch
// is the offset of the horizon line away from centre; yaw is rendered
// as a bottom tick mark + numeric readout so the user has both axes in
// one widget.
function AttitudeIndicator({ pitchDeg, headingDeg }) {
  // Clamp pitch for display so a falling bomb (-90°) doesn't shove the
  // horizon off the gauge.  ±60° covers most realistic aircraft pitches.
  const p = Math.max(-60, Math.min(60, pitchDeg || 0))
  // Each degree of pitch moves the horizon by ~0.7 px so ±60° → ±42 px.
  const offset = p * 0.7
  // Compass rose at the bottom for yaw — show ±45° around the current
  // heading.  Ticks every 15°, label every 45°.
  const sweep = []
  for (let d = -45; d <= 45; d += 15) {
    const xx = 48 + d * 0.8  // 0.8 px per degree
    sweep.push({ x: xx, deg: ((headingDeg + d) % 360 + 360) % 360, big: d % 45 === 0 })
  }
  return html`
    <svg class="mv-mov-attitude" viewBox="0 0 96 96" width="96" height="96"
         title=${`Pitch: ${pitchDeg.toFixed(0)}° · Yaw: ${headingDeg.toFixed(0)}°`}>
      <!-- clip the moving horizon to a circular instrument face -->
      <defs>
        <clipPath id="att-clip">
          <circle cx="48" cy="48" r="34" />
        </clipPath>
      </defs>
      <g clip-path="url(#att-clip)">
        <!-- sky -->
        <rect x="0" y=${0} width="96" height=${48 + offset} fill="#3a78b8" />
        <!-- ground -->
        <rect x="0" y=${48 + offset} width="96" height=${48 - offset} fill="#7a5a30" />
        <!-- horizon line -->
        <line x1="14" y1=${48 + offset} x2="82" y2=${48 + offset}
              stroke="#fff" stroke-width="1" />
        <!-- pitch ladder marks every 10° -->
        ${[-20, -10, 10, 20].map((d) => {
          const yy = 48 + (offset - d * 0.7)
          const w = d % 20 === 0 ? 22 : 14
          return html`
            <line x1=${48 - w / 2} y1=${yy} x2=${48 + w / 2} y2=${yy}
                  stroke="#fff" stroke-width="0.8" opacity="0.7" />
          `
        })}
      </g>
      <!-- instrument bezel -->
      <circle cx="48" cy="48" r="34" fill="none" stroke="#3a3" stroke-width="1.5" />
      <!-- centre fixed marker (the aircraft) -->
      <line x1="36" y1="48" x2="44" y2="48" stroke="#ffb84a" stroke-width="2" />
      <line x1="52" y1="48" x2="60" y2="48" stroke="#ffb84a" stroke-width="2" />
      <circle cx="48" cy="48" r="1.5" fill="#ffb84a" />
      <!-- yaw rose bottom tick + numeric -->
      <g>
        ${sweep.map((t) => html`
          <line x1=${t.x} y1=${82} x2=${t.x} y2=${t.big ? 86 : 84.5}
                stroke="#9c9" stroke-width="0.8" />
        `)}
        <text x="48" y="93" text-anchor="middle" font-size="8" fill="#9c9"
              font-family="monospace">${headingDeg.toFixed(0)}°</text>
      </g>
    </svg>
  `
}

function _phaseLabel(motion) {
  if (motion.atkPhase) {
    const s = motion.atkPhase
    // Friendly capitalisation per phase.
    if (s === 'approach') return 'Attack ▸ Approach'
    if (s === 'egress')   return 'Attack ▸ Egress'
    if (s === 'strafe')   return 'Attack ▸ Strafe'
    return `Attack ▸ ${s}`
  }
  if (motion.bombRunBombsLeft > 0) {
    return `Bomb run ▸ ${motion.bombRunBombsLeft} bomb${motion.bombRunBombsLeft === 1 ? '' : 's'} left`
  }
  if (motion.attackTarget && motion.attackTarget.name) {
    return `Chasing ${motion.attackTarget.name} #${motion.attackTarget.id}`
  }
  if (motion.moveTarget) return 'Moving to waypoint'
  if (motion.isMoving)   return 'Moving'
  return 'Idle'
}

// ── Body ────────────────────────────────────────────────────────────

function MovementBody() {
  const { visible } = panelSignals(PANEL_ID)
  void runtimeTick.value
  if (!visible.value) return null
  const msg = emptyMessage()
  if (msg !== null) {
    return html`<div class="mv-inspector-empty">${msg}</div>`
  }
  const m = mv.value.unitMotion
  const speed = m.speed
  const maxSpeed = m.maxSpeed
  const accel = m.accelerationWUPerSec2
  const headingDeg = ((m.headingDeg % 360) + 360) % 360
  const bearingDeg = m.bearingDeg == null ? null : ((m.bearingDeg % 360) + 360) % 360
  const pitchDeg = m.pitchDeg || 0
  const speedPctWidth = maxSpeed > 0
    ? Math.max(0, Math.min(100, (speed / maxSpeed) * 100))
    : 0
  return html`
    <div class="mv-mov-rows">
      <div class="mv-mov-row">
        <span class="mv-mov-row-label">Speed</span>
        <span class="mv-mov-row-val">${speed.toFixed(1)}<span class="mv-mov-row-unit"> wu/s</span></span>
      </div>
      <div class="mv-mov-speed-bar" title="Current speed vs. FBI MaxVelocity">
        <div class="mv-mov-speed-fill" style=${`width: ${speedPctWidth}%`}></div>
      </div>
      <div class="mv-mov-row">
        <span class="mv-mov-row-label">Top speed</span>
        <span class="mv-mov-row-val">${maxSpeed.toFixed(1)}<span class="mv-mov-row-unit"> wu/s</span></span>
      </div>
      <div class="mv-mov-row">
        <span class="mv-mov-row-label">Acceleration</span>
        <span class="mv-mov-row-val">${accel.toFixed(1)}<span class="mv-mov-row-unit"> wu/s²</span></span>
      </div>
      <div class="mv-mov-row">
        <span class="mv-mov-row-label">Phase</span>
        <span class="mv-mov-row-val mv-mov-phase">${_phaseLabel(m)}</span>
      </div>
    </div>
    <div class="mv-mov-dials">
      <div class="mv-mov-dial-wrap">
        <${CompassDial} headingDeg=${headingDeg} bearingDeg=${bearingDeg} />
        <div class="mv-mov-dial-caption">Heading</div>
      </div>
      <div class="mv-mov-dial-wrap">
        <${AttitudeIndicator} pitchDeg=${pitchDeg} headingDeg=${headingDeg} />
        <div class="mv-mov-dial-caption">Attitude</div>
      </div>
    </div>
  `
}

export function MovementPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Movement">
      <${MovementBody} />
    <//>
  `
}
