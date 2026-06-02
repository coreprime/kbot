// tnt.js
//
// TNT map viewers: the full tile map (pan/zoom with feature overlays,
// start-position markers, and a minimap), a greyscale height map, and a
// searchable feature catalogue card grid.

import { htm as html } from '@kbot/ui/htm-bind'
import { useState } from 'preact/hooks'
import { mapViewURL } from '../api.js'
import { PanZoomMap } from './mapview.js'

export function TntMapTab({ path, describe, source }) {
  const d = describe || {}
  const tileW = d.tileW || 1, tileH = d.tileH || 1
  return html`<${PanZoomMap}
    imgUrl=${mapViewURL(path, 'tilemap', source)}
    minimapUrl=${d.hasMinimap ? mapViewURL(path, 'minimap', source) : null}
    pixelW=${tileW * 32} pixelH=${tileH * 32} tileW=${tileW} tileH=${tileH}
    info=${`${tileW}×${tileH} tiles`}
    features=${d.features} placements=${d.placements} startPositions=${d.startPositions} />`
}

export function TntHeightMapTab({ path, describe, source }) {
  const d = describe || {}
  const tileW = d.tileW || 1, tileH = d.tileH || 1
  return html`<${PanZoomMap}
    imgUrl=${mapViewURL(path, 'heightmap', source)}
    minimapUrl=${d.hasMinimap ? mapViewURL(path, 'minimap', source) : null}
    pixelW=${tileW * 2} pixelH=${tileH * 2} info=${`Height map · ${tileW * 2}×${tileH * 2}`} />`
}

export function TntBuildMapTab({ path, describe, source }) {
  const d = describe || {}
  const tileW = d.tileW || 1, tileH = d.tileH || 1
  return html`<${PanZoomMap}
    imgUrl=${mapViewURL(path, 'buildmap', source)}
    minimapUrl=${d.hasMinimap ? mapViewURL(path, 'minimap', source) : null}
    pixelW=${tileW * 32} pixelH=${tileH * 32} tileW=${tileW} tileH=${tileH}
    info=${`Buildability · ${tileW}×${tileH} tiles`} />`
}

export function TntFeaturesTab({ describe }) {
  const features = (describe && describe.features) || []
  const [filter, setFilter] = useState('')
  if (!features.length) return html`<div class="fx-empty">No features in this map.</div>`
  const q = filter.trim().toLowerCase()
  const shown = q
    ? features.filter((f) => f.name.toLowerCase().includes(q) ||
        (f.description || '').toLowerCase().includes(q) || (f.category || '').toLowerCase().includes(q))
    : features
  const total = features.reduce((n, f) => n + (f.count || 0), 0)
  return html`
    <div class="fx-tnt-features">
      <div class="fx-tnt-feat-head">
        <span class="fx-tnt-feat-stats">${features.length} types · ${total} placed</span>
        <input type="text" class="fx-tnt-feat-filter" placeholder="Filter features…" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
      </div>
      <div class="fx-tnt-feat-grid">
        ${shown.map((f) => html`
          <div key=${f.index} class="fx-tnt-feat-card">
            <div class="fx-tnt-feat-preview"><span class="fx-tnt-feat-ico">🏗️</span></div>
            <div class="fx-tnt-feat-info">
              <div class="fx-tnt-feat-name">${f.name}</div>
              ${f.description ? html`<div class="fx-tnt-feat-desc">${f.description}</div>` : null}
              <div class="fx-tnt-feat-meta">
                ${f.category ? html`<span class="fx-tnt-feat-cat">${f.category}</span>` : null}
                ${f.count > 0 ? html`<span class="fx-tnt-feat-count">×${f.count}</span>` : null}
              </div>
            </div>
          </div>`)}
      </div>
    </div>
  `
}
