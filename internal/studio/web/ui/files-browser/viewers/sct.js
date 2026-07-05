// sct.js
//
// SCT section viewers: the rendered tile map (pan/zoom + minimap) and a
// greyscale height map.  SCT sections are the map tiles TA composes maps
// from, so they reuse the same pan/zoom canvas as the TNT viewer.

import { htm as html } from '@coreprime/kbot-ui/htm-bind'
import { mapViewURL } from '../api.js'
import { PanZoomMap } from './mapview.js'

export function SctMapTab({ path, describe, source }) {
  const d = describe || {}
  const tileW = d.width || 1, tileH = d.height || 1
  const pw = d.pixelWidth || tileW * 32, ph = d.pixelHeight || tileH * 32
  return html`<${PanZoomMap}
    imgUrl=${mapViewURL(path, 'tilemap', source)}
    minimapUrl=${d.hasMinimap ? mapViewURL(path, 'minimap', source) : null}
    pixelW=${pw} pixelH=${ph} tileW=${tileW} tileH=${tileH}
    info=${`${tileW}×${tileH} tiles · ${d.numTiles || 0} unique`} />`
}

export function SctHeightMapTab({ path, describe, source }) {
  const d = describe || {}
  if (!d.hasHeightMap) return html`<div class="fx-empty">No height data in this section.</div>`
  const tileW = d.width || 1, tileH = d.height || 1
  return html`<${PanZoomMap}
    imgUrl=${mapViewURL(path, 'heightmap', source)}
    minimapUrl=${d.hasMinimap ? mapViewURL(path, 'minimap', source) : null}
    pixelW=${tileW * 2} pixelH=${tileH * 2} info=${`Height map · ${tileW * 2}×${tileH * 2}`} />`
}
