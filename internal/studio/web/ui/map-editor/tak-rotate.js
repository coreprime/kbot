// tak-rotate.js
//
// Rotation for TA:Kingdoms section placements — by substitution, not
// transform. The 0x4000 format stores terrain as (texture, U, V) with no
// orientation bits, so a section's pixels cannot rotate; but the retail
// section library ships directional VARIANTS following a consistent naming
// convention (Veruna's coast cliffs: e01/n01/s01/w01 edges, ne01/se01
// outer corners, n_e01/s_w01 inner corners). Pressing Q/E swaps the
// placement to the sibling section whose name encodes the rotated
// orientation, which is what the original Cavedog tooling expected mappers
// to do by hand.

// Directional cycles, clockwise. Inner corners are named with the
// north/south edge first (n_e, s_w — never e_n), so their rotation cycle
// normalizes back into that spelling.
const EDGE_CW = ['n', 'e', 's', 'w']
const OUTER_CW = ['ne', 'se', 'sw', 'nw']
const INNER_CW = ['n_e', 's_e', 's_w', 'n_w']

// Longest tokens first so "n_e01" parses as inner-corner + "01", not "n" +
// "_e01", and "ne01" as outer-corner rather than "n" + "e01".
const TOKEN_RE = /^(n_e|n_w|s_e|s_w|ne|nw|se|sw|n|e|s|w)(.+)$/

function rotateToken(token, dir) {
  for (const cycle of [EDGE_CW, OUTER_CW, INNER_CW]) {
    const i = cycle.indexOf(token)
    if (i >= 0) return cycle[(i + dir + cycle.length) % cycle.length]
  }
  return null
}

// rotatedTakSectionName maps a directional section name one 90° step
// (dir: +1 = clockwise, -1 = counter-clockwise), or null when the name
// doesn't follow the directional convention.
export function rotatedTakSectionName(name, dir) {
  const m = TOKEN_RE.exec(String(name || '').toLowerCase())
  if (!m) return null
  const rotated = rotateToken(m[1], dir)
  return rotated ? rotated + m[2] : null
}

// findRotatedTakSection resolves the rotated variant of a placed section
// within the catalogue: same world + group, rotated directional name.
// Returns the catalogue entry or null (non-directional names, missing
// variants).
export function findRotatedTakSection(sectionsList, currentPath, dir) {
  if (!Array.isArray(sectionsList)) return null
  const cur = sectionsList.find((s) => s.path === currentPath)
  if (!cur) return null
  const want = rotatedTakSectionName(cur.name, dir)
  if (!want) return null
  return sectionsList.find((s) =>
    s.world === cur.world && s.group === cur.group &&
    String(s.name).toLowerCase() === want) || null
}
