// piece-tree.js
//
// React-rendered Pieces sidebar tab.  Renders the model's piece tree
// recursively — each piece becomes either a drawer-group (with
// children) or a drawer-item-piece (leaf).  Each row has the four
// status toggles the legacy tree shipped:
//
//   eye    — piece.visible + unit._pieceVisible[idx]
//   shade  — unit._pieceShade[idx]    (default on)
//   cache  — unit._pieceCache[idx]    (default off)
//   shadow — unit._pieceShadow[idx]   (default on)
//
// Plain-click cascades the new value to all descendants (matching the
// COB hide-cascade behaviour); shift-click suppresses the cascade for
// fine-grained edits.
//
// The component re-renders on every runtimeTick publish so the icons
// stay in sync with COB-driven changes (a Create script hiding a
// piece lights up the tree the same tick the opcode runs).
//
// Host integration via the bridge: setHoveredPieceName, selectPiece,
// requestRedraw.  Live unit + pieceMap come straight from the
// inspector-store's mv signal so the component doesn't reach into
// modelViewerInstance globally.

import { signal } from '@preact/signals'
import { useState } from 'preact/hooks'
import { htm as html } from '/ui/common/htm-bind.js'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'

// _model — the active unit's geometry (model.root piece tree).  Host
// sets this when a unit loads via setPieceTreeModel(); decoupled from
// inspector-store.mv because model is a different shape (geometry,
// not a cob proxy).
const _model = signal(null)
const _filter = signal('')

const _bridge = {
  setHoveredPieceName: (_name) => {},
  selectPiece:         (_name) => {},
  requestRedraw:       () => {},
}

export function configurePieceTreeBridge(impl) {
  Object.assign(_bridge, {
    setHoveredPieceName: (_name) => {},
    selectPiece:         (_name) => {},
    requestRedraw:       () => {},
  }, impl)
}

export function setPieceTreeModel(model) {
  _model.value = model || null
}

export function setPieceTreeFilter(q) {
  _filter.value = q || ''
}

// pieceDisplayName mirrors the legacy helper — humanises TA's "GP"
// alias for the ground-plate shadow polygon.
function pieceDisplayName(piece) {
  const name = piece.name || '<unnamed>'
  if (name === 'GP' || name === 'gp') return 'Ground Plate (GP)'
  return name
}

// _collapsed — set of piece names the user has folded.  Module-scoped
// so a tab swap and back keeps the unfold layout.
const _collapsed = new Set()

// FLAG_FIELDS — maps the chip glyph key to the CobUnit field that
// stores the per-piece flag.  Defaults: shade + shadow ON, cache OFF.
const FLAG_FIELDS = {
  shade:  { field: '_pieceShade',  glyph: '💡', titleOn: 'Shaded',       titleOff: 'Unshaded (dont-shade)' },
  cache:  { field: '_pieceCache',  glyph: '💾', titleOn: 'Cached',       titleOff: 'Not cached' },
  shadow: { field: '_pieceShadow', glyph: '🌗', titleOn: 'Casts shadow', titleOff: 'No shadow (dont-shadow)' },
}

// _flagValue reads the per-piece boolean for a flag.  Returns the
// stored value when present, otherwise the flag's default-on/off.
function _flagValue(unit, idx, flag) {
  const fld = FLAG_FIELDS[flag].field
  if (!unit || !unit[fld] || idx < 0) return flag !== 'cache'  // shade + shadow default ON, cache OFF
  const v = unit[fld][idx]
  return v === undefined ? (flag !== 'cache') : !!v
}

// _applyToPiece + descendants — writes the new value into the unit's
// per-piece flag array.  Used by both the eye toggle and the status
// chips; plain-click cascades, shift-click affects only this piece.
function _applyFlagCascade(piece, unit, pieceMap, flag, target, cascade) {
  if (!unit || !pieceMap) return
  const fld = FLAG_FIELDS[flag].field
  const apply = (p) => {
    const idx = pieceMap.get(p)
    if (typeof idx === 'number' && idx >= 0 && unit[fld]) unit[fld][idx] = target
    if (cascade) for (const c of p.children || []) apply(c)
  }
  apply(piece)
}

function _applyVisibleCascade(piece, unit, pieceMap, target, cascade) {
  const apply = (p) => {
    p.visible = target
    if (unit && pieceMap) {
      const idx = pieceMap.get(p)
      if (typeof idx === 'number' && idx >= 0 && unit._pieceVisible) {
        unit._pieceVisible[idx] = target
      }
    }
    if (cascade) for (const c of p.children || []) apply(c)
  }
  apply(piece)
}

function _primCount(piece, triMode, lineMode) {
  return piece.drawGroups.reduce((n, g) => {
    if (g.mode === triMode) return n + g.vertexCount / 3
    if (g.mode === lineMode) return n + g.vertexCount / 2
    return n + g.vertexCount
  }, 0)
}

export function PieceTree() {
  // Subscribe to runtimeTick so COB-driven flag changes flow into the
  // tree's icon state each refresh.
  void runtimeTick.value
  const proxy = mv.value
  const model = _model.value
  const filter = (_filter.value || '').trim().toLowerCase()
  const [, setTick] = useState(0)
  const bump = () => setTick((t) => t + 1)
  if (!model || !model.root) {
    return html`<div class="loading">No unit loaded.</div>`
  }
  const unit = proxy && proxy.cob && proxy.cob.unit ? proxy.cob.unit : null
  const pieceMap = proxy && proxy.cob && proxy.cob._pieceMap ? proxy.cob._pieceMap : null
  // Filter visibility — a piece is visible when it matches OR any
  // descendant matches (so collapsed groups still expose hits inside).
  const matches = (piece) => {
    if (!filter) return true
    if ((piece.name || '').toLowerCase().includes(filter)) return true
    return (piece.children || []).some(matches)
  }
  const triMode = 4   // gl.TRIANGLES — matches legacy renderer ID
  const lineMode = 1  // gl.LINES
  const setHover = (name) => _bridge.setHoveredPieceName(name)
  const clearHover = () => _bridge.setHoveredPieceName(null)
  const onSelect = (name) => _bridge.selectPiece(name)
  const onEyeClick = (piece) => (e) => {
    e.stopPropagation()
    const cascade = !e.shiftKey
    const target = !piece.visible
    _applyVisibleCascade(piece, unit, pieceMap, target, cascade)
    _bridge.requestRedraw()
    bump()
  }
  const onStatusClick = (piece, flag) => (e) => {
    e.stopPropagation()
    const myIdx = pieceMap ? pieceMap.get(piece) : -1
    if (typeof myIdx !== 'number' || myIdx < 0) return
    const cur = _flagValue(unit, myIdx, flag)
    const target = !cur
    const cascade = !e.shiftKey
    _applyFlagCascade(piece, unit, pieceMap, flag, target, cascade)
    bump()
  }
  const renderStatus = (piece, flag) => {
    const idx = pieceMap ? pieceMap.get(piece) : -1
    const on = _flagValue(unit, typeof idx === 'number' ? idx : -1, flag)
    const meta = FLAG_FIELDS[flag]
    return html`
      <button type="button"
              class=${'piece-status ' + (on ? 'on' : 'off')}
              data-flag=${flag}
              title=${on ? meta.titleOn : meta.titleOff}
              onClick=${onStatusClick(piece, flag)}>${meta.glyph}</button>
    `
  }
  const renderEye = (piece) => html`
    <button type="button"
            class=${'piece-eye' + (piece.visible ? '' : ' off')}
            title=${piece.visible ? 'Hide piece (Shift: this piece only)' : 'Show piece (Shift: this piece only)'}
            onClick=${onEyeClick(piece)}>${piece.visible ? '👁' : '⊘'}</button>
  `
  const build = (piece) => {
    if (!matches(piece)) return null
    const hasKids = (piece.children || []).length > 0
    const displayName = pieceDisplayName(piece)
    const primCount = _primCount(piece, triMode, lineMode)
    if (hasKids) {
      const isCollapsed = _collapsed.has(piece.name)
      return html`
        <div class=${'drawer-group drawer-piece-group' + (isCollapsed ? ' collapsed' : '')}
             data-piece=${piece.name}
             key=${piece.name}>
          <div class="drawer-group-title"
               onClick=${() => onSelect(piece.name)}
               onMouseEnter=${() => setHover(piece.name)}
               onMouseLeave=${clearHover}>
            <span class="chev"
                  onClick=${(e) => {
                    e.stopPropagation()
                    if (isCollapsed) _collapsed.delete(piece.name)
                    else _collapsed.add(piece.name)
                    bump()
                  }}>▾</span>
            <span class="piece-name">${displayName}</span>
            ${piece.isEmitterPoint ? html`
              <span class="piece-emitter" title="Vertex-only piece (smoke / explosion anchor)">✦</span>
            ` : null}
            <span class="drawer-group-count">${Math.round(primCount)} prim</span>
            ${renderEye(piece)}
            ${renderStatus(piece, 'shade')}
            ${renderStatus(piece, 'cache')}
            ${renderStatus(piece, 'shadow')}
          </div>
          <div class="drawer-group-body">
            ${piece.children.map((c) => build(c))}
          </div>
        </div>
      `
    }
    return html`
      <div class="drawer-item-piece"
           data-piece=${piece.name}
           key=${piece.name}
           onClick=${() => onSelect(piece.name)}
           onMouseEnter=${() => setHover(piece.name)}
           onMouseLeave=${clearHover}>
        <span class="piece-name">${displayName}</span>
        ${piece.isEmitterPoint ? html`
          <span class="piece-emitter" title="Vertex-only piece (smoke / explosion anchor)">✦</span>
        ` : null}
        <span class="piece-stat">${Math.round(primCount)} prim</span>
        ${renderEye(piece)}
        ${renderStatus(piece, 'shade')}
        ${renderStatus(piece, 'cache')}
        ${renderStatus(piece, 'shadow')}
      </div>
    `
  }
  return build(model.root)
}
