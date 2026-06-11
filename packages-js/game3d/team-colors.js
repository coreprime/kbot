// team-colors.js
//
// Team-colour mechanism, indexed by `side` so the engine + UI + renderer can
// all refer to a unit's faction by a single integer without each layer
// carrying its own colour table.
//
// The table itself is game configuration, not machinery — the active game's
// adapter package supplies it (see @kbot/game-totala's view3d.js) and the
// studio injects it through setTeamSides() at boot. Each entry is
// { side, key, label, rgb, swatchCss }:
//   - side 0 with rgb: null is the "no recolour" sentinel — the renderer's
//     setTeamColor(null) keeps the model's authored pixels untouched.
//   - rgb is a saturated 0..1 float tuple driving the renderer's hue-shift.
//   - label / swatchCss feed tooltips and picker swatches directly.

// TEAM_SIDES is the live table. Exported as a const binding whose CONTENTS
// setTeamSides() replaces in place, so existing imports always see the
// current configuration.
export const TEAM_SIDES = []

// setTeamSides installs the game's team palette. Mutates the exported array
// in place so every module holding a reference picks the new table up.
export function setTeamSides(sides) {
  TEAM_SIDES.length = 0
  if (Array.isArray(sides)) TEAM_SIDES.push(...sides)
}

// teamColorForSide returns the [r, g, b] tuple a renderer should use
// for the given side index.  Returns null for side 0 (the "no recolour"
// sentinel).  Out-of-range indices fall through to null too — safer than
// throwing in a render hot path.
export function teamColorForSide(side) {
  const entry = TEAM_SIDES[(side | 0)]
  return entry ? entry.rgb : null
}

// _NEUTRAL_RGB — fallback for the side-0 "no recolour" sentinel and
// out-of-range indices, so impostor / minimap / UI paths that need a real
// colour always get one. Matches TA's canonical ARM-blue swatch (#3a6cd6),
// which is also the right neutral for games that inherit TA's table.
const _NEUTRAL_RGB = [0.227, 0.424, 0.839]

// displayRgbForSide returns an ALWAYS-non-null [r, g, b] tuple for
// the side index — useful for surfaces that need to draw the side
// colour as itself rather than as a hue-shift modulator.  Side 0
// (the "no recolour" sentinel) returns the neutral fallback; other sides
// return their saturated team palette.  Phase 3 far-tier impostors
// use this so the user can tell teams apart by colour even when
// units collapse to a single coloured dot.
export function displayRgbForSide(side) {
  const entry = TEAM_SIDES[(side | 0)]
  if (entry && entry.rgb) return entry.rgb
  return _NEUTRAL_RGB
}

// sideForKey looks a side up by string key ('blue', 'red', ...).
// Used by the side picker UI which carries the key on the DOM
// dataset rather than a raw integer.
export function sideForKey(key) {
  const entry = TEAM_SIDES.find((s) => s.key === key)
  return entry ? entry.side : 0
}
