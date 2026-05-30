// projectiles-panel.js
//
// React-rendered Projectiles overlay — live inspector of every in-flight
// model projectile (bombs / missiles / rockets / unclassified shells) the
// engine is simulating.  Two grouping modes:
//
//   * Family  — collapse by family (Missiles, Rockets, Bombs, Other).
//   * Owner   — collapse by the unit that launched it (one section per
//               owning unit), so you can see at a glance how many shots a
//               single unit has in the air.
//
// The accordion mechanic + section-collapse signal + count tag mirrors the
// Runtime panel's per-unit headers, so the two read as siblings when both
// are open at once.  Sectioning lives in module-scoped signals (group
// mode + collapsed-section ids) so the user's choices survive a panel
// close + reopen via the View menu.
//
// Shared between the Sandbox developer menu and the Unit-Editor View
// menu — both wrap their cob proxy through view-helpers.js's
// wrapCobWithAggregate(), which populates proxy.projectiles via the
// view's aggregateProjectiles().  The panel only reads off that proxy.

import { signal } from '@preact/signals'
import { htm as html } from '/ui/common/htm-bind.js'
import { FloatingPanel } from '/ui/common/floating-panel.js'
import { panelSignals } from '/ui/common/panel-store.js'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'
import { displayRgbForSide } from '/game3d/team-colors.js'

const PANEL_ID = 'mv-inspector-projectiles'

// Group-by mode — 'family' (default) buckets projectiles into Missiles /
// Rockets / Bombs / Other, 'owner' buckets them by the unit that launched.
// Module-scoped so the choice persists across panel-close cycles.
const _groupMode = signal('family')
const _collapsedSections = signal(new Set())

function _toggleSection(key) {
  const next = new Set(_collapsedSections.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  _collapsedSections.value = next
}

// Per-family icon + label — matches the projectile.mode strings the engine
// stamps on each record in projectiles.js.  Any unrecognised mode falls
// into the 'other' bucket so the user still sees a count instead of the
// projectile vanishing from the panel.
const _FAMILY_DEFS = {
  bomb:    { id: 'bomb',    label: 'Bombs',    icon: '💣' },
  missile: { id: 'missile', label: 'Missiles', icon: '🚀' },
  rocket:  { id: 'rocket',  label: 'Rockets',  icon: '🎆' },
  other:   { id: 'other',   label: 'Other Projectiles', icon: '◦' },
}

// Family resolver — maps the engine's mode tag into one of the four
// inspector buckets.  Bombs are gravity-released; missiles are anything
// that homes (guided or vlaunch); rockets are an unguided powered shot
// (the engine's 'straight' mode); ballistic shells + anything else land
// in Other so the panel never silently drops a row.
function _familyOf(mode) {
  switch (mode) {
    case 'dropped':                          return _FAMILY_DEFS.bomb
    case 'guided':  case 'vlaunch':          return _FAMILY_DEFS.missile
    case 'straight':                         return _FAMILY_DEFS.rocket
    default:                                 return _FAMILY_DEFS.other
  }
}

// Side colour swatch — looks up the same team palette tuple the renderer
// uses, scaled into a 0..255 CSS rgb() so the swatch reads at a glance.
// Renders an empty placeholder for ownerless projectiles (shouldn't
// normally happen — every projectile has an ownerId — but the panel
// guards anyway).
function _sideSwatch(side) {
  const t = displayRgbForSide(side | 0)
  if (!t) return null
  const r = Math.round(t[0] * 255)
  const g = Math.round(t[1] * 255)
  const b = Math.round(t[2] * 255)
  return html`<span class="mv-fx-swatch" style=${`background: rgb(${r},${g},${b})`}></span>`
}

// ── Card ────────────────────────────────────────────────────────────

function ProjectileCard({ proj }) {
  const fam = _familyOf(proj.mode)
  const ownerName = proj.owner ? `${proj.owner.name || 'Unit'} #${proj.owner.id}` : '—'
  const dest = proj.liveTarget || proj.destination
  const lifeFrac = proj.lifeSec > 0 ? Math.max(0, Math.min(1, proj.ageSec / proj.lifeSec)) : 0
  const lifePct  = lifeFrac * 100
  const wpn = proj.weaponName || '—'
  return html`
    <div class="mv-fx-card">
      <div class="mv-fx-card-head">
        ${proj.owner ? _sideSwatch(proj.owner.side) : null}
        <span class="mv-fx-card-kind">${fam.icon} ${wpn}</span>
      </div>
      <div class="mv-fx-card-stats">
        <div class="mv-fx-stat">
          <span class="k">owner</span>
          <span class="v">${ownerName}</span>
        </div>
        <div class="mv-fx-stat">
          <span class="k">from</span>
          <span class="v">${proj.origin.x.toFixed(0)}, ${proj.origin.y.toFixed(0)}, ${proj.origin.z.toFixed(0)}</span>
        </div>
        <div class="mv-fx-stat">
          <span class="k">to</span>
          <span class="v">${dest.x.toFixed(0)}, ${dest.y.toFixed(0)}, ${dest.z.toFixed(0)}</span>
        </div>
        <div class="mv-fx-stat">
          <span class="k">at</span>
          <span class="v">${proj.pos.x.toFixed(0)}, ${proj.pos.y.toFixed(0)}, ${proj.pos.z.toFixed(0)}</span>
        </div>
        <div class="mv-fx-stat">
          <span class="k">spd</span>
          <span class="v">${proj.speed.toFixed(0)} wu/s</span>
        </div>
      </div>
      <div class="mv-fx-life-bar" title=${`Flight time elapsed: ${proj.ageSec.toFixed(2)}s / ${proj.lifeSec.toFixed(1)}s`}>
        <div class="mv-fx-life-fill" style=${`width: ${lifePct}%`}></div>
      </div>
    </div>
  `
}

// ── Section ─────────────────────────────────────────────────────────

function Section({ sectionKey, label, icon, items }) {
  const collapsed = _collapsedSections.value.has(sectionKey)
  return html`
    <div class="mv-fx-section" onClick=${() => _toggleSection(sectionKey)}>
      <span class="mv-fx-chev">${collapsed ? '▸' : '▾'}</span>
      <span>${icon ? `${icon} ` : ''}${label} (${items.length})</span>
    </div>
    ${collapsed ? null : html`
      <div class="mv-fx-cards">
        ${items.map((proj) => html`
          <${ProjectileCard} proj=${proj} key=${proj.id} />
        `)}
      </div>
    `}
  `
}

// ── Group-mode picker (chip strip) ──────────────────────────────────

function GroupModePicker() {
  const cur = _groupMode.value
  const choose = (mode) => () => { _groupMode.value = mode }
  return html`
    <div class="mv-fx-section mv-fx-section-tabs" style="cursor: default;">
      <span class="mv-fx-mode-label">Group by</span>
      <button class=${cur === 'family' ? 'mv-fx-mode-tab on' : 'mv-fx-mode-tab'}
              title="Group projectiles by family — Missiles, Rockets, Bombs, Other."
              onClick=${choose('family')}>Family</button>
      <button class=${cur === 'owner' ? 'mv-fx-mode-tab on' : 'mv-fx-mode-tab'}
              title="Group projectiles by the unit that launched them."
              onClick=${choose('owner')}>Owner</button>
    </div>
  `
}

// ── Body ────────────────────────────────────────────────────────────

function ProjectilesBody() {
  const { visible } = panelSignals(PANEL_ID)
  // Subscribe to runtimeTick so the body re-walks the live projectile list
  // every publish — the proxy's `projectiles` field is a snapshot taken at
  // the previous tick by the host (refresh-tick.js), so this read makes
  // sure we re-render the moment the snapshot is refreshed.
  void runtimeTick.value
  if (!visible.value) return null
  // The projectile snapshot lives on the wrapped cob proxy (set by
  // wrapCobWithAggregate in view-helpers.js), so the read path is
  // mv.cob.projectiles — same shape the Effects panel uses for
  // mv.cob.particles.
  const proxy = mv.value
  const cob = proxy && proxy.cob
  const list = (cob && Array.isArray(cob.projectiles)) ? cob.projectiles : []
  if (list.length === 0) {
    return html`
      <${GroupModePicker} />
      <div class="mv-inspector-empty">No projectiles in flight.</div>
    `
  }
  const mode = _groupMode.value
  const sections = []
  if (mode === 'owner') {
    // Bucket by owning unit id.  Ownerless rows (rare; ownerId points to a
    // despawned unit) drop into a synthetic "Unowned" bucket so they
    // remain visible.
    const byOwner = new Map()
    for (const p of list) {
      const key = p.owner ? `u${p.owner.id}` : 'unowned'
      let bucket = byOwner.get(key)
      if (!bucket) {
        bucket = {
          key,
          label: p.owner ? `${p.owner.name || 'Unit'} #${p.owner.id}` : 'Unowned',
          side: p.owner ? (p.owner.side | 0) : 0,
          items: [],
        }
        byOwner.set(key, bucket)
      }
      bucket.items.push(p)
    }
    for (const b of byOwner.values()) {
      // Reuse the section row, but compose the owner swatch into the
      // label so the user sees the team colour next to the unit name.
      const swatch = _sideSwatch(b.side)
      sections.push(html`
        <div class="mv-fx-section" onClick=${() => _toggleSection(b.key)} key=${b.key}>
          <span class="mv-fx-chev">${_collapsedSections.value.has(b.key) ? '▸' : '▾'}</span>
          ${swatch}
          <span>${b.label} (${b.items.length})</span>
        </div>
        ${_collapsedSections.value.has(b.key) ? null : html`
          <div class="mv-fx-cards" key=${`cards-${b.key}`}>
            ${b.items.map((proj) => html`
              <${ProjectileCard} proj=${proj} key=${proj.id} />
            `)}
          </div>
        `}
      `)
    }
  } else {
    // Family mode — fixed bucket order so a user toggling Bombs back open
    // doesn't have it jump position when the rocket count changes.
    const byFamily = new Map()
    for (const fam of [_FAMILY_DEFS.missile, _FAMILY_DEFS.rocket, _FAMILY_DEFS.bomb, _FAMILY_DEFS.other]) {
      byFamily.set(fam.id, [])
    }
    for (const p of list) {
      const fam = _familyOf(p.mode)
      byFamily.get(fam.id).push(p)
    }
    for (const fam of [_FAMILY_DEFS.missile, _FAMILY_DEFS.rocket, _FAMILY_DEFS.bomb, _FAMILY_DEFS.other]) {
      const items = byFamily.get(fam.id)
      if (items.length === 0) continue
      sections.push(html`
        <${Section} sectionKey=${`fam-${fam.id}`}
                   label=${fam.label} icon=${fam.icon}
                   items=${items} key=${fam.id} />
      `)
    }
  }
  return html`
    <${GroupModePicker} />
    ${sections}
  `
}

export function ProjectilesPanel() {
  return html`
    <${FloatingPanel} id=${PANEL_ID} title="Projectiles">
      <${ProjectilesBody} />
    <//>
  `
}
