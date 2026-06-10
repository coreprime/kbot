// drawer.js
//
// Left-sidebar drawer that lists every section + feature available
// to stamp on the map.  Two top-level tabs (Sections / Features —
// owned by the React sidebar header above this body), each filtered
// down to the user's typed query + the "Used only" / "Include
// wreckage" toggles for features.
//
// The body uses a two-level collapsible tree (world → group) +
// IntersectionObserver-driven virtualisation so a fresh boot
// doesn't pay for thousands of hidden DOM rows.
// virtualisedDrawerBody reserves the right scroll height up
// front and defers item creation until the body scrolls into
// view.  Each render tears down the previous observer so stale
// bodies don't keep references to discarded DOM.
//
// Drag + selection callbacks live in studio.js and reach this
// module through hostCallbacks (selectSection / selectFeature /
// beginSectionDrag / beginFeatureDrag / setActiveWorld) — those
// touch placement state + the asset cache + mode dispatch, none
// of which are this module's concern.

import { state, $, escapeHTML, hostCallbacks } from '../host-context.js'
import {
  worldFor,
  activeWorldsFor,
  featureWorldMatches,
  isWreckageFeature,
} from './helpers.js'
import { DRAWER_ITEM_HEIGHT, DRAWER_OBSERVER_MARGIN } from './constants.js'

// _apiUrl scopes an absolute /api/ path to the active workspace prefix when the
// editor runs under /workspaces/<id>/. Needed for <img> srcs built as HTML
// strings (innerHTML), which bypass the page's fetch/src shim.
function _apiUrl(p) {
  const base = (typeof window !== 'undefined' && window.__WS_BASE__) || ''
  return base + p
}

// Expanded hover preview popup — a large floating preview shown beside the
// hovered feature so spinning wreck/object models are big enough to read. For
// 3DO spin features it requests a larger render; for GAF features it shows the
// animated sprite enlarged.
const HOVER_PREVIEW_PX = 240
let _hoverPreviewEl = null
function _ensureHoverPreview() {
  if (_hoverPreviewEl) return _hoverPreviewEl
  const el = document.createElement('div')
  el.className = 'drawer-hover-preview'
  el.innerHTML = '<img alt="" />'
  document.body.appendChild(el)
  _hoverPreviewEl = el
  return el
}
function showFeatureHoverPreview(item, f) {
  if (!f.previewUrl) return
  const el = _ensureHoverPreview()
  const img = el.querySelector('img')
  const src = f.spin ? `${f.previewUrl}?size=${HOVER_PREVIEW_PX}` : f.previewUrl
  img.src = _apiUrl(src)
  const r = item.getBoundingClientRect()
  const box = HOVER_PREVIEW_PX + 16
  let left = r.right + 10
  if (left + box > window.innerWidth) left = r.left - box - 10
  if (left < 4) left = 4
  let top = r.top + r.height / 2 - box / 2
  top = Math.max(8, Math.min(top, window.innerHeight - box - 8))
  el.style.left = `${left}px`
  el.style.top = `${top}px`
  el.style.display = 'block'
}
function hideFeatureHoverPreview() {
  if (_hoverPreviewEl) _hoverPreviewEl.style.display = 'none'
}

// featureUsage returns a Map<lowercase name → count> derived from the
// current state.features array, so the drawer can show usage badges and
// filter to "used only" without re-walking the placements per row.
export function featureUsage() {
  const usage = new Map()
  for (const f of state.features) {
    const key = (f.name || '').toLowerCase()
    usage.set(key, (usage.get(key) || 0) + 1)
  }
  return usage
}

let _drawerObserver = null
function _ensureDrawerObserver() {
  if (_drawerObserver) return _drawerObserver
  _drawerObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      const populate = e.target._populate
      if (populate) {
        delete e.target._populate
        _drawerObserver.unobserve(e.target)
        populate(e.target)
      }
    }
  }, { root: $('#drawer'), rootMargin: DRAWER_OBSERVER_MARGIN, threshold: 0 })
  return _drawerObserver
}

// _virtualisedDrawerBody creates a drawer-group-body element that
// reserves space for `itemCount` rows but defers item creation until
// the body scrolls into view.  Reservations make the drawer scrollbar
// match the real total height even though the DOM only holds visible
// items.  When a group is collapsed (display:none) the observer simply
// doesn't fire until the user expands it — exactly what we want.
function _virtualisedDrawerBody(itemCount, populate) {
  const body = document.createElement('div')
  body.className = 'drawer-group-body'
  if (itemCount > 0) body.style.minHeight = (itemCount * DRAWER_ITEM_HEIGHT) + 'px'
  body._populate = (el) => {
    el.style.minHeight = ''
    populate(el)
  }
  _ensureDrawerObserver().observe(body)
  return body
}

export function renderDrawer() {
  const drawer = $('#drawer')
  // `#drawer` is rendered by the React MapSidebar (inside a FrozenSlot),
  // so it only exists once that island has mounted.  Bail out quietly if
  // a repaint is requested before then — the next renderDrawer after the
  // sidebar mounts paints the real content.
  if (!drawer) return
  // Tear down any pending observers from the previous render — those
  // bodies are about to be discarded and would otherwise keep refs.
  if (_drawerObserver) { _drawerObserver.disconnect(); _drawerObserver = null }
  const q = (state.drawerFilters[state.drawer] || '').trim().toLowerCase()
  if (state.drawer === 'sections') _renderSectionsDrawer(drawer, q)
  else _renderFeaturesDrawer(drawer, q)
}

// _ensureAutoExpandForFilter forces the first matching world + its
// first matching group to render expanded when the user is typing a
// filter but no group is currently open.  Lets a query like "trees"
// surface the first match without an extra click.  Keys go into the
// existing _sectionExpanded set, so toggling later collapses them as
// the user expects.  No-op when the filter is empty or any group is
// already open.
function _ensureAutoExpandForFilter(q, worldOrder, tree, keyPrefix, isActive) {
  if (!q || worldOrder.length === 0) return
  const expanded = state._sectionExpanded ??= new Set()
  const collapsed = state.collapsedGroups
  const isOpen = (key, activeByDefault) => {
    if (collapsed.has(key)) return false
    if (activeByDefault) return true
    return expanded.has(key)
  }
  // Walk both levels — if anything is already open we leave the
  // drawer alone (the user's view shouldn't shift while they refine).
  for (const world of worldOrder) {
    const worldKey = `${keyPrefix}-world:${world}`
    const activeWorld = isActive(world)
    if (isOpen(worldKey, activeWorld)) {
      const innerMap = tree.get(world)
      if (innerMap) {
        for (const inner of innerMap.keys()) {
          const groupKey = `${keyPrefix}-${keyPrefix === 'sections' ? 'group' : 'cat'}:${world}/${inner}`
          if (isOpen(groupKey, activeWorld)) return // group inside open world also open → done
        }
      }
    }
  }
  // Nothing is open — surface the first match.
  const firstWorld = worldOrder[0]
  const worldKey = `${keyPrefix}-world:${firstWorld}`
  expanded.add(worldKey)
  collapsed.delete(worldKey)
  const innerMap = tree.get(firstWorld)
  if (innerMap && innerMap.size > 0) {
    const firstInner = innerMap.keys().next().value
    const groupKey = `${keyPrefix}-${keyPrefix === 'sections' ? 'group' : 'cat'}:${firstWorld}/${firstInner}`
    expanded.add(groupKey)
    collapsed.delete(groupKey)
  }
}

function _renderSectionsDrawer(drawer, q) {
  const active = activeWorldsFor(state.planet)
  const activeLower = active.map((w) => w.toLowerCase())
  // Two-level tree: world → (group → items).  The world level is the
  // top-most collapse target so the user can fold whole tilesets in
  // one click.
  const tree = new Map()
  for (const s of state.sectionsList) {
    const hay = `${s.name} ${s.world} ${s.group}`.toLowerCase()
    if (q && !hay.includes(q)) continue
    const w = s.world || '—'
    const g = s.group || '—'
    if (!tree.has(w)) tree.set(w, new Map())
    const groups = tree.get(w)
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(s)
  }
  if (tree.size === 0) {
    drawer.innerHTML = '<div class="loading">No sections match.</div>'
    return
  }

  const worlds = _sortWorldsForDrawer(Array.from(tree.keys()), activeLower)
  _ensureAutoExpandForFilter(q, worlds, tree, 'sections',
    (w) => activeLower.includes(w.toLowerCase()))
  const frag = document.createDocumentFragment()
  for (const world of worlds) {
    const groupsMap = tree.get(world)
    const isActive = activeLower.includes(world.toLowerCase())
    const totalItems = Array.from(groupsMap.values()).reduce((n, items) => n + items.length, 0)
    const worldKey = `sections-world:${world}`
    const worldEl = _renderDrawerWorldGroup(worldKey, world, totalItems, isActive)
    const body = worldEl.querySelector('.drawer-group-body')
    for (const [groupName, items] of groupsMap) {
      const innerKey = `sections-group:${world}/${groupName}`
      body.appendChild(_renderSectionGroup(innerKey, groupName, items, !isActive))
    }
    frag.appendChild(worldEl)
  }
  drawer.replaceChildren(frag)
}

// _sortWorldsForDrawer puts the active tileset first, then "All Worlds"
// (handy for features that work across tilesets), then alphabetical.
function _sortWorldsForDrawer(worlds, activeLower) {
  return worlds.slice().sort((a, b) => {
    const aA = activeLower.includes(a.toLowerCase())
    const bA = activeLower.includes(b.toLowerCase())
    if (aA !== bA) return aA ? -1 : 1
    const aAll = /\ball worlds?\b/i.test(a) || /allworlds?/i.test(a)
    const bAll = /\ball worlds?\b/i.test(b) || /allworlds?/i.test(b)
    if (aAll !== bAll) return aAll ? -1 : 1
    return a.localeCompare(b)
  })
}

// _renderDrawerWorldGroup builds the outer collapsible world group.
// The active world expands by default; everything else collapses so
// the drawer stays compact on first view.
function _renderDrawerWorldGroup(key, worldName, totalItems, activeByDefault) {
  const groupEl = document.createElement('div')
  groupEl.className = 'drawer-group drawer-world'
  const defaultCollapsed = !activeByDefault
  const collapsed = state.collapsedGroups.has(key) || (defaultCollapsed && !state._sectionExpanded?.has(key))
  if (collapsed) groupEl.classList.add('collapsed')
  const title = document.createElement('div')
  title.className = 'drawer-group-title'
  title.innerHTML = `<span class="chev">▾</span><span class="drawer-world-name">${escapeHTML(worldName)}</span><span class="drawer-group-count">${totalItems}</span>`
  title.addEventListener('click', () => _toggleGroup(key, defaultCollapsed))
  // "Set as active" pill — clicking promotes this world to the map's
  // active tileset (state.planet).  Hides on the world that's already
  // active so the only visible pill is the actionable one.
  const world = worldFor(worldName)
  if (world && !activeByDefault) {
    const pill = document.createElement('button')
    pill.className = 'drawer-world-pill'
    pill.type = 'button'
    pill.title = `Make ${world.label} the active tileset for this map`
    pill.textContent = 'Set active'
    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      hostCallbacks.setActiveWorld?.(world)
    })
    title.appendChild(pill)
  } else if (activeByDefault) {
    const badge = document.createElement('span')
    badge.className = 'drawer-world-pill drawer-world-pill-active'
    badge.textContent = 'Active'
    title.appendChild(badge)
  }
  groupEl.appendChild(title)
  const body = document.createElement('div')
  body.className = 'drawer-group-body'
  groupEl.appendChild(body)
  return groupEl
}

// _renderSectionGroup builds the DOM for one collapsible group of sections.
// `key` is the persistent identifier used for the collapse-state set;
// `defaultCollapsed` is the starting state when the key is unknown.
// Items inside the body are materialised lazily when the body scrolls
// into view so the editor doesn't spend boot time building thousands of
// hidden DOM rows.
function _renderSectionGroup(key, groupName, items, defaultCollapsed) {
  const groupEl = document.createElement('div')
  groupEl.className = 'drawer-group'
  const collapsed = state.collapsedGroups.has(key) || (defaultCollapsed && !state.collapsedGroups.has(key) && !state._sectionExpanded?.has(key))
  if (collapsed) groupEl.classList.add('collapsed')

  const title = document.createElement('div')
  title.className = 'drawer-group-title'
  title.innerHTML = `<span class="chev">▾</span><span>${escapeHTML(groupName)}</span><span class="drawer-group-count">${items.length}</span>`
  title.addEventListener('click', () => _toggleGroup(key, defaultCollapsed))
  groupEl.appendChild(title)

  const body = _virtualisedDrawerBody(items.length, (el) => {
    const frag = document.createDocumentFragment()
    for (const s of items) frag.appendChild(_createSectionItem(s))
    el.appendChild(frag)
  })
  groupEl.appendChild(body)
  return groupEl
}

function _createSectionItem(s) {
  const item = document.createElement('div')
  item.className = 'drawer-item'
  item.draggable = true
  item.dataset.path = s.path
  if (state.selected?.type === 'section' && state.selected.path === s.path) {
    item.classList.add('selected')
  }
  // Native title gives the user the full path + dimensions on hover.
  const tooltipParts = [s.name]
  if (s.tileW || s.tileH) tooltipParts.push(`${s.tileW || '?'}×${s.tileH || '?'} tiles`)
  if (s.world) tooltipParts.push(`World: ${s.world}`)
  if (s.group) tooltipParts.push(`Group: ${s.group}`)
  if (s.path) tooltipParts.push(s.path)
  item.title = tooltipParts.join('\n')
  item.innerHTML = `
    <img class="drawer-thumb" src="${_apiUrl('/api/studio/section-preview/' + encodeURI(s.path))}" alt="" loading="lazy" draggable="false" />
    <div class="drawer-meta">
      <div class="drawer-name">${escapeHTML(s.name)}</div>
      <div class="drawer-sub">${s.tileW || '?'}×${s.tileH || '?'} tiles · ${escapeHTML(s.group || '')}</div>
    </div>
  `
  item.addEventListener('click', () => hostCallbacks.selectSection?.(s))
  item.addEventListener('dragstart', (e) => hostCallbacks.beginSectionDrag?.(e, s))
  return item
}

// _toggleGroup flips a group between collapsed/expanded.  `defaultCollapsed`
// is the initial state when the user has never interacted; toggling moves
// to the opposite state and remembers that the user has interacted (so
// auto-collapse doesn't undo their choice on the next render).
function _toggleGroup(key, defaultCollapsed) {
  const isCollapsed = state.collapsedGroups.has(key) || (defaultCollapsed && !state._sectionExpanded?.has(key))
  if (isCollapsed) {
    state.collapsedGroups.delete(key)
    ;(state._sectionExpanded ??= new Set()).add(key)
  } else {
    state.collapsedGroups.add(key)
    state._sectionExpanded?.delete(key)
  }
  renderDrawer()
}

function _renderFeaturesDrawer(drawer, q) {
  const active = activeWorldsFor(state.planet)
  const usage = featureUsage()
  // Two-level tree: world → (category → items).  The world level is the
  // top-most collapse target so the user can fold an entire tileset
  // (e.g. all of "Green World") in one click.
  const tree = new Map()
  for (const f of state.featuresList) {
    const hay = `${f.name} ${f.world} ${f.category} ${f.description}`.toLowerCase()
    if (q && !hay.includes(q)) continue
    if (state.usedOnly && !usage.has((f.name || '').toLowerCase())) continue
    // Wreckage is hidden by default — it's noisy and rarely something
    // the user wants to place on a fresh map.  Existing placements
    // (usage > 0) always show through so the user can manage them.
    if (!state.includeWreckage && isWreckageFeature(f) && !usage.has((f.name || '').toLowerCase())) continue
    const w = f.world || '—'
    const c = f.category || '—'
    if (!tree.has(w)) tree.set(w, new Map())
    const cats = tree.get(w)
    if (!cats.has(c)) cats.set(c, [])
    cats.get(c).push(f)
  }
  if (tree.size === 0) {
    if (state.usedOnly) {
      drawer.innerHTML = '<div class="loading">No placed features yet — turn off "Used only" to browse the full list.</div>'
    } else {
      drawer.innerHTML = '<div class="loading">No features match.</div>'
    }
    return
  }

  const worlds = _sortFeatureWorldsForDrawer(Array.from(tree.keys()), active)
  _ensureAutoExpandForFilter(q, worlds, tree, 'features',
    (w) => featureWorldMatches(w, active))
  const frag = document.createDocumentFragment()
  for (const world of worlds) {
    const catsMap = tree.get(world)
    const isActive = featureWorldMatches(world, active)
    const totalItems = Array.from(catsMap.values()).reduce((n, items) => n + items.length, 0)
    const worldKey = `features-world:${world}`
    const worldEl = _renderDrawerWorldGroup(worldKey, world, totalItems, isActive)
    const body = worldEl.querySelector('.drawer-group-body')
    for (const [categoryName, items] of catsMap) {
      const innerKey = `features-cat:${world}/${categoryName}`
      body.appendChild(_renderFeatureGroup(innerKey, categoryName, items, !isActive, usage))
    }
    frag.appendChild(worldEl)
  }
  drawer.replaceChildren(frag)
}

// _sortFeatureWorldsForDrawer mirrors sortWorldsForDrawer but uses
// featureWorldMatches so TDF world names ("Green World", "All Worlds")
// match the active tileset slug.
function _sortFeatureWorldsForDrawer(worlds, active) {
  return worlds.slice().sort((a, b) => {
    const aA = featureWorldMatches(a, active)
    const bA = featureWorldMatches(b, active)
    if (aA !== bA) return aA ? -1 : 1
    const aAll = /\ball worlds?\b/i.test(a) || /allworlds?/i.test(a)
    const bAll = /\ball worlds?\b/i.test(b) || /allworlds?/i.test(b)
    if (aAll !== bAll) return aAll ? -1 : 1
    return a.localeCompare(b)
  })
}

function _renderFeatureGroup(key, groupName, items, defaultCollapsed, usage) {
  const groupEl = document.createElement('div')
  groupEl.className = 'drawer-group'
  const collapsed = state.collapsedGroups.has(key) || (defaultCollapsed && !state._sectionExpanded?.has(key))
  if (collapsed) groupEl.classList.add('collapsed')

  const title = document.createElement('div')
  title.className = 'drawer-group-title'
  title.innerHTML = `<span class="chev">▾</span><span>${escapeHTML(groupName)}</span><span class="drawer-group-count">${items.length}</span>`
  title.addEventListener('click', () => _toggleGroup(key, defaultCollapsed))
  groupEl.appendChild(title)

  const body = _virtualisedDrawerBody(items.length, (el) => {
    const frag = document.createDocumentFragment()
    for (const f of items) frag.appendChild(_createFeatureItem(f, usage))
    el.appendChild(frag)
  })
  groupEl.appendChild(body)
  return groupEl
}

function _createFeatureItem(f, usage) {
  const item = document.createElement('div')
  item.className = 'drawer-item feature-item'
  item.draggable = true
  item.dataset.name = f.name
  if (state.selected?.type === 'feature' && state.selected.name === f.name) {
    item.classList.add('selected')
  }
  const fp = `${f.footprintX || 1}×${f.footprintZ || 1}`
  const useCount = usage ? (usage.get((f.name || '').toLowerCase()) || 0) : 0
  const usageBadge = useCount > 0 ? `<span class="usage-badge">${useCount}</span>` : ''
  // Tooltip — fall back to the bare name if every other field is blank.
  const tooltipParts = [f.name]
  if (f.world) tooltipParts.push(`World: ${f.world}`)
  if (f.category) tooltipParts.push(`Category: ${f.category}`)
  tooltipParts.push(`Footprint: ${fp}`)
  if (useCount > 0) tooltipParts.push(`Placed: ${useCount}`)
  if (f.description) tooltipParts.push(f.description)
  item.title = tooltipParts.join('\n')
  const staticUrl = f.previewUrl ? f.previewUrl + '?static=1' : null
  // 3DO spin previews are expensive APNGs — keep them static until hover even
  // when the global "Animate features" toggle is on, so the drawer stays snappy.
  // Spin (3DO) thumbnails stay static in the list; the rotating preview shows in
  // the expanded hover popup. GAF features still honour the Animate toggle.
  const wantAnimated = f.spin ? false : (state.animateFeatures || state.hoveredFeatureName === f.name)
  const initialUrl = wantAnimated ? f.previewUrl : staticUrl
  const thumb = f.previewUrl
    ? `<img class="drawer-thumb feature-thumb" src="${_apiUrl(initialUrl)}" data-animated="${f.previewUrl}" data-static="${staticUrl}" alt="" loading="lazy" draggable="false" />`
    : `<div class="drawer-thumb drawer-thumb-glyph">🌲</div>`
  item.innerHTML = `
    ${thumb}
    <div class="drawer-meta">
      <div class="drawer-name">${escapeHTML(f.name)}</div>
      <div class="drawer-sub">${fp} · ${escapeHTML(f.description || f.category || '')}</div>
    </div>
    ${usageBadge}
  `
  item.addEventListener('click', () => hostCallbacks.selectFeature?.(f))
  item.addEventListener('dragstart', (e) => hostCallbacks.beginFeatureDrag?.(e, f))
  item.addEventListener('mouseenter', () => {
    state.hoveredFeatureName = f.name
    state.highlightFeatureName = (f.name || '').toLowerCase()
    if (f.previewUrl) showFeatureHoverPreview(item, f)
    hostCallbacks.renderCanvas?.()
  })
  item.addEventListener('mouseleave', () => {
    if (state.hoveredFeatureName === f.name) state.hoveredFeatureName = null
    if (state.highlightFeatureName === (f.name || '').toLowerCase()) state.highlightFeatureName = null
    hideFeatureHoverPreview()
    hostCallbacks.renderCanvas?.()
  })
  return item
}
