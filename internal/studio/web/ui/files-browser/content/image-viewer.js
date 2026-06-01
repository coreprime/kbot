// image-viewer.js
//
// Renders the visual representation of an image-bearing format and the
// controls that drive its render query:
//   - GAF  : sequence picker (from the describe doc), frame stepper
//            (with a "whole sequence" animated mode), transparency
//            toggle, output format.
//   - TNT/SCT : view picker (minimap / heightmap / tilemap / buildmap /
//            voidmap).
//   - PCX / FNT : output format toggle.
//
// All state lives here; the parent passes the path + the describe doc so
// the controls can be populated without an extra request.

import { htm as html } from '/ui/common/htm-bind.js'
import { useMemo, useState } from 'preact/hooks'

function buildURL(path, params) {
  const q = Object.entries(params)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  return `/api/vfs/${path}${q ? `?${q}` : ''}`
}

// Select is a small labelled <select> used by every control row.
function Select({ label, value, options, onChange }) {
  return html`
    <label class="files-ctl">
      <span class="files-ctl-label">${label}</span>
      <select value=${value} onChange=${(e) => onChange(e.target.value)}>
        ${options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
      </select>
    </label>
  `
}

// --- GAF -------------------------------------------------------------

function GAFViewer({ path, describe }) {
  const sequences = (describe && describe.sequences) || []
  const [seq, setSeq] = useState(0)
  const [frame, setFrame] = useState(-1) // -1 = whole animated sequence
  const [transparent, setTransparent] = useState(true)

  const frames = (sequences[seq] && sequences[seq].frames) || []
  const animated = frame < 0
  const format = animated ? 'apng' : 'png'
  const src = buildURL(path, {
    sequence: seq,
    frame,
    format,
    transparency: transparent ? '' : 'none',
  })

  const seqOptions = sequences.length
    ? sequences.map((s, i) => ({ value: i, label: s.name ? `${i}: ${s.name}` : `Sequence ${i}` }))
    : [{ value: 0, label: 'Sequence 0' }]

  return html`
    <div class="files-viewer">
      <div class="files-ctl-row">
        <${Select} label="Sequence" value=${seq}
          options=${seqOptions}
          onChange=${(v) => { setSeq(Number(v)); setFrame(-1) }} />
        <${Select} label="Frame" value=${frame}
          options=${[{ value: -1, label: 'All (animate)' }, ...frames.map((_, i) => ({ value: i, label: `${i}` }))]}
          onChange=${(v) => setFrame(Number(v))} />
        <label class="files-ctl files-ctl-check">
          <input type="checkbox" checked=${transparent} onChange=${(e) => setTransparent(e.target.checked)} />
          <span>Transparent</span>
        </label>
      </div>
      <div class="files-image-wrap"><img class="files-image" src=${src} alt=${path} /></div>
    </div>
  `
}

// --- TNT / SCT -------------------------------------------------------

const MAP_VIEWS = [
  { value: 'minimap', label: 'Minimap' },
  { value: 'tilemap', label: 'Tilemap' },
  { value: 'heightmap', label: 'Heightmap' },
  { value: 'buildmap', label: 'Buildmap' },
  { value: 'voidmap', label: 'Voidmap' },
]

function MapViewer({ path }) {
  const [view, setView] = useState('minimap')
  const src = buildURL(path, { view })
  return html`
    <div class="files-viewer">
      <div class="files-ctl-row">
        <${Select} label="View" value=${view} options=${MAP_VIEWS} onChange=${setView} />
      </div>
      <div class="files-image-wrap"><img class="files-image" src=${src} alt=${path} /></div>
    </div>
  `
}

// --- PCX / FNT (simple format toggle) --------------------------------

function SimpleImageViewer({ path, formats }) {
  const [format, setFormat] = useState(formats[0].value)
  const src = buildURL(path, { format })
  return html`
    <div class="files-viewer">
      <div class="files-ctl-row">
        <${Select} label="Format" value=${format} options=${formats} onChange=${setFormat} />
      </div>
      <div class="files-image-wrap"><img class="files-image" src=${src} alt=${path} /></div>
    </div>
  `
}

// ImageViewer dispatches on the file's extension to the right control
// set.  `describe` is the metadata doc's describe child (used by GAF).
export function ImageViewer({ path, ext, describe }) {
  const kind = useMemo(() => {
    if (ext === 'gaf') return 'gaf'
    if (ext === 'tnt' || ext === 'sct') return 'map'
    if (ext === 'fnt') return 'fnt'
    return 'pcx'
  }, [ext])

  if (kind === 'gaf') return html`<${GAFViewer} path=${path} describe=${describe} />`
  if (kind === 'map') return html`<${MapViewer} path=${path} />`
  if (kind === 'fnt') {
    return html`<${SimpleImageViewer} path=${path}
      formats=${[{ value: 'png', label: 'PNG' }, { value: 'gif', label: 'GIF' }]} />`
  }
  return html`<${SimpleImageViewer} path=${path}
    formats=${[{ value: 'png', label: 'PNG' }, { value: 'gif', label: 'GIF' }, { value: 'bmp', label: 'BMP' }]} />`
}
