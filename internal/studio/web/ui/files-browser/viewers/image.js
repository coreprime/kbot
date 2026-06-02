// image.js
//
// Viewers for the single-image formats:
//   - PCX           : server-converted to PNG (optionally re-palettised).
//   - native images : png/jpg/gif/bmp served raw to the browser.
// A checkerboard backing makes transparency obvious, and a zoom toggle
// flips between fit-to-pane and 1:1 pixel-doubled inspection.

import { htm as html } from '@kbot/ui/htm-bind'
import { useState } from 'preact/hooks'
import { pcxURL, rawURL, imageURL } from '../api.js'

function Stage({ src, alt, describe }) {
  const [zoom, setZoom] = useState(false)
  const dims = describe && describe.width
    ? html`<span class="fx-img-dims">${describe.width}×${describe.height}${describe.bitsPerPixel ? ` · ${describe.bitsPerPixel}bpp` : ''}</span>`
    : null
  return html`
    <div class="fx-viewer">
      <div class="fx-ctl-row">
        <button type="button" class=${'fx-ctl-btn' + (zoom ? ' active' : '')} onClick=${() => setZoom(!zoom)}>${zoom ? '1:1 pixels' : 'Fit'}</button>
        ${dims}
      </div>
      <div class=${'fx-img-stage' + (zoom ? ' pixel' : '')}><img class="fx-img" src=${src} alt=${alt} /></div>
    </div>
  `
}

export function PcxViewer({ path, describe, source }) {
  return html`<${Stage} src=${pcxURL(path, '', source)} alt=${path} describe=${describe} />`
}

export function NativeImageViewer({ path, source }) {
  return html`<${Stage} src=${rawURL(path, source)} alt=${path} />`
}

// FontSheet renders the FNT glyph sheet plus a few headline facts.
export function FontViewer({ path, describe, source }) {
  const d = describe || {}
  return html`
    <div class="fx-viewer">
      <div class="fx-ctl-row">
        ${d.glyphCount != null ? html`<span class="fx-img-dims">${d.glyphCount} glyphs · ${d.height}px tall</span>` : null}
      </div>
      <div class="fx-img-stage"><img class="fx-img" src=${imageURL(path, 'png', source)} alt=${path} /></div>
    </div>
  `
}
