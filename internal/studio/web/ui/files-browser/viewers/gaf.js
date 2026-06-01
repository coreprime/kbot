// gaf.js
//
// GAF viewer: every sequence in one scrollable list of accordions.  A
// collapsed row shows the animated thumbnail, name, frame count, and
// download links; expanding reveals the full-size animation plus a
// per-frame table (size, origin, transparency, duration, a hoverable
// still, and a download).  A transparency control at the top re-renders
// every preview without a round-trip to a separate page.

import { htm as html } from '/ui/common/htm-bind.js'
import { useState } from 'preact/hooks'
import { gafPngURL, gafApngURL, gafGifURL, baseName } from '../api.js'

function hideBroken(e) { e.target.style.visibility = 'hidden' }

// stemOf strips the extension off a path's filename so exported frames
// can be named after the source GAF (acidbrief.gaf → "acidbrief").
function stemOf(path) {
  const b = baseName(path) || 'gaf'
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(0, i) : b
}

// safeName reduces a sequence name to filename-safe characters so the
// browser's download attribute yields a clean, predictable filename.
function safeName(s) { return String(s || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'seq' }

function SequenceAccordion({ path, seq, index, transparency }) {
  const [open, setOpen] = useState(index === 0)
  const frames = seq.frames || []
  const first = frames[0]
  const stem = stemOf(path)
  const seqName = safeName(seq.name || `seq${index}`)
  return html`
    <div class=${'fx-gaf-acc' + (open ? ' open' : '')}>
      <div class="fx-gaf-acc-head" onClick=${() => setOpen(!open)}>
        <span class="fx-gaf-caret">${open ? '▾' : '▸'}</span>
        <img class="fx-gaf-thumb" loading="lazy" onError=${hideBroken}
             src=${gafApngURL(path, index, '', transparency)} alt=${seq.name} />
        <div class="fx-gaf-acc-info">
          <span class="fx-gaf-name">${seq.name || `Sequence ${index}`}</span>
          <span class="fx-gaf-meta">${frames.length} frame${frames.length !== 1 ? 's' : ''}${first ? ` · ${first.width}×${first.height}` : ''}</span>
        </div>
        <div class="fx-gaf-acc-actions" onClick=${(e) => e.stopPropagation()}>
          <a class="fx-dl" download=${`${stem}_${seqName}.gif`} href=${gafGifURL(path, index, '', transparency)} title="Download GIF">⬇ GIF</a>
          <a class="fx-dl" download=${`${stem}_${seqName}.png`} href=${gafApngURL(path, index, '', transparency)} title="Download APNG">⬇ APNG</a>
        </div>
      </div>
      ${open ? html`
        <div class="fx-gaf-acc-body">
          <div class="fx-gaf-preview"><img onError=${hideBroken} src=${gafApngURL(path, index, '', transparency)} alt=${seq.name} /></div>
          ${frames.length ? html`
            <div class="fx-frame-table-wrap">
              <table class="fx-frame-table">
                <thead><tr><th>#</th><th>Size</th><th>Origin</th><th>Transp.</th><th>Duration</th><th>Preview</th><th></th></tr></thead>
                <tbody>
                  ${frames.map((f) => html`
                    <tr key=${f.index}>
                      <td>${f.index}</td>
                      <td>${f.width}×${f.height}</td>
                      <td>${f.originX}, ${f.originY}</td>
                      <td>${f.transparency ?? '—'}</td>
                      <td>${f.duration}</td>
                      <td><img class="fx-frame-thumb" loading="lazy" onError=${hideBroken}
                               src=${gafPngURL(path, index, f.index, '', transparency)} alt=${'Frame ' + f.index} /></td>
                      <td><a class="fx-frame-dl" download=${`${stem}_${seqName}_f${f.index}.png`} href=${gafPngURL(path, index, f.index, '', transparency)} title="Download PNG">⬇</a></td>
                    </tr>
                  `)}
                </tbody>
              </table>
            </div>
          ` : null}
        </div>
      ` : null}
    </div>
  `
}

export function GafViewer({ path, describe }) {
  const sequences = (describe && describe.sequences) || []
  const [transparency, setTransparency] = useState('')
  if (!sequences.length) return html`<div class="fx-empty">🎨 No sequences in this GAF file</div>`
  const totalFrames = sequences.reduce((n, s) => n + ((s.frames && s.frames.length) || 0), 0)
  return html`
    <div class="fx-gaf">
      <div class="fx-gaf-toolbar">
        <span class="fx-gaf-summary">${sequences.length} sequence${sequences.length !== 1 ? 's' : ''} · ${totalFrames} frames</span>
        <label class="fx-ctl">
          <span class="fx-ctl-label">Transparency</span>
          <select value=${transparency} onChange=${(e) => setTransparency(e.target.value)}>
            <option value="">Auto (corner-detect)</option>
            <option value="metadata">Metadata (raw TI)</option>
            <option value="none">None (opaque)</option>
          </select>
        </label>
      </div>
      ${sequences.map((s, i) => html`<${SequenceAccordion} key=${i} path=${path} seq=${s} index=${i} transparency=${transparency} />`)}
    </div>
  `
}
