// split-container.js
//
// Generic recursive split-pane container for the studio's per-tab
// viewport region.  Each tab (sandbox / unit viewer / map editor)
// owns a tree of nested horizontal + vertical splits, with a leaf
// at every terminus that hosts whatever viewport the host wants to
// render there.  The tree shape is the SOURCE OF TRUTH; layout is
// pure flexbox driven from `ratio` per split node.
//
// The component is intentionally side-effect free with respect to
// content: it knows nothing about what a "leaf" actually renders.
// The caller passes a `renderLeaf(leafId)` callback that returns
// whatever JSX should fill the cell.  This keeps the split engine
// free of any host-app imports — it sits as a peer of
// floating-panel + accordion-section in @kbot/ui, and the same
// component can host a 3DO viewer in one tab, a map editor in the
// next, and a sandbox runtime in a third.
//
// Persistence is deliberately LEFT OUT for this first cut: split
// trees live in the per-tab state owned by the host (so closing
// and re-opening a tab can keep its layout via the tab registry's
// own preference store, the same way unit-editor + map-editor
// already persist their toolbar+drawer state).  Wiring the tree
// into panel-store would be wrong — splits are not chrome around
// a single panel id, they're a recursive structure with synthetic
// leaf ids that come and go as the user splits + closes panes.
// If we want cross-reload persistence later, the host serialises
// `tree` into its existing prefs blob.  This file stays pure.
//
// The tree-mutation helpers (splitLeaf / closeLeaf / leafIds /
// isOnlyLeaf) are named exports so context-menu handlers can drive
// the tree imperatively without round-tripping through component
// state: the host calls splitLeaf, gets a new tree, and pushes it
// back via setState / onTreeChange.  This mirrors how a redux-style
// reducer would work without the reducer plumbing.

import { useEffect, useRef } from 'preact/hooks'
import { htm as html } from './htm-bind.js'

// ── Tree model ───────────────────────────────────────────────────────
//
//   type Node =
//     | { kind: 'leaf',  id: string }
//     | { kind: 'split', orient: 'h' | 'v', ratio: number,
//         a: Node, b: Node }
//
// orient='h' means the split is HORIZONTAL in the side-by-side sense
// — two columns separated by a vertical divider.  orient='v' is the
// stacked case — two rows separated by a horizontal divider.  Naming
// after the divider's effect on the layout rather than the divider's
// own axis would have been the other valid choice; we went with the
// orient-of-the-pair convention because it matches the way users
// describe the gesture ("split this horizontally" → side-by-side).
//
// `ratio` is the first child's fraction of the available space
// (0..1).  CSS flex-basis percentages handle the actual sizing so a
// resized parent re-distributes proportionally without any JS.

// _leafIdSeq — monotonically increasing counter so freshly-created
// leaves have unique ids.  Module-level so re-mounts of the
// container don't reuse ids that the caller may still be tracking
// in its own state.  Prefixed `leaf-` so the id is recognisable in
// dev tools without colliding with any host-supplied id format.
let _leafIdSeq = 1
function _nextLeafId() {
  return `leaf-${_leafIdSeq++}`
}

// newLeaf — convenience constructor for callers building an initial
// tree.  Exposed so the host doesn't have to know the leaf-id format.
export function newLeaf(id = null) {
  return { kind: 'leaf', id: id || _nextLeafId() }
}

// leafIds — depth-first, left-to-right traversal of the tree.  Used
// by the host to enumerate every viewport slot (e.g. to find the one
// whose context menu was just opened, or to garbage-collect any
// per-leaf state the host keeps in a Map keyed by leaf id).
export function leafIds(tree) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.kind === 'leaf') { out.push(n.id); return }
    walk(n.a)
    walk(n.b)
  }
  walk(tree)
  return out
}

// isOnlyLeaf — true when `leafId` is the sole leaf in the entire
// tree.  The context-menu's "Close Pane" entry checks this so it can
// disable itself instead of failing silently when there's nothing
// left to collapse into.
export function isOnlyLeaf(tree, leafId) {
  const ids = leafIds(tree)
  return ids.length === 1 && ids[0] === leafId
}

// splitLeaf — return a NEW tree where the named leaf has been
// replaced by a split node.  The old leaf stays as one child; a
// fresh leaf becomes the other.  `newSide` controls which side the
// new pane appears on:
//   newSide='b' (default) — new pane goes BELOW (orient='v') or
//                           to the RIGHT (orient='h') of the source
//   newSide='a'           — new pane goes ABOVE or to the LEFT
// The 'b' default matches the way most editors handle "split down" /
// "split right" — the existing focus stays put, the new pane appears
// in fresh space the user has to consciously move into.
//
// We always reach for fresh objects rather than mutating in place.
// The tree gets passed through Preact's signal/setState plumbing, so
// the equality check that drives re-render needs a fresh root.
export function splitLeaf(tree, leafId, orient, newSide = 'b') {
  if (orient !== 'h' && orient !== 'v') {
    throw new Error(`splitLeaf: orient must be 'h' or 'v', got ${orient}`)
  }
  if (newSide !== 'a' && newSide !== 'b') {
    throw new Error(`splitLeaf: newSide must be 'a' or 'b', got ${newSide}`)
  }
  const fresh = newLeaf()
  const replace = (n) => {
    if (!n) return n
    if (n.kind === 'leaf') {
      if (n.id !== leafId) return n
      return {
        kind: 'split',
        orient,
        ratio: 0.5,
        a: newSide === 'a' ? fresh : n,
        b: newSide === 'a' ? n : fresh,
      }
    }
    // split node — recurse into both children.  We rebuild the node
    // even when neither child changes; cheap, and keeps the code
    // free of a stale-reference branch.
    return {
      kind: 'split',
      orient: n.orient,
      ratio: n.ratio,
      a: replace(n.a),
      b: replace(n.b),
    }
  }
  return replace(tree)
}

// closeLeaf — remove the named leaf from the tree.  Its sibling
// collapses up into the slot the parent split occupied, so the tree
// stays minimal (no redundant single-child split nodes).  If the
// caller asks to close the only leaf in the tree we return the tree
// unchanged — the caller can re-check beforehand via isOnlyLeaf, but
// the no-op fallback means a stale double-click doesn't blow the
// component up.
export function closeLeaf(tree, leafId) {
  if (!tree) return tree
  if (tree.kind === 'leaf') {
    // Root is a leaf — either it's the one we're closing (last pane,
    // refuse) or it's a different id (no such leaf, return as-is).
    return tree
  }
  // Helper that returns either the rewritten subtree or the sentinel
  // `null` to mean "this subtree should be removed; promote the
  // sibling up".  The parent split is responsible for handling the
  // sentinel — when one child returns null the parent collapses
  // into the other child.
  const REMOVE = Symbol('remove')
  const walk = (n) => {
    if (!n) return n
    if (n.kind === 'leaf') {
      return n.id === leafId ? REMOVE : n
    }
    const a = walk(n.a)
    const b = walk(n.b)
    if (a === REMOVE && b === REMOVE) {
      // Two leaves with the same id under one split shouldn't happen
      // (we mint unique ids on every split + initial mount), but if
      // the host ever hands us a malformed tree we collapse to REMOVE
      // and let the level above decide what to do.
      return REMOVE
    }
    if (a === REMOVE) return b
    if (b === REMOVE) return a
    if (a === n.a && b === n.b) return n  // unchanged — preserve identity
    return { kind: 'split', orient: n.orient, ratio: n.ratio, a, b }
  }
  const next = walk(tree)
  if (next === REMOVE) {
    // Caller asked to close the root + only leaf.  Return the
    // original tree so the layout stays valid.
    return tree
  }
  return next
}

// ── Component ────────────────────────────────────────────────────────
//
// Renders the tree recursively.  Each split node lays out two
// children + a draggable divider; leaves wrap the host-supplied
// content in a stable `.mv-split-leaf` shell so CSS can target every
// cell consistently regardless of what the host renders inside.

// _MIN_LEAF_PX_DEFAULT — fallback minimum pane size.  Both halves of
// a split must remain at least this many CSS pixels wide/tall during
// a divider drag, so the user can't accidentally crush a pane to
// zero and lose access to its context menu.
const _MIN_LEAF_PX_DEFAULT = 120

// _clampRatio — keep a divider ratio inside [0, 1] while honouring
// the per-side minimum size.  Returns the clamped ratio; the caller
// applies it to flex-basis.
function _clampRatio(ratio, sizePx, minPx) {
  if (sizePx <= 0) return ratio
  const minFrac = minPx / sizePx
  const lo = minFrac
  const hi = 1 - minFrac
  if (lo >= hi) return 0.5            // pane too small to honour both
                                       // minimums — split down the middle
                                       // and let the user resize the
                                       // outer container.
  if (ratio < lo) return lo
  if (ratio > hi) return hi
  return ratio
}

// SplitContainer — root component.  Props:
//   tree           — the current Node tree (required).
//   onTreeChange   — callback fired with the new tree when a divider
//                    drag commits a new ratio.  Optional; if absent
//                    the divider drag is a no-op (still useful for
//                    static previews).
//   renderLeaf     — required.  `(leafId) => <preact node>` — the
//                    host renders whatever should fill the cell.
//   minLeafPx      — minimum pane size in CSS px (default 120).  Used
//                    by the divider clamp; the caller can lower this
//                    for editors that legitimately want narrow rails
//                    or raise it for editors with wide chrome.
export function SplitContainer({ tree, onTreeChange = null, renderLeaf, minLeafPx = _MIN_LEAF_PX_DEFAULT }) {
  if (!tree) return null
  // The root needs a wrapper that fills its parent + sets up the
  // flex context for the first level of children.  Inner splits
  // recurse into _SplitNode which renders its own .mv-split-* shell.
  return html`
    <div class="mv-split-root">
      <${_SplitNode}
        node=${tree}
        path=${[]}
        tree=${tree}
        onTreeChange=${onTreeChange}
        renderLeaf=${renderLeaf}
        minLeafPx=${minLeafPx} />
    </div>
  `
}

// _SplitNode — recursive renderer.  `path` is the chain of 'a'/'b'
// steps from the root to this node, used by the divider drag to
// rewrite the tree at exactly the right depth without an id lookup.
function _SplitNode({ node, path, tree, onTreeChange, renderLeaf, minLeafPx }) {
  if (node.kind === 'leaf') {
    return html`
      <div class="mv-split-leaf" data-leaf-id=${node.id}>
        ${renderLeaf ? renderLeaf(node.id) : null}
      </div>
    `
  }
  // Split node — render both children, with a divider in between
  // sized to whatever the current ratio dictates.  flex-basis on
  // each pane keeps the proportions stable when the outer container
  // resizes.
  const orient = node.orient
  const ratio = node.ratio
  const aBasis = (ratio * 100).toFixed(4) + '%'
  const bBasis = ((1 - ratio) * 100).toFixed(4) + '%'
  const containerCls = orient === 'h' ? 'mv-split-h' : 'mv-split-v'
  const dividerCls = orient === 'h' ? 'mv-split-divider mv-split-divider-h'
                                    : 'mv-split-divider mv-split-divider-v'
  const containerRef = useRef(null)

  // Divider drag — write directly to the DOM while the pointer
  // moves (same jitter-free pattern floating-panel uses), then
  // commit a single onTreeChange on mouseup so the host doesn't see
  // 60 Hz of state updates.  The drag start captures the parent
  // rect + the starting ratio; mousemove recomputes against the
  // captured rect so a layout change mid-drag (rare, but possible
  // if the host opens a panel) doesn't pull the cursor off the bar.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const divider = container.querySelector(`:scope > .mv-split-divider`)
    if (!divider) return
    let dragState = null
    const onDown = (e) => {
      if (e.button !== 0) return  // ignore right + middle clicks
      e.preventDefault()
      const rect = container.getBoundingClientRect()
      dragState = {
        rect,
        startRatio: ratio,
        startPx: orient === 'h' ? e.clientX : e.clientY,
        sizePx:  orient === 'h' ? rect.width : rect.height,
      }
      divider.classList.add('dragging')
    }
    const onMove = (e) => {
      if (!dragState) return
      const cur = orient === 'h' ? e.clientX : e.clientY
      const delta = cur - dragState.startPx
      const nextRatio = _clampRatio(
        dragState.startRatio + delta / dragState.sizePx,
        dragState.sizePx,
        minLeafPx,
      )
      // Imperatively update flex-basis on the two panes so the drag
      // tracks the cursor without waiting for a Preact re-render.
      // The eventual onTreeChange commit will trigger a real render
      // with the same values, so there's no flash on release.
      const panes = container.querySelectorAll(':scope > .mv-split-pane')
      if (panes.length >= 2) {
        panes[0].style.flexBasis = (nextRatio * 100).toFixed(4) + '%'
        panes[1].style.flexBasis = ((1 - nextRatio) * 100).toFixed(4) + '%'
      }
      dragState.lastRatio = nextRatio
    }
    const onUp = () => {
      if (!dragState) return
      divider.classList.remove('dragging')
      const finalRatio = (typeof dragState.lastRatio === 'number')
        ? dragState.lastRatio
        : dragState.startRatio
      dragState = null
      if (onTreeChange && finalRatio !== ratio) {
        onTreeChange(_setRatioAt(tree, path, finalRatio))
      }
    }
    divider.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      divider.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [tree, ratio, orient, minLeafPx, onTreeChange, path])

  return html`
    <div ref=${containerRef} class=${`mv-split-pane-row ${containerCls}`}>
      <div class="mv-split-pane" style=${`flex-basis: ${aBasis};`}>
        <${_SplitNode}
          node=${node.a}
          path=${[...path, 'a']}
          tree=${tree}
          onTreeChange=${onTreeChange}
          renderLeaf=${renderLeaf}
          minLeafPx=${minLeafPx} />
      </div>
      <div class=${dividerCls} />
      <div class="mv-split-pane" style=${`flex-basis: ${bBasis};`}>
        <${_SplitNode}
          node=${node.b}
          path=${[...path, 'b']}
          tree=${tree}
          onTreeChange=${onTreeChange}
          renderLeaf=${renderLeaf}
          minLeafPx=${minLeafPx} />
      </div>
    </div>
  `
}

// _setRatioAt — return a new tree with the split at `path` updated to
// the given ratio.  Path is the chain of 'a'/'b' steps from the
// root.  Used by the divider drag commit to avoid scanning the tree
// for a matching node — the path is known by construction.
function _setRatioAt(tree, path, ratio) {
  if (path.length === 0) {
    if (tree.kind !== 'split') return tree
    return { ...tree, ratio }
  }
  if (tree.kind !== 'split') return tree
  const head = path[0]
  const rest = path.slice(1)
  if (head === 'a') {
    return { ...tree, a: _setRatioAt(tree.a, rest, ratio) }
  }
  if (head === 'b') {
    return { ...tree, b: _setRatioAt(tree.b, rest, ratio) }
  }
  return tree
}
