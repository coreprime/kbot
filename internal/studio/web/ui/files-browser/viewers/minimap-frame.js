// minimap-frame.js
//
// Maps between a TNT map render and its embedded minimap.  The game draws
// the map into the minimap's top-left corner only: a region whose longer
// side is 252 pixels, showing the visible map (32 pixels narrower and 128
// shorter than the tiles, edges the game never shows); the rest of the
// minimap is padding.  The explorer's describe reports that region as
// `minimapFrame` ({ contentW, contentH, visibleW, visibleH }, pixels), and
// these helpers turn it into fractions so the minimap's viewport box and
// click-to-pan line up with the map whatever the render's scale.

// frameFromDescribe returns the region as fractions: fx/fy of the minimap
// the map region covers and vx/vy of the full map it shows.  Without one
// the whole minimap shows the whole map.
export function frameFromDescribe(d) {
  const f = d && d.minimapFrame
  const mmW = d && d.minimapW
  const mmH = d && d.minimapH
  const fullW = d && d.pixelW
  const fullH = d && d.pixelH
  if (!f || !mmW || !mmH || !fullW || !fullH || !f.contentW || !f.contentH || !f.visibleW || !f.visibleH) {
    return { fx: 1, fy: 1, vx: 1, vy: 1 }
  }
  return {
    fx: f.contentW / mmW,
    fy: f.contentH / mmH,
    vx: Math.min(1, f.visibleW / fullW),
    vy: Math.min(1, f.visibleH / fullH),
  }
}

// mapToMinimap converts a point given as fractions of the full map to
// fractions of the minimap image.
export function mapToMinimap(u, v, frame) {
  return { x: (u / frame.vx) * frame.fx, y: (v / frame.vy) * frame.fy }
}

// minimapToMap converts a point given as fractions of the minimap image to
// fractions of the full map.
export function minimapToMap(x, y, frame) {
  return { u: (x / frame.fx) * frame.vx, v: (y / frame.fy) * frame.vy }
}
