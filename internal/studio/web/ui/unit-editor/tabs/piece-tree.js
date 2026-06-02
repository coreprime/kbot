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
import { useState, useEffect, useRef } from 'preact/hooks'
import { htm as html } from '@kbot/ui/htm-bind'
import { mv, runtimeTick } from '/ui/common/inspector-store.js'
import { TA_TURNS_PER_CIRCLE } from '/engine/cob-opcodes.js'

// _model — the active unit's geometry (model.root piece tree).  Host
// sets this when a unit loads via setPieceTreeModel(); decoupled from
// inspector-store.mv because model is a different shape (geometry,
// not a cob proxy).
const _model = signal(null)
const _filter = signal('')

const _bridge = {
  setHoveredPieceName: (_name) => {},
  selectPiece:         (_name) => {},
  // rotatePiece(name, axis, deg) — set ABSOLUTE rotation on one axis (degrees,
  // 0-360° = full TA turn).  getPieceRotation(name) → [x, y, z] degrees.
  rotatePiece:         (_name, _axis, _deg) => {},
  getPieceRotation:    (_name) => [0, 0, 0],
  requestRedraw:       () => {},
}

export function configurePieceTreeBridge(impl) {
  Object.assign(_bridge, {
    setHoveredPieceName: (_name) => {},
    selectPiece:         (_name) => {},
    rotatePiece:         (_name, _axis, _deg) => {},
    getPieceRotation:    (_name) => [0, 0, 0],
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

// AxisDial — one circular dial for a single rotation axis.  0° sits at the top
// and increases clockwise; the full ring is 0-360° mapped onto the complete TA
// rotation arc.  Drag the knob (or edit the number) to set the angle; every
// change fires onChange(deg) so the host can write the piece pose live.
function AxisDial({ label, deg, onChange }) {
  const ref = useRef(null)
  const R = 24, C = 30
  const a = ((deg - 90) * Math.PI) / 180
  const hx = C + R * Math.cos(a)
  const hy = C + R * Math.sin(a)
  // Game-units readout — TA stores rotations as a 65536-per-circle fixed-point
  // angle, so this is the value a COB turn/get-angle opcode actually works in.
  const units = Math.round((((deg % 360) + 360) % 360) / 360 * TA_TURNS_PER_CIRCLE)
  const pick = (e) => {
    const svg = ref.current
    if (!svg) return
    const r = svg.getBoundingClientRect()
    const x = e.clientX - r.left - C
    const y = e.clientY - r.top - C
    let d = (Math.atan2(y, x) * 180) / Math.PI + 90
    d = ((d % 360) + 360) % 360
    onChange(d)
  }
  const onDown = (e) => {
    e.preventDefault()
    e.stopPropagation()
    pick(e)
    const move = (ev) => pick(ev)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return html`
    <div class="rot-dial">
      <svg ref=${ref} class="rot-dial-svg" width="60" height="60" viewBox="0 0 60 60"
           onPointerDown=${onDown}>
        <circle class="rot-dial-ring" cx="30" cy="30" r=${R} />
        <line class="rot-dial-needle" x1="30" y1="30" x2=${hx.toFixed(2)} y2=${hy.toFixed(2)} />
        <circle class="rot-dial-knob" cx=${hx.toFixed(2)} cy=${hy.toFixed(2)} r="4" />
      </svg>
      <div class="rot-dial-meta">
        <span class="rot-dial-axis">${label}</span>
        <input class="rot-dial-num" type="number" min="0" max="360" step="1" value=${deg}
               onInput=${(e) => onChange(parseInt(e.currentTarget.value, 10) || 0)} />
        <span class="rot-dial-deg">°</span>
      </div>
      <div class="rot-dial-units" title="TA game units (65536 = full turn)">${units} ta</div>
    </div>
  `
}

// RotateDials — the 3-axis rotation widget opened from a piece row's rotate
// chip.  Seeds from the piece's live pose, then writes each axis back through
// the bridge as the user drags.  Docked at the top of the tree so it shows in
// a consistent place and never reflows the rows.
function RotateDials({ name, onClose }) {
  // Read the piece's LIVE rotation straight from the engine every render, and
  // subscribe to runtimeTick so a script-driven rotation (turret aim, spin,
  // build pose) updates the dials in real time while the panel is open.  A
  // local force() bump re-renders immediately while the user drags so the
  // needle tracks the pointer without waiting for the next tick.
  void runtimeTick.value
  const [, force] = useState(0)
  const deg = _bridge.getPieceRotation(name) || [0, 0, 0]
  const set = (axis, v) => {
    const nv = ((Math.round(v) % 360) + 360) % 360
    _bridge.rotatePiece(name, axis, nv)
    force((t) => t + 1)
  }
  const reset = () => {
    for (let i = 0; i < 3; i++) _bridge.rotatePiece(name, i, 0)
    force((t) => t + 1)
  }
  return html`
    <div class="rot-dials">
      <div class="rot-dials-head">
        <span class="rot-dials-title" title=${name}>Rotate · ${name}</span>
        <button type="button" class="rot-dials-close" title="Deselect piece" onClick=${onClose}>✕</button>
      </div>
      <div class="rot-dials-row">
        <${AxisDial} label="X" deg=${deg[0]} onChange=${(v) => set(0, v)} />
        <${AxisDial} label="Y" deg=${deg[1]} onChange=${(v) => set(1, v)} />
        <${AxisDial} label="Z" deg=${deg[2]} onChange=${(v) => set(2, v)} />
      </div>
      <button type="button" class="rot-dials-reset" onClick=${reset}>Reset to 0°</button>
    </div>
  `
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
  // selPiece — name of the currently-selected piece.  Drives the row
  // highlight + the docked rotate footer at the bottom of the sidebar.
  const [selPiece, setSelPiece] = useState(null)
  // Clear the selection when a different unit loads so the footer never shows
  // a stale piece name from the previous model.
  useEffect(() => { setSelPiece(null) }, [model])
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
  const onSelect = (name) => { setSelPiece(name); _bridge.selectPiece(name) }
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
          <div class=${'drawer-group-title' + (selPiece === piece.name ? ' selected' : '')}
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
            <span class="piece-row-meta">
              <span class="drawer-group-count">${Math.round(primCount)} prim</span>
              ${renderEye(piece)}
              ${renderStatus(piece, 'shade')}
              ${renderStatus(piece, 'cache')}
              ${renderStatus(piece, 'shadow')}
            </span>
          </div>
          <div class="drawer-group-body">
            ${piece.children.map((c) => build(c))}
          </div>
        </div>
      `
    }
    return html`
      <div class=${'drawer-item-piece' + (selPiece === piece.name ? ' selected' : '')}
           data-piece=${piece.name}
           key=${piece.name}
           onClick=${() => onSelect(piece.name)}
           onMouseEnter=${() => setHover(piece.name)}
           onMouseLeave=${clearHover}>
        <span class="piece-name">${displayName}</span>
        ${piece.isEmitterPoint ? html`
          <span class="piece-emitter" title="Vertex-only piece (smoke / explosion anchor)">✦</span>
        ` : null}
        <span class="piece-row-meta">
          <span class="piece-stat">${Math.round(primCount)} prim</span>
          ${renderEye(piece)}
          ${renderStatus(piece, 'shade')}
          ${renderStatus(piece, 'cache')}
          ${renderStatus(piece, 'shadow')}
        </span>
      </div>
    `
  }
  // The selected piece still has to exist in the live model for the footer to
  // make sense (guards against a stale name across a filter/model change).
  const selValid = selPiece && (model.flat
    ? model.flat.some((p) => p.name === selPiece)
    : true)
  return html`
    <div class="piece-tree-root">
      <div class="piece-tree-scroll">
        ${build(model.root)}
      </div>
      ${selValid
        ? html`<${RotateDials} name=${selPiece} onClose=${() => setSelPiece(null)} />`
        : null}
    </div>
  `
}
