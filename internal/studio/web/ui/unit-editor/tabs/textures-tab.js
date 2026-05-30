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
import { resolveTextureHints, DEFAULT_HINTS } from '/game3d/hints-textures.js'

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
const _bridge = { setHoveredTexture: (_name) => {} }

export function configureTexturesBridge(impl) {
  Object.assign(_bridge, { setHoveredTexture: (_name) => {} }, impl)
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

function _HintPopover() {
  const o = _openHint.value
  if (!o) return null
  const h = o.hints
  const plain = h === DEFAULT_HINTS || (!_hintBadges(h).length)
  // Clamp so the card stays on-screen.
  const left = Math.min(o.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 280)
  const top = Math.min(o.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 220)
  const spec = h.specular || {}
  const rl = h.runningLights
  const bump = h.bump
  return html`
    <div class="mv-hint-backdrop" onClick=${() => { _openHint.value = null }}>
      <div class="mv-hint-popover" style=${`left:${left}px;top:${top}px`} onClick=${(e) => e.stopPropagation()}>
        <div class="mv-hint-pop-head">
          <span class="mv-hint-pop-title">${o.name}</span>
          <button class="mv-hint-pop-close" onClick=${() => { _openHint.value = null }}>×</button>
        </div>
        <div class="mv-hint-pop-sub">Resolved material hints</div>
        ${plain && html`<div class="mv-hint-plain">Plain painted surface — no hints.</div>`}
        <${_HintLine} label="Specular" on=${!!spec.metallic}
          value=${spec.metallic ? `metallic · ×${spec.scale}` : `painted · ×${spec.scale || 1}`} />
        <${_HintLine} label="Running lights" on=${!!(rl && rl.blink)}
          value=${rl ? `blink ${rl.blink ? 'on' : 'off'} · emit ${rl.emit}` : 'off'} />
        <${_HintLine} label="Auto-bump" on=${!!(bump && bump.generate)}
          value=${bump ? `generate ${bump.generate ? 'on' : 'off'} · ×${bump.intensity}` : 'off'} />
        <${_HintLine} label="Emissive" on=${!!h.emissive}
          value=${h.emissive ? `[${(h.emissive.color || []).join(', ')}] · ${h.emissive.strength}` : 'off'} />
        <div class="mv-hint-pop-foot">Gated by <b>Surface Hints</b> in Graphics Options.</div>
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
