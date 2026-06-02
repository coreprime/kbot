// weapons-tab.js
//
// React-rendered Weapons sidebar tab.  Three slot cards (Primary /
// Secondary / Tertiary), each with:
//
//   - Header row 1: slot label + collapse chevron
//   - Header row 2: colour swatch + weapon name + TDF id chip
//   - Change Weapon button (opens picker via host bridge)
//   - Aim / Query / Fire script-presence chips (✓ / ✗)
//   - Missing-Query warning line when applicable
//   - Reload countdown bar (live, ticks each runtimeTick)
//   - Stats grid (reload / range / velocity / burst / model / color)
//   - Sound rows with inline ▶ play buttons (host plays via AudioPool)
//   - Flag chips (beam / smoke trail / self-prop / tracks / ballistic /
//     command-fire)
//   - "In flight (n)" projectile list (live, ticks each runtimeTick)
//
// Reads from inspector-store.mv (so swap-unit and weapon-swap flow
// through automatically).  Per-slot collapse + the master "Show
// Projectiles" toggle persist in module-scoped state so a tab swap
// preserves them.

import { signal } from '@preact/signals'
import { useState } from 'preact/hooks'
import { htm as html } from '@kbot/ui/htm-bind'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'

const _showProjectiles = signal(true)
const _collapsed = new Set()

const _bridge = {
  paletteColor:    (_idx) => null,
  openWeaponPicker:(_slotIndex) => {},
  playSound:       (_stem) => {},
}

export function configureWeaponsTabBridge(impl) {
  Object.assign(_bridge, {
    paletteColor:    (_idx) => null,
    openWeaponPicker:(_slotIndex) => {},
    playSound:       (_stem) => {},
  }, impl)
}

const SLOTS = ['primary', 'secondary', 'tertiary']

function _fmt(v, unit) {
  if (v == null || v === 0) return '—'
  return `${(+v).toFixed(2).replace(/\.?0+$/, '')}${unit ? ' ' + unit : ''}`
}

function _hexFor(c) {
  return [c[0], c[1], c[2]]
    .map((v) => Math.round(v * 255).toString(16).padStart(2, '0'))
    .join('')
}

export function WeaponsTab() {
  // Subscribe to runtimeTick so reload bars + projectile list refresh
  // live; mv subscribes us to unit / meta changes too.
  void runtimeTick.value
  const proxy = mv.value
  const meta = proxy && proxy.unitMeta
  if (!meta || !meta.weapons) {
    return html`<div class="loading">No weapons declared.</div>`
  }
  const scripts = new Set(
    (proxy.cob && proxy.cob.unit && proxy.cob.unit.scriptNames) || []
  )
  const [, setTick] = useState(0)
  const bump = () => setTick((t) => t + 1)
  return html`
    <label class="mv-weapon-show-proj"
           title="Toggle the 'recent projectiles' list below each weapon card.">
      <input type="checkbox"
             checked=${_showProjectiles.value}
             onChange=${(e) => { _showProjectiles.value = e.currentTarget.checked }} />
      <span>Show Projectiles</span>
    </label>
    ${SLOTS.map((slot, i) => {
      const w = meta.weapons.find((x) => x.slot === slot)
        || { slot, name: '', index: i + 1 }
      return html`<${WeaponCard} key=${slot} mv=${proxy} slot=${slot} w=${w}
                                 scripts=${scripts} bumpParent=${bump} />`
    })}
  `
}

function WeaponCard({ mv, slot, w, scripts, bumpParent }) {
  void runtimeTick.value
  const cap = slot[0].toUpperCase() + slot.slice(1)
  const idx = w.index || (slot === 'primary' ? 1 : slot === 'secondary' ? 2 : 3)
  const collapsed = _collapsed.has(slot)
  const toggleCollapse = (e) => {
    if (e.target.closest('button, input, label')) return
    if (collapsed) _collapsed.delete(slot)
    else _collapsed.add(slot)
    bumpParent()
  }
  // Script presence chips — every slot gets them, even empty ones,
  // so the user knows whether assigning a weapon here would actually
  // work given the unit's COB scripts.
  const required = [
    { name: `Aim${cap}`,   short: 'Aim',   key: 'aim'   },
    { name: `Query${cap}`, short: 'Query', key: 'query' },
    { name: `Fire${cap}`,  short: 'Fire',  key: 'fire'  },
  ]
  let missingQuery = false, anyMissing = false
  const chips = required.map((r) => {
    const present = scripts.has(r.name)
    if (!present) { anyMissing = true; if (r.key === 'query') missingQuery = true }
    return { ...r, present }
  })
  const palColor = (w.colorIdx > 0) ? _bridge.paletteColor(w.colorIdx) : null
  const cardCls = 'mv-weapon-card' + (collapsed ? ' mv-weapon-collapsed' : '')
  return html`
    <div class=${cardCls} data-slot=${slot} data-slot-index=${idx}>
      <div class="mv-weapon-head"
           title="Click to collapse / expand this weapon card."
           onClick=${toggleCollapse}>
        <div class="mv-weapon-head-row mv-weapon-head-slot-row">
          <div class="mv-weapon-slot">${cap}</div>
          <span class="mv-weapon-chev"
                title="Collapse / expand this card">▾</span>
        </div>
        <div class="mv-weapon-head-row mv-weapon-head-name-row">
          ${palColor ? html`
            <span class="mv-weapon-color-rect"
                  style=${`background: rgb(${Math.round(palColor[0]*255)}, ${Math.round(palColor[1]*255)}, ${Math.round(palColor[2]*255)})`}
                  title=${`palette[${w.colorIdx}] = #${_hexFor(palColor)}`}></span>
          ` : null}
          <span class="mv-weapon-name">${w.name || '—'}</span>
          ${w.weaponId && w.weaponId > 0 ? html`
            <span class="mv-weapon-id"
                  title=${`Weapon TDF id=${w.weaponId} — engine-internal weapon table index`}>id=${w.weaponId}</span>
          ` : null}
        </div>
      </div>
      <div class="mv-weapon-body">
        <div class="mv-weapon-actions">
          <button class="btn mv-weapon-change"
                  onClick=${() => _bridge.openWeaponPicker(idx)}>
            ${w.name ? 'Change Weapon' : 'Assign Weapon'}
          </button>
        </div>
        <div class="mv-weapon-scripts"
             role="group"
             aria-label=${`Required scripts for ${slot} weapon`}>
          ${chips.map((c) => html`
            <span key=${c.key}
                  class=${`mv-weapon-script-chip ${c.present ? 'ok' : 'bad'}`}
                  title=${c.present
                    ? `${c.name} is defined in the unit's COB`
                    : `${c.name} is missing from the unit's COB`}>
              <span class="mark">${c.present ? '✓' : '✗'}</span>
              <span class="lbl">${c.short}</span>
            </span>
          `)}
        </div>
        ${anyMissing ? html`
          <div class="mv-weapon-warning">
            ${missingQuery
              ? `⚠ This unit does not have the required functions to support a weapon.  (Missing Query${cap}.)`
              : `⚠ Some firing scripts are missing — animations may not play correctly.`}
          </div>
        ` : null}
        ${w.name && w.reloadSec > 0 ? html`<${ReloadBar} mv=${mv} slot=${slot} w=${w} />` : null}
        ${w.name ? html`<${StatsAndSounds} w=${w} palColor=${palColor} />` : null}
        ${w.name ? html`<${ProjList} mv=${mv} slot=${slot} /> ` : null}
      </div>
    </div>
  `
}

function ReloadBar({ mv, slot, w }) {
  void runtimeTick.value
  const rt = mv && mv.cob && mv.cob.runtime
  const ctrl = mv && mv._mvControls
  let pct = 100, label = 'ready', ready = true
  if (rt && ctrl) {
    const state = ctrl.aimState && ctrl.aimState[slot]
    const reloadMs = (w.reloadSec || 0) * 1000
    if (state && reloadMs > 0 && state.lastFireMs > -Infinity) {
      const since = rt.simTimeMs - state.lastFireMs
      const remaining = Math.max(0, reloadMs - since)
      pct = Math.max(0, Math.min(100, (1 - remaining / reloadMs) * 100))
      if (remaining > 0) { label = (remaining / 1000).toFixed(2) + ' s'; ready = false }
    }
  }
  return html`
    <div class="mv-weapon-reload"
         title="Time until this weapon can fire again — counts down on the runtime sim clock so slow-mo stretches it.">
      <div class="mv-weapon-reload-head">
        <span class="mv-weapon-reload-k">Reload</span>
        <span class="mv-weapon-reload-v">${label}</span>
      </div>
      <div class="mv-weapon-reload-bar">
        <div class=${'mv-weapon-reload-fill' + (ready ? ' mv-weapon-reload-fill-ready' : '')}
             style=${`width: ${pct.toFixed(1)}%`}></div>
      </div>
    </div>
  `
}

function StatsAndSounds({ w, palColor }) {
  const stats = [
    ['Reload',   _fmt(w.reloadSec, 's')],
    ['Range',    _fmt(w.rangeWU, 'wu')],
    ['Velocity', _fmt(w.velocityWU, 'wu/s')],
    ['Burst',    (w.burst > 1) ? `${w.burst}×${_fmt(w.burstRateSec, 's')}` : '1'],
    ['Model',    w.model || '—'],
    ['Color',    w.colorIdx ? String(w.colorIdx) : '—'],
  ]
  const flags = []
  if (w.beamWeapon)  flags.push('beam')
  if (w.smokeTrail)  flags.push('smoke trail')
  if (w.selfProp)    flags.push('self-prop')
  if (w.tracks)      flags.push('tracks')
  if (w.ballistic)   flags.push('ballistic')
  if (w.commandFire) flags.push('command-fire')
  const sounds = [['Sound', w.soundStart], ['Hit', w.soundHit]]
  return html`
    <div class="mv-weapon-stats">
      ${stats.map(([k, v]) => html`
        <div class="mv-weapon-stat" key=${k}>
          ${(k === 'Color' && palColor) ? html`
            <span class="mv-weapon-swatch"
                  style=${`background: rgb(${Math.round(palColor[0]*255)}, ${Math.round(palColor[1]*255)}, ${Math.round(palColor[2]*255)})`}
                  title=${`palette[${w.colorIdx}] = #${_hexFor(palColor)}`}></span>
          ` : null}
          <span class="k">${k}</span><span class="v">${v}</span>
        </div>
      `)}
    </div>
    ${sounds.map(([k, snd]) => html`
      <div class="mv-weapon-sound" key=${k}>
        <span class="k">${k}</span>
        <span class="v">${snd || '—'}</span>
        ${snd ? html`
          <button class="mv-weapon-sound-play"
                  title=${`Play ${snd}.wav`}
                  aria-label=${`Play ${snd}`}
                  onClick=${(e) => { e.preventDefault(); e.stopPropagation(); _bridge.playSound(snd) }}>▶</button>
        ` : null}
      </div>
    `)}
    ${flags.length > 0 ? html`
      <div class="mv-weapon-chips">
        ${flags.map((f) => html`<span class="mv-weapon-chip" key=${f}>${f}</span>`)}
      </div>
    ` : null}
  `
}

function ProjList({ mv, slot }) {
  void runtimeTick.value
  const ctrl = mv && mv._mvControls
  const rt = mv && mv.cob && mv.cob.runtime
  const list = (ctrl && ctrl.activeProjectiles && ctrl.activeProjectiles[slot]) || []
  const hidden = !_showProjectiles.value
  return html`
    <div class=${'mv-weapon-projlist' + (hidden ? ' mv-weapon-projlist-hidden' : '')}>
      <div class="mv-weapon-projlist-head">
        <span>In flight (${list.length})</span>
      </div>
      <div class="mv-weapon-projlist-rows">
        ${list.length === 0 ? html`
          <div class="mv-weapon-projlist-empty">No projectiles in flight.</div>
        ` : list.map((s, i) => {
          const now = rt ? rt.simTimeMs : 0
          const ageMs = Math.max(0, now - s.spawnSimMs)
          const ageSec = ageMs / 1000
          const px = s.anchor[0] + s.velocity[0] * ageSec
          const py = s.anchor[1] + s.velocity[1] * ageSec
          const pz = s.anchor[2] + s.velocity[2] * ageSec
          return html`
            <div class="mv-weapon-projlist-row" key=${i}>
              <span class="mv-weapon-projlist-age"
                    title=${`Spawned ${ageSec.toFixed(2)} s ago — expires in ${((s.lifeMs - ageMs) / 1000).toFixed(2)} s`}>${ageSec.toFixed(2)}s</span>
              <span class="mv-weapon-projlist-pos">${px.toFixed(1)}, ${py.toFixed(1)}, ${pz.toFixed(1)}</span>
              <span class="mv-weapon-projlist-spd">${s.speed.toFixed(0)} wu/s</span>
            </div>
          `
        })}
      </div>
    </div>
  `
}
