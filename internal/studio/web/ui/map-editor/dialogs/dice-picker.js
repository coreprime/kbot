// dice-picker.js
//
// Dice-face player-count picker used inside the New-map size
// dialog.  Selecting multiple counts seeds that many Network N
// schemas when the editor starts.  At least one count must stay
// selected so the editor always has a schema to render.
//
// Module-local state:
//   - dicePicked: Set<number> of currently-selected player counts
//     (default: {8}).  Reset by external callers via the
//     setDicePicked() / getDicePicked() accessors.
//
// Also exports populateWorldSelect, which is the planet/tileset
// <select> populator the size dialog AND the OTA properties
// dialog both call — same WORLDS table, different `value` shape
// (slug vs default-tileset string).

import { $ } from '../../host-context.js'
import {
  DICE_PLAYER_COUNTS,
  DICE_PIP_POSITIONS,
  WORLDS,
} from '../constants.js'
import { playerCountLabel } from '../helpers.js'

const dicePicked = new Set([8]) // sensible default — a single 8-player schema

// pickedPlayerCounts returns the current selection sorted
// ascending, falling back to [4] if somehow nothing is selected.
// Used by startEditor to seed schemas at File → New time.
export function pickedPlayerCounts() {
  const sorted = Array.from(dicePicked).sort((a, b) => a - b)
  return sorted.length > 0 ? sorted : [4]
}

// populateWorldSelect rewrites a <select>'s options from the
// WORLDS table.  `valueKind` picks whether the option value is
// the slug (matches state.planet — used by the New-map picker)
// or the default-tileset string (matches .ota.planet — used by
// the Properties dialog).  Called once at boot for each picker.
export function populateWorldSelect(el, valueKind) {
  if (!el) return
  el.replaceChildren(...WORLDS.map((t) => {
    const opt = document.createElement('option')
    opt.value = valueKind === 'slug' ? t.slug : t.defaultTileset
    opt.textContent = t.label
    return opt
  }))
}

export function renderDiceGrid() {
  const grid = $('#size-dice-grid')
  if (!grid) return
  const frag = document.createDocumentFragment()
  for (const n of DICE_PLAYER_COUNTS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'dice-face' + (dicePicked.has(n) ? ' selected' : '')
    btn.dataset.count = String(n)
    btn.title = `${playerCountLabel(n)} (Network ${n})`
    const art = document.createElement('div')
    art.className = 'dice-face-art'
    art.appendChild(buildDicePips(n))
    btn.appendChild(art)
    const caption = document.createElement('span')
    caption.className = 'dice-caption'
    caption.textContent = playerCountLabel(n)
    btn.appendChild(caption)
    btn.addEventListener('click', () => {
      if (dicePicked.has(n)) {
        if (dicePicked.size <= 1) return // keep at least one selected
        dicePicked.delete(n)
      } else {
        dicePicked.add(n)
      }
      renderDiceGrid()
    })
    frag.appendChild(btn)
  }
  grid.replaceChildren(frag)
}

// buildDicePips returns a domino-style face with exactly N
// pips.  Pips are absolutely positioned (in % within the 44px
// art square) so we don't run into the 4×4-grid problem where
// the centre dot needs 4 cells to look centred and the count
// ends up wrong.
function buildDicePips(n) {
  const wrap = document.createElement('div')
  wrap.className = 'dice-pips'
  const positions = DICE_PIP_POSITIONS[n] || []
  for (const [px, py] of positions) {
    const dot = document.createElement('span')
    dot.style.left = (px * 100) + '%'
    dot.style.top = (py * 100) + '%'
    wrap.appendChild(dot)
  }
  return wrap
}
