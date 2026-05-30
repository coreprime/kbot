// textures-tab.js
//
// React-rendered Textures sidebar tab.  Lists every distinct texture
// the unit references, grouped by source GAF, sorted by usage
// (largest atlases first).  Hovering a row asks the host to flash
// the matching primitives red in the 3D view via setHoveredTexture.
//
// Each row also surfaces the material HINTS resolved for that tile by
// hints-textures.js (the single source of truth the renderer reads):
// a compact badge strip shows which hints are active (metal specular /
// running lights / auto-bump / emissive), and clicking the row opens a
// pop-up with the exact parameters — so the hinting can be validated
// per-texture against what the shader actually applies.
//
// Host integration:
//   - render(WelcomeScreen target, props)  not used; the host calls
//     setTexturesModel(model) when a new unit loads; the component
//     reads its model from a module-scoped signal.
//   - configureTexturesBridge({ setHoveredTexture }) gives the
//     component its renderer hook so it doesn't reach across into
//     the modelViewerInstance global directly.
//
// Collapse state lives in a module-scoped Set so a tab switch + back
// preserves the user's per-GAF unfolds — same persistence behaviour
// the legacy renderTexturesTab._collapsed set offered.

import { signal } from '@preact/signals'
import { useState } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'
import {
  resolveTextureHints, resolveBaseHints, DEFAULT_HINTS,
  setTextureHintOverride, clearTextureHintOverride, hasTextureHintOverride,
} from '/game3d/hints-textures.js'

// _hintEditTick — bumped on every parameter edit so the open pop-up
// re-renders against the freshly-resolved (overridden) hints.
const _hintEditTick = signal(0)

// _model — current model the user is inspecting.  Host updates it
// via setTexturesModel(); the component re-renders when it changes.
const _model = signal(null)
const _filter = signal('')

// _openHint — the texture whose hint pop-up is open: { name, x, y } or
// null.  Module-scoped so it survives the local re-render churn.
const _openHint = signal(null)

// _bridge — host-supplied callbacks.  setHoveredTexture(name|null)
// asks the renderer to flash matching primitives; the no-op fallback
// keeps the module importable in isolated tests.
const _bridge = { setHoveredTexture: (_name) => {}, refreshHints: () => {} }

export function configureTexturesBridge(impl) {
  Object.assign(_bridge, { setHoveredTexture: (_name) => {}, refreshHints: () => {} }, impl)
}

export function setTexturesModel(model) {
  _model.value = model || null
  _openHint.value = null
}

export function setTexturesFilter(q) {
  _filter.value = q || ''
}

// _collapsed — set of GAF names the user has folded.  Module-scoped
// so a tab-swap and back doesn't lose the unfold layout.
const _collapsed = new Set()

function _buildGroups(model) {
  // Walk the piece tree once and tally usage per texture name.
  const usage = new Map()
  const visit = (p) => {
    if (!p) return
    if (p.drawGroups) {
      for (const g of p.drawGroups) {
        const t = g.textureName || g.texture
        if (!t) continue
        const k = t.toLowerCase()
        usage.set(k, (usage.get(k) || 0) + 1)
      }
    }
    for (const c of p.children || []) visit(c)
  }
  visit(model.root)
  if (usage.size === 0) return []
  const sources = model.textureSources || {}
  const groups = new Map()
  for (const [name, count] of usage) {
    const gaf = sources[name] || '(unknown)'
    if (!groups.has(gaf)) groups.set(gaf, [])
    groups.get(gaf).push({ name, count })
  }
  return [...groups.entries()].map(([gaf, textures]) => {
    const total = textures.reduce((n, t) => n + t.count, 0)
    textures.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return { gaf, textures, total }
  }).sort((a, b) => b.total - a.total || a.gaf.localeCompare(b.gaf))
}

// _hintBadges — the active-hint chips for a tile.  Returns [] for a
// plain painted surface (DEFAULT_HINTS) so untagged tiles read clean.
function _hintBadges(hints) {
  const out = []
  if (hints.specular && hints.specular.metallic) {
    out.push({ key: 'metal', icon: '🔩', title: `Metal specular ×${hints.specular.scale}` })
  }
  if (hints.runningLights && hints.runningLights.blink) {
    out.push({ key: 'lights', icon: '💡', title: `Running lights (emit ${hints.runningLights.emit})` })
  }
  if (hints.bump && hints.bump.generate) {
    out.push({ key: 'bump', icon: '🗻', title: `Auto-bump ×${hints.bump.intensity}` })
  }
  if (hints.emissive) {
    out.push({ key: 'emit', icon: '🌟', title: 'Emissive' })
  }
  return out
}

// _Row — a single texture entry.  Hover flashes the matching prims;
// click opens the hint pop-up.  `hinted` toggles a left accent so
// tiles that carry any material hint stand out in the list.
function _Row({ t }) {
  const hints = resolveTextureHints(t.name)
  const badges = _hintBadges(hints)
  const hinted = badges.length > 0
  const open = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    _openHint.value = { name: t.name, hints, x: r.right + 8, y: r.top }
  }
  return html`
    <div class=${'mv-texture-row' + (hinted ? ' mv-texture-row--hinted' : '')}
         data-texture=${t.name}
         key=${t.name}
         title="Click to inspect material hints"
         onMouseEnter=${() => _bridge.setHoveredTexture(t.name)}
         onMouseLeave=${() => _bridge.setHoveredTexture(null)}
         onClick=${open}>
      <img src=${`/api/studio/texture/${encodeURIComponent(t.name)}.png`}
           alt=${t.name}
           loading="lazy" />
      <span class="mv-texture-name">${t.name}</span>
      ${badges.length > 0 && html`
        <span class="mv-texture-badges">
          ${badges.map((b) => html`<span class="mv-texture-badge" title=${b.title} key=${b.key}>${b.icon}</span>`)}
        </span>`}
      <span class="mv-texture-count">×${t.count}</span>
    </div>
  `
}

// _HintRow / _HintPopover — the per-texture pop-up.  Shows the exact
// resolved hint block (the same object resolveTextureHints feeds the
// model loader + shader), so what's displayed here is precisely what
// the renderer applies.
function _HintLine({ label, value, on }) {
  return html`
    <div class="mv-hint-line">
      <span class=${'mv-hint-dot' + (on ? ' on' : '')}></span>
      <span class="mv-hint-label">${label}</span>
      <span class="mv-hint-value">${value}</span>
    </div>
  `
}

// Effective sub-block readers — fill in the same defaults the renderer
// applies for any field the hint omits, so the editor sliders always show
// a real starting value (e.g. a tile that detected only `blink` still
// edits emit/fadeOut/gap from their defaults).
function _effSpec(h) {
  const s = h.specular || {}
  return { metallic: !!s.metallic, scale: s.scale != null ? s.scale : 1.0 }
}
function _effRL(h) {
  const r = h.runningLights || {}
  return {
    blink: !!r.blink,
    emit: r.emit != null ? r.emit : 1.0,
    fadeOut: r.fadeOut != null ? r.fadeOut : 0.15,
    gap: r.gap != null ? r.gap : 1,
    keyBright: r.keyBright != null ? r.keyBright : 0.12,
    keySat: r.keySat != null ? r.keySat : 0.50,
  }
}
function _effBump(h) {
  const b = h.bump || {}
  return {
    generate: !!b.generate,
    intensity: b.intensity != null ? b.intensity : 1.0,
    smooth: b.smooth != null ? b.smooth : 1.5,
    threshold: b.threshold != null ? b.threshold : 0.12,
  }
}

// _EditToggle / _EditNum — the editable rows.  onChange/onInput fire on
// every input event so the 3D view updates live as the slider drags.
function _EditToggle({ label, on, onChange }) {
  return html`
    <label class="mv-hint-edit-row mv-hint-edit-toggle">
      <input type="checkbox" checked=${on} onChange=${(e) => onChange(e.currentTarget.checked)} />
      <span class="mv-hint-label">${label}</span>
    </label>
  `
}
function _EditNum({ label, value, min, max, step, fmt, disabled, onInput }) {
  return html`
    <div class=${'mv-hint-edit-row' + (disabled ? ' disabled' : '')}>
      <span class="mv-hint-label">${label}</span>
      <input type="range" min=${min} max=${max} step=${step} value=${value} disabled=${disabled}
             onInput=${(e) => onInput(+e.currentTarget.value)} />
      <span class="mv-hint-edit-val">${fmt ? fmt(value) : value}</span>
    </div>
  `
}

function _HintPopover() {
  const o = _openHint.value
  // Read the edit tick so the card re-subscribes + re-renders after every
  // tweak (also stamped on the card below to keep the read "used").
  const tick = _hintEditTick.value
  if (!o) return null
  // Effective hints = detected + any live session override; the editors
  // read/write these.  Detected = the raw table values, shown read-only
  // below for comparison.
  const eff = resolveTextureHints(o.name)
  const base = resolveBaseHints(o.name)
  const overridden = hasTextureHintOverride(o.name)
  const left = Math.min(o.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 300)
  const top = Math.min(o.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 440)

  // commit — push the new override to the renderer + bump the card.  All
  // setters write the FULL sub-block so the replace-merge keeps siblings.
  const commit = () => { _bridge.refreshHints(); _hintEditTick.value++ }
  const setSpec = (patch) => { setTextureHintOverride(o.name, { specular: { ..._effSpec(eff), ...patch } }); commit() }
  const setRL = (patch) => { setTextureHintOverride(o.name, { runningLights: { ..._effRL(eff), ...patch } }); commit() }
  const setBump = (patch) => { setTextureHintOverride(o.name, { bump: { ..._effBump(eff), ...patch } }); commit() }
  const reset = () => { clearTextureHintOverride(o.name); commit() }

  const es = _effSpec(eff), er = _effRL(eff), eb = _effBump(eff)
  const bs = base.specular || {}, br = base.runningLights, bb = base.bump
  const plainBase = base === DEFAULT_HINTS || !_hintBadges(base).length

  return html`
    <div class="mv-hint-backdrop" onClick=${() => { _openHint.value = null }}>
      <div class="mv-hint-popover mv-hint-popover--edit" data-tick=${tick} style=${`left:${left}px;top:${top}px`} onClick=${(e) => e.stopPropagation()}>
        <div class="mv-hint-pop-head">
          <span class="mv-hint-pop-title">${o.name}</span>
          <button class="mv-hint-pop-close" onClick=${() => { _openHint.value = null }}>×</button>
        </div>

        <div class="mv-hint-section">
          <div class="mv-hint-section-head">
            <span>Custom Parameters</span>
            <button class="mv-hint-reset" disabled=${!overridden}
                    title="Revert this tile to its detected hints"
                    onClick=${reset}>${overridden ? '↺ Reset' : 'Detected'}</button>
          </div>

          <div class="mv-hint-edit-group-label">💎 Specular</div>
          <${_EditToggle} label="Metallic sheen" on=${es.metallic} onChange=${(v) => setSpec({ metallic: v })} />
          <${_EditNum} label="Scale" min=${0} max=${6} step=${0.1} value=${es.scale}
            disabled=${!es.metallic} fmt=${(v) => `×${(+v).toFixed(1)}`} onInput=${(v) => setSpec({ scale: v })} />

          <div class="mv-hint-edit-group-label">💡 Running Lights</div>
          <${_EditToggle} label="Blink + emit" on=${er.blink} onChange=${(v) => setRL({ blink: v })} />
          <${_EditNum} label="Emit" min=${0} max=${3} step=${0.05} value=${er.emit}
            disabled=${!er.blink} fmt=${(v) => (+v).toFixed(2)} onInput=${(v) => setRL({ emit: v })} />
          <${_EditNum} label="Fade Out Opacity" min=${0} max=${1} step=${0.05} value=${er.fadeOut}
            disabled=${!er.blink} fmt=${(v) => (+v).toFixed(2)} onInput=${(v) => setRL({ fadeOut: v })} />
          <${_EditNum} label="Group radius" min=${0} max=${4} step=${1} value=${er.gap}
            disabled=${!er.blink} fmt=${(v) => `${v | 0}`} onInput=${(v) => setRL({ gap: v })} />
          <${_EditNum} label="Detect brightness" min=${0.02} max=${0.6} step=${0.01} value=${er.keyBright}
            disabled=${!er.blink} fmt=${(v) => (+v).toFixed(2)} onInput=${(v) => setRL({ keyBright: v })} />
          <${_EditNum} label="Detect saturation" min=${0} max=${1} step=${0.05} value=${er.keySat}
            disabled=${!er.blink} fmt=${(v) => (+v).toFixed(2)} onInput=${(v) => setRL({ keySat: v })} />

          <div class="mv-hint-edit-group-label">🗻 Bump Mapping</div>
          <${_EditToggle} label="Generate relief" on=${eb.generate} onChange=${(v) => setBump({ generate: v })} />
          <${_EditNum} label="Intensity" min=${0} max=${3} step=${0.05} value=${eb.intensity}
            disabled=${!eb.generate} fmt=${(v) => (+v).toFixed(2)} onInput=${(v) => setBump({ intensity: v })} />
          <${_EditNum} label="Smooth" min=${1} max=${4} step=${0.1} value=${eb.smooth}
            disabled=${!eb.generate} fmt=${(v) => (+v).toFixed(1)} onInput=${(v) => setBump({ smooth: v })} />
          <${_EditNum} label="Grain deadzone" min=${0} max=${0.4} step=${0.01} value=${eb.threshold}
            disabled=${!eb.generate} fmt=${(v) => (+v).toFixed(2)} onInput=${(v) => setBump({ threshold: v })} />
        </div>

        <div class="mv-hint-section">
          <div class="mv-hint-section-head"><span>Detected Parameters</span></div>
          ${plainBase && html`<div class="mv-hint-plain">Plain painted surface — no hints detected.</div>`}
          <${_HintLine} label="Specular" on=${!!bs.metallic}
            value=${bs.metallic ? `metallic · ×${bs.scale}` : `painted · ×${bs.scale || 1}`} />
          <${_HintLine} label="Running lights" on=${!!(br && br.blink)}
            value=${br ? `blink ${br.blink ? 'on' : 'off'} · emit ${br.emit} · gap ${br.gap != null ? br.gap : 1}` : 'off'} />
          <${_HintLine} label="Auto-bump" on=${!!(bb && bb.generate)}
            value=${bb ? `generate ${bb.generate ? 'on' : 'off'} · ×${bb.intensity}` : 'off'} />
          <${_HintLine} label="Emissive" on=${!!base.emissive}
            value=${base.emissive ? `[${(base.emissive.color || []).join(', ')}] · ${base.emissive.strength}` : 'off'} />
        </div>

        <div class="mv-hint-pop-foot">Live, session-only. Gated by <b>Surface Hints</b> / <b>Running Lights</b> / <b>Bump Mapping</b> in Graphics Options.</div>
      </div>
    </div>
  `
}

export function TexturesTab() {
  const model = _model.value
  const filter = (_filter.value || '').trim().toLowerCase()
  // Local "tick" state used by the collapse toggle so toggling a
  // group folds re-renders without round-tripping through a signal.
  const [, setTick] = useState(0)
  const bump = () => setTick((t) => t + 1)
  if (!model) {
    return html`<div class="loading">No unit loaded.</div>`
  }
  const groups = _buildGroups(model)
  if (groups.length === 0) {
    return html`<div class="loading">No textures referenced.</div>`
  }
  return html`
    ${groups.map((g) => {
      // Filter applies per-row; group stays visible whenever any of
      // its textures matches.  Empty query renders everything.
      const visible = filter
        ? g.textures.filter((t) => t.name.includes(filter))
        : g.textures
      if (filter && visible.length === 0) return null
      const isCollapsed = _collapsed.has(g.gaf)
      return html`
        <div class=${'mv-texture-group' + (isCollapsed ? ' collapsed' : '')} key=${g.gaf}>
          <div class="mv-texture-group-header"
               onClick=${() => {
                 if (isCollapsed) _collapsed.delete(g.gaf)
                 else _collapsed.add(g.gaf)
                 bump()
               }}>
            <span class="chev">▾</span>
            <span class="mv-texture-group-name">${g.gaf}</span>
            <span class="mv-texture-group-count">${g.textures.length} tex · ${g.total}</span>
          </div>
          <div class="mv-texture-group-body">
            ${visible.map((t) => html`<${_Row} t=${t} key=${t.name} />`)}
          </div>
        </div>
      `
    })}
    <${_HintPopover} />
  `
}
