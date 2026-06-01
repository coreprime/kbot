// palette-grid.js
//
// Renders a TA palette as a grid of colour swatches driven by the PAL
// describer's `colors` array (index + #RRGGBB hex per entry).  Each
// swatch carries a tooltip with its index and hex so the user can read
// off palette positions — handy when picking a transparency index for a
// GAF render.

import { htm as html } from '/ui/common/htm-bind.js'

export function PaletteGrid({ colors }) {
  if (!colors || !colors.length) {
    return html`<div class="files-preview-empty">No palette entries</div>`
  }
  return html`
    <div class="files-pal-grid">
      ${colors.map((c) => html`
        <div class="files-pal-swatch"
             style=${`background:${c.hex}`}
             title=${`#${c.index} · ${c.hex}`}></div>
      `)}
    </div>
  `
}
