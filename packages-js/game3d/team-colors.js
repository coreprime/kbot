// team-colors.js
//
// Shared TA team-colour palette.  Indexed by `side` (0..7) so the
// engine + UI + renderer can all refer to a unit's faction by a
// single integer without each layer carrying its own colour table.
//
// Index 0 (`blue`) is the canonical "no recolour" sentinel — the
// renderer's setTeamColor(null) keeps the model's authored ARM-blue
// pixels untouched.  Indices 1..7 each map to a saturated RGB tuple
// in 0..1 floats, matching the in-game TA team palette as closely as
// the renderer's hue-shift can approximate (a true TA team palette
// remap is a more involved per-pixel translation we haven't shipped).
//
// label is the human-readable side name shown in tooltips + the
// side picker; swatchCss is the CSS background-color string a
// picker swatch can use without rounding-trip-conversion.

export const TEAM_SIDES = [
  { side: 0, key: 'blue',   label: 'Blue',   rgb: null,                  swatchCss: '#3a6cd6' },
  { side: 1, key: 'red',    label: 'Red',    rgb: [0.92, 0.18, 0.16],    swatchCss: '#eb2e29' },
  { side: 2, key: 'green',  label: 'Green',  rgb: [0.20, 0.78, 0.28],    swatchCss: '#34c747' },
  { side: 3, key: 'yellow', label: 'Yellow', rgb: [0.95, 0.85, 0.20],    swatchCss: '#f3d933' },
  { side: 4, key: 'purple', label: 'Purple', rgb: [0.62, 0.30, 0.85],    swatchCss: '#9e4dd9' },
  { side: 5, key: 'cyan',   label: 'Cyan',   rgb: [0.20, 0.80, 0.92],    swatchCss: '#34ccea' },
  { side: 6, key: 'orange', label: 'Orange', rgb: [0.98, 0.55, 0.18],    swatchCss: '#fa8d2e' },
  { side: 7, key: 'black',  label: 'Black',  rgb: [0.10, 0.10, 0.12],    swatchCss: '#1a1a1f' },
]

// teamColorForSide returns the [r, g, b] tuple a renderer should use
// for the given side index (0..7).  Returns null for side 0 (the
// "no recolour" sentinel).  Out-of-range indices fall through to
// null too — safer than throwing in a render hot path.
export function teamColorForSide(side) {
  const entry = TEAM_SIDES[(side | 0)]
  return entry ? entry.rgb : null
}

// _ARM_BLUE_RGB — concrete RGB tuple matching the side-0 swatch
// (#3a6cd6) so the impostor / minimap / UI rendering paths that need
// a real colour for the "no recolour" canonical ARM blue have
// something to draw with.  Kept in sync with the side-0 swatchCss
// above by hand.
const _ARM_BLUE_RGB = [0.227, 0.424, 0.839]

// displayRgbForSide returns an ALWAYS-non-null [r, g, b] tuple for
// the side index — useful for surfaces that need to draw the side
// colour as itself rather than as a hue-shift modulator.  Side 0
// (the "no recolour" canonical ARM-blue) returns the resolved
// blue equivalent; sides 1..7 return their saturated team palette;
// out-of-range falls back to ARM blue.  Phase 3 far-tier impostors
// use this so the user can tell teams apart by colour even when
// units collapse to a single coloured dot.
export function displayRgbForSide(side) {
  const entry = TEAM_SIDES[(side | 0)]
  if (entry && entry.rgb) return entry.rgb
  return _ARM_BLUE_RGB
}

// sideForKey looks a side up by string key ('blue', 'red', ...).
// Used by the side picker UI which carries the key on the DOM
// dataset rather than a raw integer.
export function sideForKey(key) {
  const entry = TEAM_SIDES.find((s) => s.key === key)
  return entry ? entry.side : 0
}
