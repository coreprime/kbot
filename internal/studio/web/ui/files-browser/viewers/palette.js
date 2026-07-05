// palette.js
//
// Palette viewer: a 16-wide grid of colour swatches with a hover/selected
// detail readout (index + hex).  The describe doc carries the colours as
// { index, hex } entries.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { useState } from 'preact/hooks'

export function PaletteViewer({ describe }) {
  const colors = (describe && describe.colors) || []
  const [sel, setSel] = useState(0)
  if (!colors.length) return html`<div class="fx-empty">No palette entries</div>`
  const cur = colors[sel] || colors[0]
  return html`
    <div class="fx-palette">
      <div class="fx-pal-head">
        <span class="fx-pal-big" style=${`background:${cur.hex}`}></span>
        <div class="fx-pal-meta">
          <div class="fx-pal-idx">Index ${cur.index}</div>
          <div class="fx-pal-hex">${cur.hex}</div>
          <div class="fx-pal-count">${colors.length} colours</div>
        </div>
      </div>
      <div class="fx-pal-grid">
        ${colors.map((c, i) => html`
          <button type="button" key=${c.index}
                  class=${'fx-pal-swatch' + (i === sel ? ' active' : '')}
                  style=${`background:${c.hex}`} title=${`#${c.index} ${c.hex}`}
                  onClick=${() => setSel(i)}></button>
        `)}
      </div>
    </div>
  `
}
