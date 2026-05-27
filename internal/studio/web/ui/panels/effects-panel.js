// effects-panel.js
//
// React-rendered Effects overlay — live inspector of the COB
// particle pool.  Shape mirrors the legacy vanilla renderer so the
// existing CSS in studio.css applies unchanged:
//
//   1. Per-kind chip strip — projectile chips first, SFX after.
//   2. Two collapsible sections (Projectiles & beams, Other effects)
//      capped at SECTION_CAP cards each.  "+N more…" footer when the
//      live count exceeds the cap so the user sees the overflow.
//   3. Each card: colour swatch + kind label, pos / dir / spd / life
//      stat grid, life fraction bar.
//
// Section collapse state lives in a local signal so a toggle takes
// effect on the next render without waiting for the host's throttled
// refresh tick to re-publish.

import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'
import { FloatingPanel } from '/ui/common/floating-panel.js'
import { panelSignals } from '/ui/common/panel-store.js'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'

const PANEL_ID = 'mv-inspector-effects'

// Friendly names for the particle kind ids (1-byte codes the COB
// particle pool emits).  Kept inline so the component is self-
// contained; missing ids fall back to "K{n}" which still reads
// in the live panel.
const KIND_NAMES = {
  1: 'SMOKE_GREY', 2: 'SMOKE_WHITE', 3: 'SPARK', 4: 'FIRE_FLASH',
  16: 'NANO', 257: 'WAKE',
  200: 'BULLET', 201: 'SHELL', 202: 'PLASMA',
  203: 'DGUN', 204: 'LASER', 205: 'MISSILE',
}
const SECTION_CAP = 60
const isProjectile = (k) => k >= 200 && k <= 299

// Local section-collapse signal.  Module-scoped so the state
// survives mount/unmount cycles (e.g. when the panel is hidden +
// re-shown via the View menu).  Storing labels in a Set keeps the
// "collapsed-by-default-no, expanded-by-default-yes" semantics
// without per-section signals.
const _collapsedSections = signal(new Set())

function _toggleSection(label) {
  const next = new Set(_collapsedSections.value)
  if (next.has(label)) next.delete(label)
  else next.add(label)
  _collapsedSections.value = next
}

function ParticleCard({ pool, slot: i }) {
  const k = pool.kind[i] | 0
  const sr = Math.max(0, Math.min(255, Math.round(pool.r[i] * 127)))
  const sg = Math.max(0, Math.min(255, Math.round(pool.g[i] * 127)))
  const sb = Math.max(0, Math.min(255, Math.round(pool.b[i] * 127)))
  const vx = pool.vx[i], vy = pool.vy[i], vz = pool.vz[i]
  const speed = Math.hypot(vx, vy, vz)
  const dirText = speed > 0.001
    ? `${(vx / speed).toFixed(2)}, ${(vy / speed).toFixed(2)}, ${(vz / speed).toFixed(2)}`
    : '—'
  const lifeFrac = pool.life0[i] > 0 ? (pool.life[i] / pool.life0[i]) : 0
  const lifePct = Math.max(0, Math.min(1, lifeFrac)) * 100
  const kindName = KIND_NAMES[k] || ('K' + k)
  return html`
    <div class="mv-fx-card">
      <div class="mv-fx-card-head">
        <span class="mv-fx-swatch" style=${`background: rgb(${sr},${sg},${sb})`}></span>
        <span class="mv-fx-card-kind">${kindName}</span>
      </div>
      <div class="mv-fx-card-stats">
        <div class="mv-fx-stat">
          <span class="k">pos</span>
          <span class="v">${pool.x[i].toFixed(0)}, ${pool.y[i].toFixed(0)}, ${pool.z[i].toFixed(0)}</span>
        </div>
        <div class="mv-fx-stat">
          <span class="k">dir</span>
          <span class="v">${dirText}</span>
        </div>
        <div class="mv-fx-stat">
          <span class="k">spd</span>
          <span class="v">${speed.toFixed(0)} wu/s</span>
        </div>
        <div class="mv-fx-stat">
          <span class="k">life</span>
          <span class="v">${(pool.life[i] / 1000).toFixed(2)}s / ${(pool.life0[i] / 1000).toFixed(1)}s</span>
        </div>
      </div>
      <div class="mv-fx-life-bar">
        <div class="mv-fx-life-fill" style=${`width: ${lifePct}%`}></div>
      </div>
    </div>
  `
}

function Section({ label, pool, slots }) {
  if (slots.length === 0) return null
  const collapsed = _collapsedSections.value.has(label)
  const shown = Math.min(slots.length, SECTION_CAP)
  return html`
    <div class="mv-fx-section" onClick=${() => _toggleSection(label)}>
      <span class="mv-fx-chev">${collapsed ? '▸' : '▾'}</span>
      <span>${label} (${slots.length})</span>
    </div>
    ${collapsed ? null : html`
      <div class="mv-fx-cards">
        ${slots.slice(0, shown).map((i) => html`
          <${ParticleCard} pool=${pool} slot=${i} key=${i} />
        `)}
      </div>
      ${slots.length > shown ? html`
        <div class="mv-fx-more">+${slots.length - shown} more…</div>
      ` : null}
    `}
  `
}

function EffectsBody() {
  const { visible } = panelSignals(PANEL_ID)
  // Subscribe to runtimeTick so per-publish refresh re-walks the
  // particle pool — in unit-editor mode mv.value is the stable
  // modelViewerInstance reference so without this read the body
  // would never re-render when particles enter / leave the pool.
  void runtimeTick.value
  if (!visible.value) return null
  const proxy = mv.value
  const pool = proxy && proxy.cob && proxy.cob.particles
  if (!pool) {
    return html`<div class="mv-inspector-empty">No particle pool.</div>`
  }
  if (pool.count === 0) {
    return html`<div class="mv-inspector-empty">No particles in flight.</div>`
  }
  // Per-kind tally + section bucketing.  Walking the alive flags
  // twice (count + bucket) is fine — pool.count caps at the SFX
  // budget the engine sets, low enough that the second pass is
  // negligible vs the DOM rebuild it feeds.
  const counts = new Map()
  const projSlots = []
  const fxSlots = []
  for (let i = 0; i < pool.count; i++) {
    if (!pool.alive[i]) continue
    const k = pool.kind[i] | 0
    counts.set(k, (counts.get(k) || 0) + 1)
    if (isProjectile(k)) projSlots.push(i)
    else fxSlots.push(i)
  }
  const chipEntries = [...counts.entries()].sort((a, b) => {
    const aProj = isProjectile(a[0]) ? 0 : 1
    const bProj = isProjectile(b[0]) ? 0 : 1
    return aProj - bProj || b[1] - a[1]
  })
  return html`
    <div class="mv-fx-chips">
      ${chipEntries.map(([k, n]) => html`
        <span class=${isProjectile(k) ? 'mv-fx-chip mv-fx-chip-proj' : 'mv-fx-chip'} key=${k}>
          ${KIND_NAMES[k] || ('K' + k)} ×${n}
        </span>
      `)}
    </div>
    <${Section} label="Projectiles & beams" pool=${pool} slots=${projSlots} />
    <${Section} label="Other effects"       pool=${pool} slots=${fxSlots} />
  `
}

export function EffectsPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Effects">
      <${EffectsBody} />
    <//>
  `
}
