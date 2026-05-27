// textures-tab.js
//
// React-rendered Textures sidebar tab.  Lists every distinct texture
// the unit references, grouped by source GAF, sorted by usage
// (largest atlases first).  Hovering a row asks the host to flash
// the matching primitives red in the 3D view via setHoveredTexture.
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

// _model — current model the user is inspecting.  Host updates it
// via setTexturesModel(); the component re-renders when it changes.
const _model = signal(null)
const _filter = signal('')

// _bridge — host-supplied callbacks.  setHoveredTexture(name|null)
// asks the renderer to flash matching primitives; the no-op fallback
// keeps the module importable in isolated tests.
const _bridge = { setHoveredTexture: (_name) => {} }

export function configureTexturesBridge(impl) {
  Object.assign(_bridge, { setHoveredTexture: (_name) => {} }, impl)
}

export function setTexturesModel(model) {
  _model.value = model || null
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
  const onEnter = (name) => () => _bridge.setHoveredTexture(name)
  const onLeave = () => _bridge.setHoveredTexture(null)
  return groups.map((g) => {
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
          ${visible.map((t) => html`
            <div class="mv-texture-row"
                 data-texture=${t.name}
                 key=${t.name}
                 onMouseEnter=${onEnter(t.name)}
                 onMouseLeave=${onLeave}>
              <img src=${`/api/studio/texture/${encodeURIComponent(t.name)}.png`}
                   alt=${t.name}
                   loading="lazy" />
              <span class="mv-texture-name">${t.name}</span>
              <span class="mv-texture-count">×${t.count}</span>
            </div>
          `)}
        </div>
      </div>
    `
  })
}
