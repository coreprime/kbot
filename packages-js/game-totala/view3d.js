// view3d.js — Total Annihilation's 3D-view configuration.
//
// @kbot/game3d is game-agnostic machinery: it renders whatever models,
// teams, and projectiles it is configured with. The game-flavoured tables it
// needs — team palette, projectile fallback hues, LOD piece-name heuristics —
// live here with the rest of TA's adapter, and the studio injects them at
// boot (see /ui/common/game-view3d.js). TA:K inherits these unchanged; a
// custom game can override any of them.

// The TA team palette, indexed by `side` (0..7) so the engine + UI +
// renderer can all refer to a unit's faction by a single integer.
//
// Index 0 (`blue`) is the canonical "no recolour" sentinel — rgb: null keeps
// the model's authored ARM-blue pixels untouched. Indices 1..7 map to
// saturated RGB tuples in 0..1 floats, matching the in-game TA team palette
// as closely as the renderer's hue-shift can approximate. swatchCss is the
// CSS colour a picker swatch can use without a round-trip conversion.
export const teamSides = [
  { side: 0, key: 'blue',   label: 'Blue',   rgb: null,                  swatchCss: '#3a6cd6' },
  { side: 1, key: 'red',    label: 'Red',    rgb: [0.92, 0.18, 0.16],    swatchCss: '#eb2e29' },
  { side: 2, key: 'green',  label: 'Green',  rgb: [0.20, 0.78, 0.28],    swatchCss: '#34c747' },
  { side: 3, key: 'yellow', label: 'Yellow', rgb: [0.95, 0.85, 0.20],    swatchCss: '#f3d933' },
  { side: 4, key: 'purple', label: 'Purple', rgb: [0.62, 0.30, 0.85],    swatchCss: '#9e4dd9' },
  { side: 5, key: 'cyan',   label: 'Cyan',   rgb: [0.20, 0.80, 0.92],    swatchCss: '#34ccea' },
  { side: 6, key: 'orange', label: 'Orange', rgb: [0.98, 0.55, 0.18],    swatchCss: '#fa8d2e' },
  { side: 7, key: 'black',  label: 'Black',  rgb: [0.10, 0.10, 0.12],    swatchCss: '#1a1a1f' },
]

// Per-kind fallback hues for projectiles whose TDF omits a colour index
// (most non-laser weapons leave `color=` unset). Keys are the game3d
// projectile-kind names; values are 0..2 float RGB (the additive blend and
// bloom rely on >1 channels).
export const projectileFallbackColors = {
  laser:   [0.45, 1.80, 0.45],
  dgun:    [1.10, 0.30, 0.10],
  plasma:  [0.30, 1.00, 1.10],
  shell:   [1.00, 0.55, 0.20],
  missile: [1.00, 0.75, 0.20],
  bullet:  [1.00, 0.85, 0.20],
}

// Piece names matching any of these regexes are cosmetic-only sub-pixel
// detail the renderer's distance-LOD can skip at mid tier. TA modellers
// consistently follow these naming conventions:
//   flare*    muzzle-flash anchors (often hidden until the COB fires)
//   muzzle*   weapon-barrel tips
//   sleeve*   recoil sleeves / cylinder housings
//   exhaust*  engine exhausts (steady particle anchors)
//   smoke*    smoke-emit anchors
//   aim*      aim-query targets (geometry-less in many units)
//   emit*     generic SFX emit points
export const lodHidePatterns = [
  /^.*flare\d*$/i,
  /^.*muzzle\d*$/i,
  /^.*sleeve\d*$/i,
  /^.*exhaust\d*$/i,
  /^.*smoke\d*$/i,
  /^.*aim\d*$/i,
  /^emit\d*$/i,
]

export const view3d = { teamSides, projectileFallbackColors, lodHidePatterns }
